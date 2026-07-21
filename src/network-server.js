import http from 'node:http';
import https from 'node:https';
import {
  buildTlsOptions,
  certificateFileSignature,
  loadTlsSettings,
  validateTlsSettings
} from './tls-settings.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_HEADERS_TIMEOUT_MS = 60 * 1000;

function normalizedTimeout(value, fallback, { allowZero = true } = {}) {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout)) return fallback;
  if (allowZero ? timeout < 0 : timeout <= 0) return fallback;
  return timeout;
}

export function createHttpServerOptions(config, extraOptions = {}) {
  const requestTimeout = normalizedTimeout(
    config?.httpRequestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  const configuredHeadersTimeout = normalizedTimeout(
    config?.httpHeadersTimeoutMs,
    DEFAULT_HEADERS_TIMEOUT_MS,
    { allowZero: false }
  );
  const headersTimeout = requestTimeout > 0
    ? Math.min(configuredHeadersTimeout, requestTimeout)
    : configuredHeadersTimeout;

  return {
    ...extraOptions,
    requestTimeout,
    headersTimeout
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function closeServers(servers) {
  await Promise.all(servers.map((server) => new Promise((resolve) => {
    server.close(() => resolve());
  })));
}

function displayHost(host) {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function httpsAuthority(settings) {
  const hostname = settings.publicHostname.includes(':') && !settings.publicHostname.startsWith('[')
    ? `[${settings.publicHostname}]`
    : settings.publicHostname;
  return settings.httpsPort === 443 ? hostname : `${hostname}:${settings.httpsPort}`;
}

function createRedirectHandler(settings) {
  const authority = httpsAuthority(settings);
  return (req, res) => {
    let requestPath = '/';
    try {
      const parsed = new URL(req.url?.startsWith('/') ? req.url : '/', 'http://localhost');
      requestPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      requestPath = '/';
    }
    res.writeHead(308, {
      Location: `https://${authority}${requestPath}`,
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end('Redirecting to HTTPS.');
  };
}

export async function startNetworkServers(app) {
  const { db, config, runtimeControl } = app.recorddrive;
  const settings = loadTlsSettings(db, config);
  const validation = validateTlsSettings(settings, {
    checkCertificateFiles: settings.httpsEnabled
  });
  if (!validation.valid) {
    throw new Error(`Network configuration is invalid: ${validation.errors.join(' ')}`);
  }

  const servers = [];
  let httpServer = null;
  let httpsServer = null;
  let reloadTimer = null;
  let certificateSignature = '';

  try {
    if (settings.httpsEnabled) {
      httpsServer = https.createServer(
        createHttpServerOptions(config, buildTlsOptions(settings)),
        app
      );
      await listen(httpsServer, settings.httpsPort, settings.httpsHost);
      servers.push(httpsServer);
      certificateSignature = certificateFileSignature(settings);
      console.log(`RecordDrive HTTPS server is listening on https://${displayHost(settings.httpsHost)}:${settings.httpsPort}.`);

      httpServer = http.createServer(
        createHttpServerOptions(config),
        settings.redirectHttpToHttps ? createRedirectHandler(settings) : app
      );
      await listen(httpServer, settings.httpPort, settings.httpHost);
      servers.push(httpServer);
      if (settings.redirectHttpToHttps) {
        console.log(`RecordDrive HTTP redirect server is listening on http://${displayHost(settings.httpHost)}:${settings.httpPort}.`);
      } else {
        console.log(`RecordDrive HTTP server is listening on http://${displayHost(settings.httpHost)}:${settings.httpPort}.`);
      }
    } else {
      httpServer = http.createServer(createHttpServerOptions(config), app);
      await listen(httpServer, settings.httpPort, settings.httpHost);
      servers.push(httpServer);
      console.log(`RecordDrive HTTP server is listening on http://${displayHost(settings.httpHost)}:${settings.httpPort}.`);
    }
  } catch (error) {
    await closeServers(servers);
    throw error;
  }

  const reloadTlsCertificate = async () => {
    if (!httpsServer || !settings.httpsEnabled) {
      throw new Error('The HTTPS server is not active.');
    }
    const current = loadTlsSettings(db, config);
    if (!current.httpsEnabled) {
      throw new Error('The saved settings currently disable HTTPS.');
    }
    const currentValidation = validateTlsSettings(current);
    if (!currentValidation.valid) {
      throw new Error(currentValidation.errors.join(' '));
    }
    if (
      current.certificateMode !== settings.certificateMode
      || current.httpsPort !== settings.httpsPort
      || current.httpsHost !== settings.httpsHost
    ) {
      throw new Error('Listener or certificate mode changes require a RecordDrive restart.');
    }
    httpsServer.setSecureContext(buildTlsOptions(current));
    certificateSignature = certificateFileSignature(current);
    console.log('RecordDrive reloaded the TLS certificate without interrupting existing connections.');
  };

  if (settings.httpsEnabled && settings.autoReloadCertificate) {
    reloadTimer = setInterval(async () => {
      try {
        const current = loadTlsSettings(db, config);
        if (!current.httpsEnabled || !current.autoReloadCertificate || current.certificateMode !== settings.certificateMode) return;
        const nextSignature = certificateFileSignature(current);
        if (nextSignature !== certificateSignature) await reloadTlsCertificate();
      } catch (error) {
        console.error(`Automatic TLS certificate reload failed: ${error.message}`);
      }
    }, settings.reloadIntervalMinutes * 60 * 1000);
    reloadTimer.unref();
  }

  runtimeControl.reloadTlsCertificate = reloadTlsCertificate;
  runtimeControl.getNetworkState = () => {
    const applicationServer = httpsServer || httpServer;
    return {
      httpsEnabled: settings.httpsEnabled,
      redirectHttpToHttps: settings.redirectHttpToHttps,
      httpHost: settings.httpHost,
      httpPort: settings.httpPort,
      httpsHost: settings.httpsHost,
      httpsPort: settings.httpsPort,
      certificateMode: settings.certificateMode,
      autoReloadCertificate: settings.autoReloadCertificate,
      reloadIntervalMinutes: settings.reloadIntervalMinutes,
      requestTimeoutMs: applicationServer?.requestTimeout,
      headersTimeoutMs: applicationServer?.headersTimeout
    };
  };
  runtimeControl.close = async () => {
    if (reloadTimer) clearInterval(reloadTimer);
    await closeServers(servers);
  };

  return runtimeControl;
}
