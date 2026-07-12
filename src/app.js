import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { startNetworkServers } from './network-server.js';
import { loadTlsSettings } from './tls-settings.js';
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
import { fileKind, filePreviewKind, formatBytes, formatDate } from './utils.js';
import { languageMiddleware } from './i18n.js';
import { createSettingsRouter } from './routes/settings.js';
import { UploadCsrfError, UploadQuotaError } from './upload-storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function isSameOrDescendant(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateStorageConfiguration(config) {
  const uploadRoot = path.resolve(config.uploadRoot);
  const databasePath = path.resolve(config.dbPath);
  const databaseDirectory = path.dirname(databasePath);
  const filesystemRoot = path.parse(uploadRoot).root;
  const protectedDirectories = [
    path.join(projectRoot, '.git'),
    path.join(projectRoot, 'public'),
    path.join(projectRoot, 'src'),
    path.join(projectRoot, 'views')
  ];

  if (uploadRoot === filesystemRoot || isSameOrDescendant(uploadRoot, projectRoot)) {
    throw new Error('UPLOAD_ROOT cannot be a filesystem root, the project root, or a parent of the project.');
  }
  if (databaseDirectory === path.parse(databaseDirectory).root
    || isSameOrDescendant(databaseDirectory, projectRoot)) {
    throw new Error('DB_PATH cannot use a filesystem root, the project root, or a parent of the project as its directory.');
  }
  for (const protectedDirectory of protectedDirectories) {
    if (isSameOrDescendant(protectedDirectory, uploadRoot)) {
      throw new Error('UPLOAD_ROOT cannot be inside a source, static, view, or Git metadata directory.');
    }
    if (isSameOrDescendant(protectedDirectory, databasePath)) {
      throw new Error('DB_PATH cannot be inside a source, static, view, or Git metadata directory.');
    }
  }
}

export function createApplication(options = {}) {
  const config = options.config || loadConfig(options.env);
  validateStorageConfiguration(config);
  const db = options.db || createDatabase(config);
  if (config.adminAccessDisabled) purgeAdministratorSessions(db);
  const runtimeControl = options.runtimeControl || {};
  const networkSettings = loadTlsSettings(db, config);
  const sessionIdleMs = (Number(config.sessionIdleHours) || 12) * 60 * 60 * 1000;
  const sessionAbsoluteMs = (Number(config.sessionAbsoluteHours) || 168) * 60 * 60 * 1000;
  const app = express();

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));
  if (config.trustProxy !== undefined && config.trustProxy !== false) {
    app.set('trust proxy', config.trustProxy);
  }

  app.locals.db = db;
  app.locals.config = config;
  app.locals.runtimeControl = runtimeControl;
  app.locals.networkSettings = networkSettings;

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
      secure: config.isProduction ? true : 'auto',
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
        secure: config.isProduction,
        priority: 'high'
      });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (req.is('application/json') || req.path.includes('/passkeys/')) {
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
      return res.status(403).render('error', {
        title: req.t('Request could not be verified'),
        statusCode: 403,
        message: req.t('The security token is invalid or has expired. Refresh the page and try again.')
      });
    }

    if (error instanceof UploadQuotaError) {
      return res.status(413).render('error', {
        title: req.t('Upload failed'),
        statusCode: 413,
        message: req.t(error.message)
      });
    }

    if (error instanceof multer.MulterError) {
      let message = req.t('An error occurred while uploading the file.');
      if (error.code === 'LIMIT_FILE_SIZE') {
        message = req.t('Each file can be up to {{size}} MB.', { size: config.maxFileSizeMb });
      } else if (error.code === 'LIMIT_FILE_COUNT') {
        message = req.t('You can upload up to {{count}} files at a time.', { count: config.maxFilesPerUpload });
      }
      const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
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
    if (req.is('application/json') || req.path.includes('/passkeys/')) {
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = createApplication();
  startNetworkServers(app).catch((error) => {
    console.error(`RecordDrive failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
