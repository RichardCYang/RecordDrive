import { inspect } from 'node:util';
import { logRequestErrorSafely } from '../src/request-error-security.js';

const marker = 'POC-CREDENTIAL-DO-NOT-USE-5f2b76c1';
const error = new SyntaxError(`Unexpected token near ${marker}`);
error.status = 400;
error.type = 'entity.parse.failed';
error.body = `{"currentPassword":"${marker}",`;

// Node's console formatting uses util.inspect() for Error objects. This mirrors
// console.error(error) without writing the synthetic credential to stderr.
const vulnerableOutput = inspect(error);
const captured = [];
const originalConsoleError = console.error;
console.error = (...args) => captured.push(args);
try {
  logRequestErrorSafely(error, 'Request body rejected');
} finally {
  console.error = originalConsoleError;
}
const hardenedOutput = captured.flat().map(String).join('\n');

const result = {
  modeledBodyParserError: {
    status: error.status,
    type: error.type,
    hasRawBodyProperty: Object.hasOwn(error, 'body')
  },
  vulnerableLogger: {
    credentialMarkerPresent: vulnerableOutput.includes(marker),
    submittedFieldNamePresent: vulnerableOutput.includes('currentPassword'),
    rawBodyPropertyPresent: vulnerableOutput.includes('body:')
  },
  hardenedLogger: {
    parserErrorClassPresent: hardenedOutput.includes('entity.parse.failed'),
    credentialMarkerPresent: hardenedOutput.includes(marker),
    submittedFieldNamePresent: hardenedOutput.includes('currentPassword'),
    rawBodyPropertyPresent: hardenedOutput.includes('body:')
  }
};
result.verdict = result.vulnerableLogger.credentialMarkerPresent
  && result.vulnerableLogger.rawBodyPropertyPresent
  && result.hardenedLogger.parserErrorClassPresent
  && !result.hardenedLogger.credentialMarkerPresent
  && !result.hardenedLogger.submittedFieldNamePresent
  && !result.hardenedLogger.rawBodyPropertyPresent
  ? 'PASS'
  : 'FAIL';

console.log(JSON.stringify(result, null, 2));
if (result.verdict !== 'PASS') process.exitCode = 1;
