import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createHostHeaderProtection,
  isRequestHostAllowed,
  parseAllowedHosts,
  parseRequestHostHeader
} from '../src/middleware/host-header.js';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    type(value) {
      this.headers['content-type'] = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    }
  };
}

test('rejects malformed or ambiguous Host authorities', () => {
  assert.equal(parseRequestHostHeader(''), null);
  assert.equal(parseRequestHostHeader('attacker.example,localhost'), null);
  assert.equal(parseRequestHostHeader('attacker.example@localhost'), null);
  assert.equal(parseRequestHostHeader('localhost/path'), null);
  assert.equal(parseRequestHostHeader('localhost:0'), null);
  assert.equal(parseRequestHostHeader('::1'), null);
  assert.deepEqual(parseRequestHostHeader('[::1]:3443'), { hostname: '::1', port: 3443 });
  assert.deepEqual(parseRequestHostHeader('LOCALHOST.:3000'), { hostname: 'localhost', port: 3000 });
});

test('limits direct loopback deployments to loopback Host names', () => {
  const localPolicy = { externallyReachable: false, allowedHosts: [] };
  assert.equal(isRequestHostAllowed('localhost:3000', localPolicy), true);
  assert.equal(isRequestHostAllowed('preview.localhost:3000', localPolicy), true);
  assert.equal(isRequestHostAllowed('127.0.0.1:3000', localPolicy), true);
  assert.equal(isRequestHostAllowed('[::1]:3000', localPolicy), true);
  assert.equal(isRequestHostAllowed('attacker.example:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('2130706433:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('0177.0.0.1:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('0x7f000001:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('127.1:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('%31%32%37.0.0.1:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('１２７.０.０.１:3000', localPolicy), false);
  assert.equal(isRequestHostAllowed('127。0。0。1:3000', localPolicy), false);
});

test('requires an exact configured allowlist for externally reachable deployments', () => {
  const externalPolicy = {
    externallyReachable: true,
    allowedHosts: parseAllowedHosts('drive.example.com,192.0.2.10,::1')
  };
  assert.equal(isRequestHostAllowed('drive.example.com:443', externalPolicy), true);
  assert.equal(isRequestHostAllowed('192.0.2.10:443', externalPolicy), true);
  assert.equal(isRequestHostAllowed('[::1]:3443', externalPolicy), true);
  assert.equal(isRequestHostAllowed('sub.drive.example.com:443', externalPolicy), false);
  assert.equal(isRequestHostAllowed('attacker.example:443', externalPolicy), false);
  assert.throws(() => parseAllowedHosts('*.example.com'), /invalid host value/);
  assert.throws(() => parseAllowedHosts('drive.example.com:443'), /must not include ports/);
});

test('returns 421 before application state is reached for an untrusted Host', () => {
  const middleware = createHostHeaderProtection({
    externallyReachable: false,
    allowedHosts: []
  });
  let nextCalled = false;
  const response = makeResponse();

  middleware({
    rawHeaders: ['Host', 'attacker.example:3000'],
    headers: { host: 'attacker.example:3000' }
  }, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 421);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body, 'The request Host header is not allowed.');
});


test('rejects duplicate Host fields and runs before stateful application middleware', () => {
  const middleware = createHostHeaderProtection({ externallyReachable: false, allowedHosts: [] });
  const response = makeResponse();
  let nextCalled = false;
  middleware({
    rawHeaders: ['Host', 'localhost:3000', 'Host', 'attacker.example:3000'],
    headers: { host: 'localhost:3000' }
  }, response, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 421);

  const appSource = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const hostIndex = appSource.indexOf('app.use(createHostHeaderProtection(config))');
  assert.ok(hostIndex > -1);
  assert.ok(hostIndex < appSource.indexOf('app.use(express.static'));
  assert.ok(hostIndex < appSource.indexOf('app.use(express.urlencoded'));
  assert.ok(hostIndex < appSource.indexOf('app.use(session'));
});
