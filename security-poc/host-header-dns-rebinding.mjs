import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isRequestHostAllowed } from '../src/middleware/host-header.js';

const hostileHost = process.env.HOSTILE_HOST || 'attacker.example';
const localHost = 'localhost';
const demoCredentials = Object.freeze({ username: 'admin', password: 'ChangeMe123!' });
const confidentialMarker = 'confidential-demo/finance-private.xlsx';

function writeJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function createDemoHandler({ enforceHostPolicy }) {
  const hostPolicy = { externallyReachable: false, allowedHosts: [] };
  return async function demoHandler(req, res) {
    if (enforceHostPolicy && !isRequestHostAllowed(req.headers.host, hostPolicy)) {
      res.writeHead(421, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end('The request Host header is not allowed.');
      return;
    }

    if (req.method === 'GET' && req.url === '/login') {
      writeJson(res, 200, { csrfToken: 'demo-csrf-token' }, {
        'Set-Cookie': 'recorddrive.demo=demo-session; HttpOnly; SameSite=Strict; Path=/'
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || '{}');
      const valid = parsed.username === demoCredentials.username
        && parsed.password === demoCredentials.password
        && parsed.csrfToken === 'demo-csrf-token'
        && String(req.headers.cookie || '').includes('recorddrive.demo=demo-session');
      if (!valid) {
        writeJson(res, 403, { authenticated: false });
        return;
      }
      writeJson(res, 200, {
        authenticated: true,
        confidentialRepositoryEntry: confidentialMarker
      });
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function request(server, { method = 'GET', path = '/', host, cookie = '', json = null }) {
  const address = server.address();
  const body = json === null ? '' : JSON.stringify(json);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      method,
      path,
      headers: {
        Host: host,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: responseBody
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function demonstrateLoginChain(server, host) {
  const loginPage = await request(server, { path: '/login', host });
  const cookie = Array.isArray(loginPage.headers['set-cookie'])
    ? loginPage.headers['set-cookie'][0].split(';', 1)[0]
    : '';
  if (loginPage.statusCode !== 200) return { loginPage, login: null };
  const token = JSON.parse(loginPage.body).csrfToken;
  const login = await request(server, {
    method: 'POST',
    path: '/login',
    host,
    cookie,
    json: { ...demoCredentials, csrfToken: token }
  });
  return { loginPage, login };
}

const legacyServer = await startServer(createDemoHandler({ enforceHostPolicy: false }));
const patchedServer = await startServer(createDemoHandler({ enforceHostPolicy: true }));

try {
  const legacyHostile = await demonstrateLoginChain(legacyServer, hostileHost);
  const patchedHostile = await demonstrateLoginChain(patchedServer, hostileHost);
  const patchedLocal = await demonstrateLoginChain(patchedServer, localHost);

  const summary = {
    hostileHost,
    legacyHostileLoginPageStatus: legacyHostile.loginPage.statusCode,
    legacyHostileLoginStatus: legacyHostile.login?.statusCode ?? null,
    legacyConfidentialMarkerReturned: legacyHostile.login?.body.includes(confidentialMarker) ?? false,
    patchedHostileStatus: patchedHostile.loginPage.statusCode,
    patchedHostileSetCookie: Boolean(patchedHostile.loginPage.headers['set-cookie']),
    patchedLocalLoginStatus: patchedLocal.login?.statusCode ?? null,
    patchedLocalConfidentialMarkerReturned: patchedLocal.login?.body.includes(confidentialMarker) ?? false
  };

  assert.equal(summary.legacyHostileLoginPageStatus, 200);
  assert.equal(summary.legacyHostileLoginStatus, 200);
  assert.equal(summary.legacyConfidentialMarkerReturned, true);
  assert.equal(summary.patchedHostileStatus, 421);
  assert.equal(summary.patchedHostileSetCookie, false);
  assert.equal(summary.patchedLocalLoginStatus, 200);
  assert.equal(summary.patchedLocalConfidentialMarkerReturned, true);

  console.log(JSON.stringify(summary, null, 2));
  console.log('Result: PASS - hostile Host requests are rejected before session establishment.');
} finally {
  legacyServer.close();
  patchedServer.close();
  await Promise.all([once(legacyServer, 'close'), once(patchedServer, 'close')]);
}
