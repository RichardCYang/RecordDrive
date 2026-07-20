const GLOBAL_SETTING_DEFINITIONS = Object.freeze({
  maxFileSizeMb: {
    key: 'quota.max_file_size_mb',
    fallback: 0,
    minimum: 0,
    maximum: 10_240,
    integer: false
  },
  maxFilesPerUpload: {
    key: 'quota.max_files_per_upload',
    fallback: 10,
    minimum: 1,
    maximum: 100,
    integer: true
  },
  maxRepositoryStorageMb: {
    key: 'quota.max_repository_storage_mb',
    fallback: 10_240,
    minimum: 0,
    maximum: 1024 * 1024,
    integer: false
  },
  maxTotalStorageMb: {
    key: 'quota.max_total_storage_mb',
    fallback: 102_400,
    minimum: 0,
    maximum: 1024 * 1024,
    integer: false
  },
  maxRepositoryFiles: {
    key: 'quota.max_repository_files',
    fallback: 10_000,
    minimum: 0,
    maximum: 10_000_000,
    integer: true
  },
  maxTotalFiles: {
    key: 'quota.max_total_files',
    fallback: 100_000,
    minimum: 0,
    maximum: 100_000_000,
    integer: true
  }
});

const REPOSITORY_SETTING_DEFINITIONS = Object.freeze({
  maxFileSizeMb: GLOBAL_SETTING_DEFINITIONS.maxFileSizeMb,
  maxRepositoryStorageMb: GLOBAL_SETTING_DEFINITIONS.maxRepositoryStorageMb
});

export class QuotaSettingsError extends Error {
  constructor(message, field = '') {
    super(message);
    this.name = 'QuotaSettingsError';
    this.code = 'INVALID_QUOTA_SETTINGS';
    this.field = field;
    this.statusCode = 400;
  }
}

function ensureAppSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function normalizedNumber(value, definition, fallback = definition.fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (definition.integer && !Number.isSafeInteger(number)) return fallback;
  if (number < definition.minimum || number > definition.maximum) return fallback;
  return number;
}

function configuredSeedValue(config, property, definition) {
  return normalizedNumber(config?.[property], definition, definition.fallback);
}

function parseRequiredNumber(value, definition, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new QuotaSettingsError('Enter a number within the supported range.', field);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)
    || (definition.integer && !Number.isSafeInteger(number))
    || number < definition.minimum
    || number > definition.maximum) {
    throw new QuotaSettingsError('Enter a number within the supported range.', field);
  }
  return number;
}

function parseOptionalNumber(value, definition, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return parseRequiredNumber(normalized, definition, field);
}

function globalSettingsRows(db) {
  const keys = Object.values(GLOBAL_SETTING_DEFINITIONS).map(({ key }) => key);
  const placeholders = keys.map(() => '?').join(', ');
  return db.prepare(`
    SELECT setting_key, setting_value
    FROM app_settings
    WHERE setting_key IN (${placeholders})
  `).all(...keys);
}

export function ensureQuotaSettings(db, config = {}) {
  ensureAppSettingsTable(db);
  const insert = db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO NOTHING
  `);

  for (const [property, definition] of Object.entries(GLOBAL_SETTING_DEFINITIONS)) {
    insert.run(definition.key, String(configuredSeedValue(config, property, definition)));
  }
}

export function loadGlobalQuotaSettings(db, config = {}) {
  ensureQuotaSettings(db, config);
  const stored = new Map(globalSettingsRows(db).map((row) => [row.setting_key, row.setting_value]));
  const result = {};

  for (const [property, definition] of Object.entries(GLOBAL_SETTING_DEFINITIONS)) {
    result[property] = normalizedNumber(
      stored.get(definition.key),
      definition,
      configuredSeedValue(config, property, definition)
    );
  }
  return result;
}

export function updateGlobalQuotaSettings(db, input = {}, config = {}) {
  ensureQuotaSettings(db, config);
  const next = {};
  for (const [property, definition] of Object.entries(GLOBAL_SETTING_DEFINITIONS)) {
    next[property] = parseRequiredNumber(input[property], definition, property);
  }

  const upsert = db.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [property, definition] of Object.entries(GLOBAL_SETTING_DEFINITIONS)) {
      upsert.run(definition.key, String(next[property]));
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }

  return next;
}

function repositoryRecord(db, repositoryOrId) {
  if (repositoryOrId && typeof repositoryOrId === 'object') return repositoryOrId;
  const repositoryId = Number(repositoryOrId);
  if (!Number.isInteger(repositoryId)) return null;
  return db.prepare(`
    SELECT id, max_file_size_mb, max_storage_mb
    FROM repositories
    WHERE id = ?
  `).get(repositoryId) || null;
}

function storedRepositoryOverride(value, definition) {
  if (value === null || value === undefined || value === '') return null;
  return normalizedNumber(value, definition, null);
}

export function loadRepositoryQuotaSettings(db, config = {}, repositoryOrId) {
  const global = loadGlobalQuotaSettings(db, config);
  const repository = repositoryRecord(db, repositoryOrId);
  const overrides = {
    maxFileSizeMb: storedRepositoryOverride(
      repository?.max_file_size_mb,
      REPOSITORY_SETTING_DEFINITIONS.maxFileSizeMb
    ),
    maxRepositoryStorageMb: storedRepositoryOverride(
      repository?.max_storage_mb,
      REPOSITORY_SETTING_DEFINITIONS.maxRepositoryStorageMb
    )
  };

  return {
    global,
    overrides,
    effective: {
      ...global,
      maxFileSizeMb: overrides.maxFileSizeMb ?? global.maxFileSizeMb,
      maxRepositoryStorageMb: overrides.maxRepositoryStorageMb ?? global.maxRepositoryStorageMb
    }
  };
}

export function loadEffectiveQuotaSettings(db, config = {}, repositoryOrId) {
  return loadRepositoryQuotaSettings(db, config, repositoryOrId).effective;
}

export function updateRepositoryQuotaSettings(db, repositoryId, input = {}) {
  const normalizedRepositoryId = Number(repositoryId);
  if (!Number.isInteger(normalizedRepositoryId)) {
    throw new QuotaSettingsError('The repository could not be found.', 'repositoryId');
  }

  const maxFileSizeMb = parseOptionalNumber(
    input.maxFileSizeMb,
    REPOSITORY_SETTING_DEFINITIONS.maxFileSizeMb,
    'maxFileSizeMb'
  );
  const maxRepositoryStorageMb = parseOptionalNumber(
    input.maxRepositoryStorageMb,
    REPOSITORY_SETTING_DEFINITIONS.maxRepositoryStorageMb,
    'maxRepositoryStorageMb'
  );

  const result = db.prepare(`
    UPDATE repositories
    SET max_file_size_mb = ?, max_storage_mb = ?
    WHERE id = ?
  `).run(maxFileSizeMb, maxRepositoryStorageMb, normalizedRepositoryId);

  if (result.changes !== 1) {
    throw new QuotaSettingsError('The repository could not be found.', 'repositoryId');
  }

  return { maxFileSizeMb, maxRepositoryStorageMb };
}

export const quotaSettingRanges = Object.freeze({
  maxFileSizeMb: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxFileSizeMb.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxFileSizeMb.maximum
  }),
  maxFilesPerUpload: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxFilesPerUpload.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxFilesPerUpload.maximum
  }),
  maxRepositoryStorageMb: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxRepositoryStorageMb.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxRepositoryStorageMb.maximum
  }),
  maxTotalStorageMb: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxTotalStorageMb.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxTotalStorageMb.maximum
  }),
  maxRepositoryFiles: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxRepositoryFiles.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxRepositoryFiles.maximum
  }),
  maxTotalFiles: Object.freeze({
    minimum: GLOBAL_SETTING_DEFINITIONS.maxTotalFiles.minimum,
    maximum: GLOBAL_SETTING_DEFINITIONS.maxTotalFiles.maximum
  })
});
