const SAFE_ERROR_NAMES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'MulterError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError'
]);

const REQUEST_BODY_CLIENT_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
  'parameters.too.many',
  'request.aborted',
  'request.size.invalid'
]);

function readPrimitive(error, key) {
  try {
    const value = error?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
  } catch {
    // Error objects can contain getters. Logging must not trigger more failures.
  }
  return undefined;
}

function safeLabel(value, fallback, maxLength = 100) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized.slice(0, maxLength) || fallback;
}

function safeErrorName(error) {
  const candidate = readPrimitive(error, 'name');
  return typeof candidate === 'string' && SAFE_ERROR_NAMES.has(candidate) ? candidate : 'Error';
}

function safeErrorCode(error) {
  const candidate = readPrimitive(error, 'code');
  if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return candidate;
  if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)) return candidate;
  return undefined;
}

function safeStatus(error) {
  const candidate = Number(readPrimitive(error, 'status') ?? readPrimitive(error, 'statusCode'));
  return Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
    ? candidate
    : undefined;
}

function safeStackFrames(error) {
  const stack = readPrimitive(error, 'stack');
  if (typeof stack !== 'string') return [];

  // The first stack line contains Error.message. JSON parser messages can quote
  // attacker-controlled request fragments, so retain only conventional frames.
  return stack
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 12)
    .map((line) => line.slice(0, 500));
}

export function requestBodyClientErrorStatus(error) {
  const type = readPrimitive(error, 'type');
  const status = safeStatus(error);
  if (typeof type !== 'string' || !REQUEST_BODY_CLIENT_ERROR_TYPES.has(type)) return 0;
  return status && status >= 400 && status < 500 ? status : 400;
}

export function safeRequestErrorLogRecord(error) {
  const record = { name: safeErrorName(error) };
  const code = safeErrorCode(error);
  const type = readPrimitive(error, 'type');
  const status = safeStatus(error);

  if (code !== undefined) record.code = code;
  if (typeof type === 'string' && REQUEST_BODY_CLIENT_ERROR_TYPES.has(type)) record.type = type;
  if (status) record.status = status;
  return record;
}

export function logRequestErrorSafely(error, context = 'Unhandled request error') {
  const label = safeLabel(context, 'Unhandled request error', 120);
  const record = JSON.stringify(safeRequestErrorLogRecord(error));
  const frames = safeStackFrames(error);
  const suffix = frames.length > 0 ? `\n${frames.join('\n')}` : '';

  // Pass only a pre-sanitized string. Never pass the original Error object:
  // body-parser error objects can carry the complete failed request entity.
  console.error(`${label}: ${record}${suffix}`);
}
