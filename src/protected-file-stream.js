import fs from 'node:fs';

export const DEFAULT_DISCLOSURE_RECHECK_INTERVAL_MS = 250;
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024;

function normalizedPositiveInteger(value, fallback) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) return fallback;
  return normalized;
}

function readChunk(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, length, position, (error, bytesRead) => {
      if (error) return reject(error);
      return resolve({ buffer, bytesRead });
    });
  });
}

function waitForDrainOrStop(destination, isStopped) {
  if (isStopped()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      destination.off('drain', finish);
      destination.off('close', finish);
      destination.off('error', finish);
      resolve();
    };
    destination.once('drain', finish);
    destination.once('close', finish);
    destination.once('error', finish);
  });
}

export function streamProtectedFile(options = {}) {
  const {
    opened,
    tracker,
    destination,
    isAuthorized,
    onError = () => {},
    onAuthorizationError = () => {},
    onRevoked = () => {},
    recheckIntervalMs = DEFAULT_DISCLOSURE_RECHECK_INTERVAL_MS,
    highWaterMark = DEFAULT_READ_CHUNK_BYTES
  } = options;

  if (
    !opened
    || !Number.isInteger(opened.fd)
    || !opened.filePath
    || !Number.isSafeInteger(opened.stats?.size)
    || opened.stats.size < 0
  ) {
    throw new Error('An opened stored file with a stable size is required.');
  }
  if (!destination || typeof destination.on !== 'function' || typeof destination.write !== 'function') {
    throw new Error('A writable disclosure destination is required.');
  }
  if (typeof isAuthorized !== 'function') {
    throw new Error('A disclosure authorization callback is required.');
  }

  const intervalMs = normalizedPositiveInteger(
    recheckIntervalMs,
    DEFAULT_DISCLOSURE_RECHECK_INTERVAL_MS
  );
  const chunkBytes = normalizedPositiveInteger(highWaterMark, DEFAULT_READ_CHUNK_BYTES);
  let timer = null;
  let finalized = false;
  let stopped = false;
  let revoked = false;
  let streamError = null;
  let nextAuthorizationCheckAt = 0;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (timer) clearInterval(timer);

    let error = streamError;
    try {
      tracker?.complete?.();
    } catch (completionError) {
      console.error(`File access time update failed: ${completionError.message}`);
      if (!error) error = completionError;
    }
    try {
      fs.closeSync(opened.fd);
    } catch (closeError) {
      if (closeError.code !== 'EBADF') {
        console.error(`Stored file close failed: ${closeError.message}`);
        if (!error) error = closeError;
      }
    }

    if (error && !revoked) onError(error);
    resolveDone({ revoked, error: error || null });
  };

  const terminateForRevocation = () => {
    if (stopped || finalized) return;
    stopped = true;
    revoked = true;
    try {
      onRevoked();
    } catch {
      // Revocation callbacks are observational and must not keep disclosure alive.
    }
    if (typeof destination.destroy === 'function' && !destination.destroyed) {
      destination.destroy();
    }
  };

  const verifyAuthorization = (force = false) => {
    if (stopped || finalized) return false;
    const now = Date.now();
    if (!force && now < nextAuthorizationCheckAt) return true;
    try {
      if (!isAuthorized()) {
        terminateForRevocation();
        return false;
      }
      nextAuthorizationCheckAt = now + intervalMs;
      return true;
    } catch (error) {
      try {
        onAuthorizationError(error);
      } catch {
        // Authorization failures remain fail-closed even if reporting fails.
      }
      terminateForRevocation();
      return false;
    }
  };

  const destinationError = (error) => {
    if (!revoked && !streamError) streamError = error;
    stopped = true;
  };
  const destinationClosed = () => {
    stopped = true;
  };
  destination.once('error', destinationError);
  destination.once('close', destinationClosed);

  if (!verifyAuthorization(true)) {
    finalize();
    return { started: false, done, stop: terminateForRevocation };
  }

  timer = setInterval(() => verifyAuthorization(true), intervalMs);
  timer.unref?.();

  const pump = async () => {
    let position = 0;
    let remainingBytes = opened.stats.size;
    try {
      while (!stopped) {
        if (remainingBytes === 0) {
          destination.end();
          break;
        }
        if (!verifyAuthorization()) break;
        const readLength = Math.min(chunkBytes, remainingBytes);
        const { buffer, bytesRead } = await readChunk(opened.fd, readLength, position);
        if (stopped) break;
        if (bytesRead === 0) {
          destination.end();
          break;
        }
        if (!verifyAuthorization()) break;

        position += bytesRead;
        remainingBytes -= bytesRead;
        const canContinue = destination.write(buffer.subarray(0, bytesRead));
        if (!canContinue) {
          await waitForDrainOrStop(destination, () => stopped);
        }
      }
    } catch (error) {
      if (!revoked) streamError = error;
      stopped = true;
      if (typeof destination.destroy === 'function' && !destination.destroyed) {
        destination.destroy();
      }
    } finally {
      if (revoked && typeof destination.destroy === 'function' && !destination.destroyed) {
        destination.destroy();
      }
      finalize();
    }
  };

  void pump();
  return {
    started: true,
    done,
    stop: terminateForRevocation
  };
}
