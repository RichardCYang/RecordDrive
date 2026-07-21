import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { applyRuntimeConfidentialityPolicy, loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { startNetworkServers } from './network-server.js';
import { createDefaultTlsSettings, loadTlsSettings } from './tls-settings.js';
import { SQLiteSessionStore } from './session-store.js';
import { csrfTokenMiddleware, verifyCsrf } from './middleware/csrf.js';
import {
  blockDisabledAdministratorSession,
  renderAdministratorAccessDisabled
} from './middleware/auth.js';
import { purgeAdministratorSessions } from './admin-access.js';
import { createAuthRouter } from './routes/auth.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createAdminRouter } from './routes/admin.js';
import { createRepositoriesRouter } from './routes/repositories.js';
import { fileKind, filePreviewKind, formatBytes, formatDate, requestWantsJson } from './utils.js';
import { languageMiddleware } from './i18n.js';
import { createSettingsRouter } from './routes/settings.js';
import {
  UploadCsrfError,
  UploadQuotaError,
  uploadQuotaErrorMessage
} from './upload-storage.js';
import { normalizeAndValidateStorageConfiguration } from './storage-path-security.js';
import { applyStoredRepositoryStorageRoot } from './storage-settings.js';
import { ensureSecureUploadRoot } from './file-access-time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export function createApplication(options = {}) {
  const config = normalizeAndValidateStorageConfiguration(options.config || loadConfig(options.env));
  applyRuntimeConfidentialityPolicy(config, createDefaultTlsSettings(config));
  const db = options.db || createDatabase(config);
  applyStoredRepositoryStorageRoot(db, config);
  ensureSecureUploadRoot(config);
  if (config.adminAccessDisabled) purgeAdministratorSessions(db);
  const runtimeControl = options.runtimeControl || {};
  const networkSettings = loadTlsSettings(db, config);
  applyRuntimeConfidentialityPolicy(config, networkSettings);
  const sessionIdleMs = (Number(config.sessionIdleHours) || 12) * 60 * 60 * 1000;
  const sessionAbsoluteMs = (Number(config.sessionAbsoluteHours) || 168) * 60 * 60 * 1000;
  const app = express();

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));
  app.set('json escape', true);
  if (config.trustProxy !== undefined && config.trustProxy !== false) {
    app.set('trust proxy', config.trustProxy);
  }

  Object.defineProperty(app, 'recorddrive', {
    value: Object.freeze({ db, config, runtimeControl, networkSettings }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  app.locals.administratorAccessDisabled = Boolean(config.adminAccessDisabled);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", 'data:']
      }
    }
  }));
  app.use((req, res, next) => {
    if (!config.requireHttps || req.secure) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(426).type('text/plain').send('HTTPS is required for this listener.');
  });
  app.use(express.static(path.join(projectRoot, 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true
  }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(languageMiddleware);

  app.use(session({
    name: 'recorddrive.sid',
    secret: config.sessionSecret,
    store: new SQLiteSessionStore(db, { defaultTtlMs: sessionIdleMs }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.requireHttps ? true : 'auto',
      priority: 'high',
      maxAge: sessionIdleMs
    }
  }));

  app.use((req, res, next) => {
    const hasAuthenticatedState = Boolean(
      req.session?.userId
      || req.session?.pendingMfa?.userId
      || req.session?.authenticationFlow?.userId
    );
    if (!hasAuthenticatedState) return next();

    const fallbackCreatedAt = Number(
      req.session.sessionCreatedAt
      || req.session.authenticatedAt
      || req.session.pendingMfa?.createdAt
      || req.session.authenticationFlow?.createdAt
      || Date.now()
    );
    if (!Number.isFinite(Number(req.session.sessionCreatedAt))) {
      req.session.sessionCreatedAt = fallbackCreatedAt;
    }
    if (Date.now() - fallbackCreatedAt <= sessionAbsoluteMs) return next();

    return req.session.regenerate((error) => {
      if (error) return next(error);
      res.clearCookie('recorddrive.sid', {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.requireHttps,
        priority: 'high'
      });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (requestWantsJson(req) || req.path.includes('/passkeys/')) {
          return res.status(401).json({ error: req.t('Your session has expired. Sign in again.') });
        }
        return res.redirect('/login');
      }
      return next();
    });
  });

  app.use((req, res, next) => {
    const userId = Number(req.session?.userId);
    req.currentUser = Number.isInteger(userId)
      ? db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(userId)
      : null;

    if (userId && !req.currentUser && req.session) delete req.session.userId;
    res.locals.currentUser = req.currentUser;
    if (req.currentUser) res.set('Cache-Control', 'private, no-store');
    res.locals.flash = req.session?.flash || null;
    if (req.session) delete req.session.flash;
    res.locals.formatBytes = formatBytes;
    res.locals.formatDate = (value) => formatDate(value, req.language);
    res.locals.fileKind = fileKind;
    res.locals.filePreviewKind = filePreviewKind;
    res.locals.currentPath = req.path;
    res.locals.activeAdminTab = null;
    next();
  });

  app.use(blockDisabledAdministratorSession);
  app.use(csrfTokenMiddleware);
  app.use(verifyCsrf);

  app.get('/health', (req, res) => {
    const databaseOk = db.prepare('SELECT 1 AS ok').get().ok === 1;
    res.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? 'ok' : 'error',
      service: 'RecordDrive',
      transport: req.secure ? 'https' : 'http'
    });
  });

  app.use(createAuthRouter(db, config));
  app.use(createSettingsRouter(db, config));
  app.use(createDashboardRouter(db, config));
  if (config.adminAccessDisabled) {
    app.use('/admin', (req, res) => renderAdministratorAccessDisabled(req, res, 404));
  } else {
    app.use('/admin', createAdminRouter(db, { config, runtimeControl }));
  }
  app.use('/repositories', createRepositoriesRouter(db, config));

  app.use((req, res) => {
    res.status(404).render('error', {
      title: req.t('Page not found'),
      statusCode: 404,
      message: req.t('The requested page does not exist or has been moved.')
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof UploadCsrfError) {
      const message = req.t('The security token is invalid or has expired. Refresh the page and try again.');
      if (requestWantsJson(req)) return res.status(403).json({ error: message });
      return res.status(403).render('error', {
        title: req.t('Request could not be verified'),
        statusCode: 403,
        message
      });
    }

    if (error instanceof UploadQuotaError) {
      const message = uploadQuotaErrorMessage(req, error, req.uploadQuotaSettings || config);
      if (requestWantsJson(req)) return res.status(413).json({ error: message });
      return res.status(413).render('error', {
        title: req.t('Upload failed'),
        statusCode: 413,
        message
      });
    }

    if (error instanceof multer.MulterError) {
      let message = req.t('An error occurred while uploading the file.');
      if (error.code === 'LIMIT_FILE_SIZE') {
        const size = req.uploadQuotaSettings?.maxFileSizeMb ?? config.maxFileSizeMb;
        message = req.t('Each file can be up to {{size}} MB.', { size });
      } else if (error.code === 'LIMIT_FILE_COUNT') {
        const count = req.uploadQuotaSettings?.maxFilesPerUpload ?? config.maxFilesPerUpload;
        message = req.t('You can upload up to {{count}} files at a time.', { count });
      }
      const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      if (requestWantsJson(req)) return res.status(statusCode).json({ error: message });
      return res.status(statusCode).render('error', {
        title: req.t('Upload failed'),
        statusCode,
        message
      });
    }

    console.error(error);
    const message = config.isProduction
      ? req.t('An error occurred while processing the request.')
      : error.message;
    if (requestWantsJson(req) || req.path.includes('/passkeys/')) {
      return res.status(500).json({ error: message });
    }
    return res.status(500).render('error', {
      title: req.t('Server error'),
      statusCode: 500,
      message
    });
  });

  return app;
}

function resolvesToCurrentModule(candidatePath) {
  if (!candidatePath) return false;
  const currentPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(candidatePath) === fs.realpathSync(currentPath);
  } catch {
    return path.resolve(candidatePath) === path.resolve(currentPath);
  }
}

const isServiceEntryPoint = import.meta.main === true
  || resolvesToCurrentModule(process.argv[1])
  || resolvesToCurrentModule(process.env.pm_exec_path);

if (isServiceEntryPoint) {
  const app = createApplication();
  startNetworkServers(app).catch((error) => {
    console.error('RecordDrive failed to start:', error);
    process.exit(1);
  });
}
