import { applyRuntimeConfidentialityPolicy, loadConfig } from '../src/config.js';

function expressNumericTrustProtocol({ encrypted = false, forwardedProto = '', hopCount }) {
  const socketProtocol = encrypted ? 'https' : 'http';
  const directPeerTrusted = Number.isInteger(hopCount) && 0 < hopCount;
  if (!directPeerTrusted) return socketProtocol;
  return String(forwardedProto).split(',')[0].trim() || socketProtocol;
}

const environment = {
  NODE_ENV: 'test',
  HTTP_HOST: '0.0.0.0',
  TRUST_PROXY: '1',
  ALLOWED_HOSTS: 'files.example.test',
  SESSION_SECRET: 'poc-session-secret-with-at-least-thirty-two-utf8-bytes',
  ADMIN_ACCESS_DISABLED: 'true'
};

const vulnerableProtocol = expressNumericTrustProtocol({
  encrypted: false,
  forwardedProto: 'https',
  hopCount: 1
});
const vulnerableGateAllows = vulnerableProtocol === 'https';

let patchedResult;
try {
  const config = loadConfig(environment);
  applyRuntimeConfidentialityPolicy(config, { httpsEnabled: false, httpHost: '0.0.0.0' });
  patchedResult = { blocked: false, trustProxy: config.trustProxy };
} catch (error) {
  patchedResult = { blocked: true, message: error.message };
}

console.log(JSON.stringify({
  vulnerableModel: {
    directSocketEncrypted: false,
    attackerHeader: 'X-Forwarded-Proto: https',
    expressProtocol: vulnerableProtocol,
    applicationHttpsGateAllows: vulnerableGateAllows
  },
  patchedConfiguration: patchedResult
}, null, 2));
