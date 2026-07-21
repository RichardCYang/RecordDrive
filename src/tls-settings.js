import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { decryptProtectedValue, encryptProtectedValue } from './secret-protection.js';

const SETTINGS_KEY = 'network.tls';
const CERTIFICATE_MODES = new Set(['pem', 'pfx']);

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function integerValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanString(value, maxLength = 4096) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function expandEnvironmentVariables(value) {
  return value
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => process.env[name] ?? match)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => process.env[name] ?? match)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => process.env[name] ?? match);
}

function resolveConfiguredPath(value, baseDirectory = '') {
  const expanded = expandEnvironmentVariables(cleanString(value));
  if (!expanded) return '';
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDirectory || process.cwd(), expanded);
}

function normalizeHostname(value) {
  const hostname = cleanString(value, 255);
  if (!hostname) return '';
  if (hostname.includes('://') || /[/?#@]/.test(hostname)) return hostname;
  if (hostname.includes(':') && !(hostname.startsWith('[') && hostname.endsWith(']'))) return hostname;
  try {
    const parsed = new URL(`https://${hostname}`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return hostname;
    }
    return parsed.hostname;
  } catch {
    return hostname;
  }
}

export function createDefaultTlsSettings(config = {}) {
  const defaultBindHost = config.isProduction ? '0.0.0.0' : '127.0.0.1';
  return {
    httpsEnabled: booleanValue(config.httpsEnabled, false),
    redirectHttpToHttps: booleanValue(config.redirectHttpToHttps, true),
    httpHost: cleanString(config.httpHost || defaultBindHost, 255),
    httpPort: integerValue(config.httpPort ?? config.port, 3000),
    httpsHost: cleanString(config.httpsHost || defaultBindHost, 255),
    httpsPort: integerValue(config.httpsPort, 3443),
    publicHostname: normalizeHostname(config.publicHostname || ''),
    certificateMode: CERTIFICATE_MODES.has(config.certificateMode) ? config.certificateMode : 'pem',
    certificateDirectory: cleanString(config.certificateDirectory),
    certificatePath: cleanString(config.certificatePath),
    privateKeyPath: cleanString(config.privateKeyPath),
    pfxPath: cleanString(config.pfxPath),
    passphrase: String(config.passphrase || ''),
    autoReloadCertificate: booleanValue(config.autoReloadCertificate, true),
    reloadIntervalMinutes: integerValue(config.reloadIntervalMinutes, 5)
  };
}

export function normalizeTlsSettings(value = {}, config = {}) {
  const defaults = createDefaultTlsSettings(config);
  const selected = (key) => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : defaults[key];
  const certificateMode = cleanString(selected('certificateMode'), 16).toLowerCase();
  return {
    httpsEnabled: booleanValue(selected('httpsEnabled'), defaults.httpsEnabled),
    redirectHttpToHttps: booleanValue(selected('redirectHttpToHttps'), defaults.redirectHttpToHttps),
    httpHost: cleanString(selected('httpHost'), 255),
    httpPort: integerValue(selected('httpPort'), defaults.httpPort),
    httpsHost: cleanString(selected('httpsHost'), 255),
    httpsPort: integerValue(selected('httpsPort'), defaults.httpsPort),
    publicHostname: normalizeHostname(selected('publicHostname')),
    certificateMode: CERTIFICATE_MODES.has(certificateMode) ? certificateMode : 'pem',
    certificateDirectory: cleanString(selected('certificateDirectory')),
    certificatePath: cleanString(selected('certificatePath')),
    privateKeyPath: cleanString(selected('privateKeyPath')),
    pfxPath: cleanString(selected('pfxPath')),
    passphrase: String(selected('passphrase') ?? ''),
    autoReloadCertificate: booleanValue(selected('autoReloadCertificate'), defaults.autoReloadCertificate),
    reloadIntervalMinutes: integerValue(selected('reloadIntervalMinutes'), defaults.reloadIntervalMinutes)
  };
}

export function loadTlsSettings(db, config = {}) {
  const row = db.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(SETTINGS_KEY);
  if (!row) return createDefaultTlsSettings(config);
  try {
    const stored = JSON.parse(row.setting_value);
    if (stored.passphraseEncrypted) {
      stored.passphrase = decryptProtectedValue(
        stored.passphraseEncrypted,
        config,
        'tls-passphrase'
      );
    }
    delete stored.passphraseEncrypted;
    return normalizeTlsSettings(stored, config);
  } catch (error) {
    throw new Error('Stored TLS settings could not be parsed or decrypted.', { cause: error });
  }
}

export function saveTlsSettings(db, settings, config = {}) {
  const normalized = normalizeTlsSettings(settings, config);
  const passphrase = normalized.passphrase;
  const stored = { ...normalized };
  delete stored.passphrase;
  if (passphrase) {
    stored.passphraseEncrypted = encryptProtectedValue(passphrase, config, 'tls-passphrase');
  }
  const value = JSON.stringify(stored);
  db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `).run(SETTINGS_KEY, value);
}

export function tlsSettingsFromForm(body, currentSettings, config = {}) {
  const current = normalizeTlsSettings(currentSettings, config);
  const submittedPassphrase = String(body.passphrase || '');
  const clearPassphrase = booleanValue(body.clearPassphrase, false);
  return normalizeTlsSettings({
    httpsEnabled: booleanValue(body.httpsEnabled, false),
    redirectHttpToHttps: booleanValue(body.redirectHttpToHttps, false),
    httpHost: body.httpHost,
    httpPort: body.httpPort,
    httpsHost: body.httpsHost,
    httpsPort: body.httpsPort,
    publicHostname: body.publicHostname,
    certificateMode: body.certificateMode,
    certificateDirectory: body.certificateDirectory,
    certificatePath: body.certificatePath,
    privateKeyPath: body.privateKeyPath,
    pfxPath: body.pfxPath,
    passphrase: clearPassphrase ? '' : (submittedPassphrase || current.passphrase),
    autoReloadCertificate: booleanValue(body.autoReloadCertificate, false),
    reloadIntervalMinutes: body.reloadIntervalMinutes
  }, config);
}

export function resolveTlsPaths(settings) {
  const certificateDirectory = resolveConfiguredPath(settings.certificateDirectory);
  const resolveCertificateFile = (configuredPath, defaultName) => {
    if (configuredPath) return resolveConfiguredPath(configuredPath, certificateDirectory || process.cwd());
    return certificateDirectory ? path.join(certificateDirectory, defaultName) : '';
  };
  return {
    certificateDirectory,
    certificatePath: settings.certificateMode === 'pem'
      ? resolveCertificateFile(settings.certificatePath, 'fullchain.cer')
      : '',
    privateKeyPath: settings.certificateMode === 'pem'
      ? resolveCertificateFile(settings.privateKeyPath, 'cert.key')
      : '',
    pfxPath: settings.certificateMode === 'pfx'
      ? resolveCertificateFile(settings.pfxPath, 'fullchain.pfx')
      : ''
  };
}

export function buildTlsOptions(settings) {
  const resolvedPaths = resolveTlsPaths(settings);
  if (settings.certificateMode === 'pfx') {
    return {
      pfx: fs.readFileSync(resolvedPaths.pfxPath),
      ...(settings.passphrase ? { passphrase: settings.passphrase } : {}),
      minVersion: 'TLSv1.2'
    };
  }

  return {
    cert: fs.readFileSync(resolvedPaths.certificatePath),
    key: fs.readFileSync(resolvedPaths.privateKeyPath),
    ...(settings.passphrase ? { passphrase: settings.passphrase } : {}),
    minVersion: 'TLSv1.2'
  };
}

function validatePort(port, label, errors) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`${label} must be an integer between 1 and 65535.`);
  }
}

function validateBindHost(host, label, errors) {
  if (!host || host.length > 255 || /[\u0000-\u0020/]/.test(host)) {
    errors.push(`${label} must be a valid bind address or host name.`);
  }
}

function validatePublicHostname(hostname, errors) {
  if (!hostname) {
    errors.push('A public HTTPS host name is required when HTTP redirection is enabled.');
    return;
  }
  if (hostname.includes('://') || /[/?#@]/.test(hostname)
    || (hostname.includes(':') && !(hostname.startsWith('[') && hostname.endsWith(']')))) {
    errors.push('The public HTTPS host name must not include a scheme, path, query, credentials, or port. Use brackets for an IPv6 address.');
    return;
  }
  try {
    const parsed = new URL(`https://${hostname}`);
    if (!parsed.hostname || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      errors.push('The public HTTPS host name is invalid.');
    }
  } catch {
    errors.push('The public HTTPS host name is invalid.');
  }
}

function checkReadableFile(filePath, label, errors) {
  if (!filePath) {
    errors.push(`${label} is required.`);
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      errors.push(`${label} must point to a file: ${filePath}`);
      return false;
    }
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch (error) {
    errors.push(`${label} cannot be read at ${filePath}: ${error.message}`);
    return false;
  }
}

function certificateMetadata(certificate) {
  const validFrom = certificate.validFromDate || new Date(certificate.validFrom);
  const validTo = certificate.validToDate || new Date(certificate.validTo);
  return {
    subject: certificate.subject,
    issuer: certificate.issuer,
    subjectAltName: certificate.subjectAltName || '',
    fingerprint256: certificate.fingerprint256,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    daysRemaining: Math.ceil((validTo.getTime() - Date.now()) / 86400000)
  };
}

export function validateTlsSettings(settings, { checkCertificateFiles = true } = {}) {
  const normalized = normalizeTlsSettings(settings);
  const resolvedPaths = resolveTlsPaths(normalized);
  const errors = [];
  let certificate = null;

  validatePort(normalized.httpPort, 'HTTP port', errors);
  validateBindHost(normalized.httpHost, 'HTTP bind address', errors);

  if (normalized.httpsEnabled) {
    validatePort(normalized.httpsPort, 'HTTPS port', errors);
    validateBindHost(normalized.httpsHost, 'HTTPS bind address', errors);
    if (normalized.autoReloadCertificate && (normalized.reloadIntervalMinutes < 1 || normalized.reloadIntervalMinutes > 1440)) {
      errors.push('The certificate reload interval must be between 1 and 1440 minutes.');
    }
    if (normalized.httpPort === normalized.httpsPort) {
      errors.push('HTTP and HTTPS cannot use the same port.');
    }
    if (normalized.redirectHttpToHttps) validatePublicHostname(normalized.publicHostname, errors);

    if (checkCertificateFiles) {
      if (normalized.certificateMode === 'pem') {
        const certificateReadable = checkReadableFile(resolvedPaths.certificatePath, 'Certificate chain file', errors);
        const keyReadable = checkReadableFile(resolvedPaths.privateKeyPath, 'Private key file', errors);
        if (certificateReadable && keyReadable) {
          try {
            const options = buildTlsOptions(normalized);
            tls.createSecureContext(options);
            const x509 = new X509Certificate(options.cert);
            const privateKey = createPrivateKey({
              key: options.key,
              ...(normalized.passphrase ? { passphrase: normalized.passphrase } : {})
            });
            if (!x509.checkPrivateKey(privateKey)) {
              errors.push('The private key does not match the certificate.');
            }
            certificate = certificateMetadata(x509);
            if (normalized.redirectHttpToHttps && normalized.publicHostname) {
              const hostname = normalized.publicHostname.replace(/^\[|\]$/g, '');
              const certificateMatch = isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname);
              if (!certificateMatch) {
                errors.push(`The certificate does not match the public HTTPS host name ${normalized.publicHostname}.`);
              }
            }
            const validFrom = new Date(certificate.validFrom).getTime();
            const validTo = new Date(certificate.validTo).getTime();
            if (Date.now() < validFrom) errors.push('The certificate is not valid yet.');
            if (Date.now() >= validTo) errors.push('The certificate has expired.');
          } catch (error) {
            errors.push(`The PEM certificate configuration is invalid: ${error.message}`);
          }
        }
      } else {
        const pfxReadable = checkReadableFile(resolvedPaths.pfxPath, 'PFX certificate file', errors);
        if (pfxReadable) {
          try {
            tls.createSecureContext(buildTlsOptions(normalized));
          } catch (error) {
            errors.push(`The PFX certificate configuration is invalid: ${error.message}`);
          }
        }
      }
    }
  }

  return {
    settings: normalized,
    resolvedPaths,
    certificate,
    errors,
    valid: errors.length === 0
  };
}

export function inspectTlsSettings(settings) {
  const normalized = normalizeTlsSettings(settings);
  if (!normalized.httpsEnabled) {
    return {
      status: 'disabled',
      message: 'HTTPS is currently disabled.',
      resolvedPaths: resolveTlsPaths(normalized),
      certificate: null,
      errors: []
    };
  }

  const validation = validateTlsSettings(normalized);
  return {
    status: validation.valid ? 'ready' : 'error',
    message: validation.valid
      ? 'The saved TLS certificate configuration is valid.'
      : validation.errors[0],
    resolvedPaths: validation.resolvedPaths,
    certificate: validation.certificate,
    errors: validation.errors
  };
}

export function certificateFileSignature(settings) {
  const resolvedPaths = resolveTlsPaths(settings);
  const files = settings.certificateMode === 'pfx'
    ? [resolvedPaths.pfxPath]
    : [resolvedPaths.certificatePath, resolvedPaths.privateKeyPath];
  return files.map((filePath) => {
    const stat = fs.statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  }).join('|');
}
