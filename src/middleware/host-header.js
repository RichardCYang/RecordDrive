import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const MAX_HOST_HEADER_LENGTH = 512;
const MAX_HOSTNAME_LENGTH = 253;

function normalizeDnsHostname(value) {
  let hostname = String(value || '').trim().toLowerCase();
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) return '';

  if (isIP(hostname)) return hostname;

  // WHATWG URL canonicalization accepts legacy numeric IPv4 spellings such as
  // 2130706433, 0177.0.0.1, 0x7f000001, and 127.1. Do not silently turn
  // those ambiguous authorities into a trusted loopback address.
  if (/^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/i.test(hostname)) {
    return '';
  }

  const ascii = domainToASCII(hostname).toLowerCase();
  if (!ascii || ascii.length > MAX_HOSTNAME_LENGTH) return '';
  // A canonical IP literal must already have passed isIP() above. Reject any
  // percent-encoded, Unicode-confusable, or legacy spelling that URL parsing
  // would otherwise transform into an IP address after validation.
  if (isIP(ascii)) return '';
  const labels = ascii.split('.');
  if (labels.some((label) => (
    !label
    || label.length > 63
    || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith('-')
    || label.endsWith('-')
  ))) {
    return '';
  }
  return ascii;
}

function validPort(value) {
  if (!/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function parseRequestHostHeader(value) {
  const authority = String(value || '');
  if (
    !authority
    || authority.length > MAX_HOST_HEADER_LENGTH
    || /[\u0000-\u0020\u007f]/.test(authority)
    || /[,/@\\?#]/.test(authority)
  ) {
    return null;
  }

  if (authority.startsWith('[')) {
    const match = authority.match(/^\[([^\]]+)](?::(\d{1,5}))?$/);
    if (!match || isIP(match[1]) !== 6) return null;
    if (match[2] && !validPort(match[2])) return null;
    return {
      hostname: match[1].toLowerCase(),
      port: match[2] ? Number(match[2]) : null
    };
  }

  const colonCount = [...authority].filter((character) => character === ':').length;
  let hostnameValue = authority;
  let port = null;
  if (colonCount === 1) {
    const separator = authority.lastIndexOf(':');
    const portValue = authority.slice(separator + 1);
    if (!validPort(portValue)) return null;
    hostnameValue = authority.slice(0, separator);
    port = Number(portValue);
  } else if (colonCount > 1) {
    // IPv6 literals in HTTP Host fields must use brackets.
    return null;
  }

  const hostname = normalizeDnsHostname(hostnameValue);
  if (!hostname) return null;
  return { hostname, port };
}

function normalizeAllowedHostEntry(value) {
  let candidate = String(value || '').trim();
  if (!candidate) return '';
  if (
    candidate.includes('://')
    || /[\u0000-\u0020\u007f,/@\\?#*]/.test(candidate)
  ) {
    throw new Error(`ALLOWED_HOSTS contains an invalid host value: ${candidate}`);
  }

  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1);
  }
  if (isIP(candidate) === 6) return candidate.toLowerCase();
  if (candidate.includes(':')) {
    throw new Error('ALLOWED_HOSTS entries must not include ports.');
  }

  const hostname = normalizeDnsHostname(candidate);
  if (!hostname) throw new Error(`ALLOWED_HOSTS contains an invalid host value: ${candidate}`);
  return hostname;
}

export function parseAllowedHosts(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  const hosts = new Set();
  for (const entry of entries) {
    const normalized = normalizeAllowedHostEntry(entry);
    if (normalized) hosts.add(normalized);
  }
  return Object.freeze([...hosts]);
}

export function isLoopbackRequestHostname(value) {
  const hostname = normalizeDnsHostname(value);
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const family = isIP(hostname);
  if (family === 4) return hostname.split('.')[0] === '127';
  return family === 6 && (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1');
}

export function isRequestHostAllowed(value, config = {}) {
  const parsed = parseRequestHostHeader(value);
  if (!parsed) return false;

  const allowedHosts = new Set(parseAllowedHosts(config.allowedHosts || []));
  if (allowedHosts.has(parsed.hostname)) return true;
  return !config.externallyReachable && isLoopbackRequestHostname(parsed.hostname);
}

function singleRawHostHeader(req) {
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    const values = [];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index] || '').toLowerCase() === 'host') {
        values.push(String(req.rawHeaders[index + 1] || ''));
      }
    }
    if (values.length !== 1) return '';
    return values[0];
  }
  return String(req.headers?.host || '');
}

export function createHostHeaderProtection(config = {}) {
  // Compile and validate the configured allowlist once during application startup.
  const policy = {
    allowedHosts: parseAllowedHosts(config.allowedHosts || []),
    externallyReachable: Boolean(config.externallyReachable)
  };

  return function hostHeaderProtection(req, res, next) {
    if (isRequestHostAllowed(singleRawHostHeader(req), policy)) return next();

    res.set('Cache-Control', 'no-store');
    return res.status(421).type('text/plain').send('The request Host header is not allowed.');
  };
}
