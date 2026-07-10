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
import { createAuthRouter } from './routes/auth.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createAdminRouter } from './routes/admin.js';
import { createRepositoriesRouter } from './routes/repositories.js';
import { fileKind, formatBytes, formatDate } from './utils.js';
import { languageMiddleware } from './i18n.js';
import { createSettingsRouter } from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export function createApplication(options = {}) {
  const config = options.config || loadConfig(options.env);
  const db = options.db || createDatabase(config);
  const runtimeControl = options.runtimeControl || {};
  const networkSettings = loadTlsSettings(db, config);
  const app = express();

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(projectRoot, 'views'));
  if (config.isProduction) app.set('trust proxy', 1);

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
    store: new SQLiteSessionStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: 'auto',
      maxAge: 1000 * 60 * 60 * 12
    }
  }));

  app.use((req, res, next) => {
    const userId = Number(req.session.userId);
    req.currentUser = Number.isInteger(userId)
      ? db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(userId)
      : null;

    if (userId && !req.currentUser) delete req.session.userId;
    res.locals.currentUser = req.currentUser;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.formatBytes = formatBytes;
    res.locals.formatDate = (value) => formatDate(value, req.language);
    res.locals.fileKind = fileKind;
    res.locals.currentPath = req.path;
    res.locals.activeAdminTab = null;
    next();
  });

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
  app.use(createDashboardRouter(db));
  app.use('/admin', createAdminRouter(db, { config, runtimeControl }));
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

    if (error instanceof multer.MulterError) {
      let message = req.t('An error occurred while uploading the file.');
      if (error.code === 'LIMIT_FILE_SIZE') {
        message = req.t('Each file can be up to {{size}} MB.', { size: config.maxFileSizeMb });
      } else if (error.code === 'LIMIT_FILE_COUNT') {
        message = req.t('You can upload up to {{count}} files at a time.', { count: config.maxFilesPerUpload });
      }
      return res.status(400).render('error', {
        title: req.t('Upload failed'),
        statusCode: 400,
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
