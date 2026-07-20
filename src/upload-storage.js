import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, pipeline } from 'node:stream';
import { ensureSecureRepositoryDirectory } from './file-access-time.js';
import { isValidCsrf } from './middleware/csrf.js';
import { loadEffectiveQuotaSettings } from './quota-settings.js';

const BYTES_PER_MEGABYTE = 1024 * 1024;

export class UploadQuotaError extends Error {
  constructor(message, quota = 'UNKNOWN') {
    super(message);
    this.name = 'UploadQuotaError';
    this.code = 'UPLOAD_QUOTA_EXCEEDED';
    this.quota = quota;
    this.statusCode = 413;
  }
}

export class UploadCsrfError extends Error {
  constructor() {
    super('The upload security token is invalid or was not provided before the file data.');
    this.name = 'UploadCsrfError';
    this.code = 'INVALID_UPLOAD_CSRF';
    this.statusCode = 403;
  }
}

function configuredQuotaBytes(value) {
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return Number.POSITIVE_INFINITY;
  return megabytes * BYTES_PER_MEGABYTE;
}

function configuredQuotaCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) return Number.POSITIVE_INFINITY;
  return count;
}

function uploadFileSizeLimit(settings) {
  return configuredQuotaBytes(settings.maxFileSizeMb);
}

export function uploadQuotaErrorMessage(req, error, settings) {
  if (error?.quota === 'FILE_SIZE' && Number(settings.maxFileSizeMb) > 0) {
    return req.t('Each file can be up to {{size}} MB.', { size: settings.maxFileSizeMb });
  }
  return req.t(error?.message || 'The upload could not be completed. Please try again.');
}

function removePath(filePath) {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Preserve the original upload error if cleanup also fails.
  }
}

function createQuotaCoordinator(db) {
  const reservations = new Map();
  const repositoryUsage = new Map();
  let totalUsage = { count: 0, size: 0 };

  function refreshUsage(repositoryId) {
    const currentRepositoryUsage = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
      FROM files WHERE repository_id = ?
    `).get(repositoryId);
    const currentTotalUsage = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size
      FROM files
    `).get();
    repositoryUsage.set(Number(repositoryId), {
      count: Number(currentRepositoryUsage.count || 0),
      size: Number(currentRepositoryUsage.size || 0)
    });
    totalUsage = {
      count: Number(currentTotalUsage.count || 0),
      size: Number(currentTotalUsage.size || 0)
    };
  }

  function activeUsage(repositoryId) {
    let repositoryBytes = 0;
    let repositoryCount = 0;
    let totalBytes = 0;
    let totalCount = 0;

    for (const reservation of reservations.values()) {
      totalBytes += reservation.reservedBytes;
      totalCount += 1;
      if (Number(reservation.repositoryId) === Number(repositoryId)) {
        repositoryBytes += reservation.reservedBytes;
        repositoryCount += 1;
      }
    }

    return { repositoryBytes, repositoryCount, totalBytes, totalCount };
  }

  return {
    reserve(repositoryId, limits) {
      const normalizedRepositoryId = Number(repositoryId);
      refreshUsage(normalizedRepositoryId);
      const committedRepositoryUsage = repositoryUsage.get(normalizedRepositoryId);
      const active = activeUsage(normalizedRepositoryId);

      if (committedRepositoryUsage.count + active.repositoryCount + 1
        > configuredQuotaCount(limits.maxRepositoryFiles)) {
        throw new UploadQuotaError(
          'The repository file count quota would be exceeded.',
          'REPOSITORY_FILE_COUNT'
        );
      }
      if (totalUsage.count + active.totalCount + 1 > configuredQuotaCount(limits.maxTotalFiles)) {
        throw new UploadQuotaError('The server file count quota would be exceeded.', 'TOTAL_FILE_COUNT');
      }

      const id = crypto.randomUUID();
      reservations.set(id, {
        id,
        repositoryId: normalizedRepositoryId,
        reservedBytes: 0,
        limits
      });
      return { id };
    },

    grow(id, additionalBytes) {
      const reservation = reservations.get(id);
      if (!reservation) throw new Error('The upload quota reservation is no longer active.');
      const committedRepositoryUsage = repositoryUsage.get(reservation.repositoryId);
      const active = activeUsage(reservation.repositoryId);
      const nextFileSize = reservation.reservedBytes + additionalBytes;

      if (nextFileSize > uploadFileSizeLimit(reservation.limits)) {
        throw new UploadQuotaError('The file size limit would be exceeded.', 'FILE_SIZE');
      }
      if (committedRepositoryUsage.size + active.repositoryBytes + additionalBytes
        > configuredQuotaBytes(reservation.limits.maxRepositoryStorageMb)) {
        throw new UploadQuotaError(
          'The repository storage quota would be exceeded.',
          'REPOSITORY_STORAGE'
        );
      }
      if (totalUsage.size + active.totalBytes + additionalBytes
        > configuredQuotaBytes(reservation.limits.maxTotalStorageMb)) {
        throw new UploadQuotaError('The server storage quota would be exceeded.', 'TOTAL_STORAGE');
      }
      reservation.reservedBytes = nextFileSize;
    },

    commit(files = []) {
      const repositoryIds = new Set();
      for (const file of files) {
        const reservation = reservations.get(file?.quotaReservationId);
        if (reservation) repositoryIds.add(reservation.repositoryId);
      }
      for (const repositoryId of repositoryIds) refreshUsage(repositoryId);
      for (const file of files) {
        reservations.delete(file?.quotaReservationId);
        if (file) delete file.quotaReservationId;
      }
    },

    release(id) {
      if (id) reservations.delete(id);
    }
  };
}
export function createQuotaAwareUploadStorage(db, config) {
  const quotaCoordinator = createQuotaCoordinator(db);

  return {
    _handleFile(req, file, callback) {
      if (!isValidCsrf(req)) {
        callback(new UploadCsrfError());
        return;
      }

      let reservation;
      let filePath = '';
      try {
        const limits = req.uploadQuotaSettings
          || loadEffectiveQuotaSettings(db, config, req.repository.id);
        req.uploadQuotaSettings = limits;
        reservation = quotaCoordinator.reserve(req.repository.id, limits);
        const destination = ensureSecureRepositoryDirectory(config, req.repository.id);
        const filename = crypto.randomUUID();
        filePath = path.join(destination, filename);
        // Expose pending-file metadata before streaming starts so Multer can remove a
        // partially written file if the source stream errors before _handleFile completes.
        file.destination = destination;
        file.filename = filename;
        file.path = filePath;
        file.quotaReservationId = reservation.id;
        let size = 0;
        const limiter = new Transform({
          transform(chunk, encoding, done) {
            try {
              quotaCoordinator.grow(reservation.id, chunk.length);
              size += chunk.length;
              req.uploadReceivedBytes = Number(req.uploadReceivedBytes || 0) + chunk.length;
              done(null, chunk);
            } catch (error) {
              done(error);
            }
          }
        });
        const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
        const output = fs.createWriteStream(filePath, {
          flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          mode: 0o600
        });

        pipeline(file.stream, limiter, output, (error) => {
          if (error) {
            removePath(filePath);
            quotaCoordinator.release(reservation.id);
            callback(error);
            return;
          }

          callback(null, {
            destination,
            filename,
            path: filePath,
            size,
            quotaReservationId: reservation.id
          });
        });
      } catch (error) {
        removePath(filePath);
        quotaCoordinator.release(reservation?.id);
        callback(error);
      }
    },

    _removeFile(req, file, callback) {
      quotaCoordinator.release(file.quotaReservationId);
      const filePath = file.path;
      delete file.destination;
      delete file.filename;
      delete file.path;
      delete file.quotaReservationId;
      if (!filePath) {
        callback(null);
        return;
      }
      fs.rm(filePath, { force: true }, callback);
    },

    commitReservations(files) {
      quotaCoordinator.commit(files);
    },

    releaseReservation(file) {
      quotaCoordinator.release(file?.quotaReservationId);
      if (file) delete file.quotaReservationId;
    }
  };
}
