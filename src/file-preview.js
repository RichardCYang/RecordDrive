import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import yauzl from 'yauzl';

const XLSX_MAX_FILE_BYTES = 25 * 1024 * 1024;
const XLSX_MAX_ARCHIVE_ENTRIES = 4096;
const XLSX_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const XLSX_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const XLSX_MAX_ROWS = 200;
const XLSX_MAX_COLUMNS = 50;
const XLSX_MAX_CELL_TEXT_BYTES = 4096;
const XLSX_MAX_RESPONSE_TEXT_BYTES = 1024 * 1024;
const XLSX_MAX_VISIBLE_MERGES = 1000;
const ZIP_MAX_FILE_BYTES = 50 * 1024 * 1024;
const ZIP_MAX_VISIBLE_ENTRIES = 2500;
const ZIP_MAX_SCANNED_ENTRIES = 10000;
const ZIP_MAX_ENTRY_NAME_BYTES = 1024;
const ZIP_MAX_VISIBLE_NAME_BYTES = 1024 * 1024;
const SEVEN_ZIP_MAX_VISIBLE_ENTRIES = 2500;
const SEVEN_ZIP_MAX_SCANNED_ENTRIES = 250000;
const SEVEN_ZIP_MAX_ENTRY_NAME_BYTES = 1024;
const SEVEN_ZIP_MAX_VISIBLE_NAME_BYTES = 1024 * 1024;
const SEVEN_ZIP_DEFAULT_TIMEOUT_MS = 60 * 1000;
const SEVEN_ZIP_DEFAULT_MAX_HEADER_BYTES = 128 * 1024 * 1024;
const SEVEN_ZIP_MAX_HEADER_BYTES = 256 * 1024 * 1024;
const PREVIEW_CONCURRENCY_LIMITS = Object.freeze({ xlsx: 2, zip: 4, '7z': 1 });
const activePreviews = { xlsx: 0, zip: 0, '7z': 0 };

export function previewFileSizeLimit(kind) {
  if (kind === 'xlsx') return XLSX_MAX_FILE_BYTES;
  if (kind === 'zip') return ZIP_MAX_FILE_BYTES;
  // The JavaScript parser performs bounded random-access reads of metadata only;
  // the full compressed archive is never loaded into memory.
  return Number.POSITIVE_INFINITY;
}

export class FilePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FilePreviewError';
    this.code = code;
  }
}

async function withPreviewSlot(kind, operation) {
  const limit = PREVIEW_CONCURRENCY_LIMITS[kind];
  if (activePreviews[kind] >= limit) {
    throw new FilePreviewError('PREVIEW_BUSY', 'The preview service is at its concurrency limit.');
  }

  activePreviews[kind] += 1;
  try {
    return await operation();
  } finally {
    activePreviews[kind] -= 1;
  }
}

function sourceSize(source, stats) {
  if (Buffer.isBuffer(source)) return source.length;
  if (Number.isFinite(stats?.size)) return stats.size;
  return fs.statSync(source).size;
}

function openZip(source, options, callback) {
  if (Buffer.isBuffer(source)) {
    yauzl.fromBuffer(source, options, callback);
    return;
  }
  yauzl.open(source, options, callback);
}

function normalizeArgb(value) {
  const argb = String(value?.argb || '').replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(argb)) return null;
  if (argb.length === 8) return `#${argb.slice(2)}`;
  return `#${argb}`;
}

function compactBorder(border = {}) {
  const result = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const definition = border[side];
    if (!definition?.style) continue;
    result[side] = { style: definition.style, color: normalizeArgb(definition.color) };
  }
  return result;
}

function compactCellStyle(cell) {
  const fontColor = normalizeArgb(cell.font?.color);
  const fillColor = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid'
    ? normalizeArgb(cell.fill.fgColor)
    : null;
  const border = compactBorder(cell.border);
  const style = {};

  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  if (cell.font?.underline) style.underline = true;
  if (Number.isFinite(cell.font?.size)) style.fontSize = cell.font.size;
  if (fontColor) style.fontColor = fontColor;
  if (fillColor) style.fillColor = fillColor;
  if (cell.alignment?.horizontal) style.horizontal = cell.alignment.horizontal;
  if (cell.alignment?.vertical) style.vertical = cell.alignment.vertical;
  if (cell.alignment?.wrapText) style.wrapText = true;
  if (Object.keys(border).length) style.border = border;
  return style;
}

function displayCellValue(cell) {
  if (cell.value === null || cell.value === undefined) return '';
  if (cell.value instanceof Date) return cell.value.toISOString();
  if (typeof cell.value === 'object') {
    if (Object.hasOwn(cell.value, 'result')) {
      const result = cell.value.result;
      if (result instanceof Date) return result.toISOString();
      if (result !== null && result !== undefined) return String(result);
    }
    if (Array.isArray(cell.value.richText)) {
      return cell.value.richText.map((part) => part.text || '').join('');
    }
    if (cell.value.text) return String(cell.value.text);
    if (cell.value.hyperlink) return String(cell.value.text || cell.value.hyperlink);
    if (cell.value.formula) return `=${cell.value.formula}`;
  }
  if (cell.text !== undefined && cell.text !== null) return String(cell.text);
  return String(cell.value);
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (maxBytes <= 0) return { value: '', truncated: text.length > 0, bytes: 0 };
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) return { value: text, truncated: false, bytes: size };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const result = text.slice(0, low);
  return { value: result, truncated: true, bytes: Buffer.byteLength(result, 'utf8') };
}

function inspectZipLimits(source, options) {
  return new Promise((resolve, reject) => {
    openZip(source, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    }, (openError, zipfile) => {
      if (openError) {
        reject(new FilePreviewError(options.invalidCode, `${options.invalidMessage}: ${openError.message}`));
        return;
      }

      let entryCount = 0;
      let totalUncompressedSize = 0;
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const rejectLimit = (message) => finish(() => {
        zipfile.close();
        reject(new FilePreviewError(options.limitCode, message));
      });

      if (Number(zipfile.entryCount || 0) > options.maxEntries) {
        rejectLimit(`The archive contains more than ${options.maxEntries} entries.`);
        return;
      }

      zipfile.on('entry', (entry) => {
        entryCount += 1;
        const entrySize = Number(entry.uncompressedSize || 0);
        totalUncompressedSize += entrySize;
        const nameBytes = Buffer.byteLength(String(entry.fileName || ''), 'utf8');

        if (entryCount > options.maxEntries) return rejectLimit(`The archive contains more than ${options.maxEntries} entries.`);
        if (entrySize > options.maxEntryBytes) return rejectLimit(`An archive entry exceeds ${options.maxEntryBytes} uncompressed bytes.`);
        if (totalUncompressedSize > options.maxTotalBytes) return rejectLimit(`The archive expands beyond ${options.maxTotalBytes} bytes.`);
        if (nameBytes > options.maxNameBytes) return rejectLimit(`An archive entry name exceeds ${options.maxNameBytes} bytes.`);
        zipfile.readEntry();
      });

      zipfile.on('end', () => finish(() => resolve({ entryCount, totalUncompressedSize })));
      zipfile.on('error', (error) => finish(() => {
        reject(new FilePreviewError(options.invalidCode, `${options.invalidMessage}: ${error.message}`));
      }));
      zipfile.readEntry();
    });
  });
}

async function loadWorkbook(source, stats) {
  if (sourceSize(source, stats) > XLSX_MAX_FILE_BYTES) {
    throw new FilePreviewError('XLSX_TOO_LARGE', `Spreadsheet previews are limited to ${XLSX_MAX_FILE_BYTES} compressed bytes.`);
  }

  await inspectZipLimits(source, {
    invalidCode: 'INVALID_XLSX',
    invalidMessage: 'The spreadsheet archive could not be read',
    limitCode: 'XLSX_TOO_LARGE',
    maxEntries: XLSX_MAX_ARCHIVE_ENTRIES,
    maxEntryBytes: XLSX_MAX_ENTRY_BYTES,
    maxTotalBytes: XLSX_MAX_UNCOMPRESSED_BYTES,
    maxNameBytes: ZIP_MAX_ENTRY_NAME_BYTES
  });

  const workbook = new ExcelJS.Workbook();
  try {
    if (Buffer.isBuffer(source)) await workbook.xlsx.load(source);
    else await workbook.xlsx.readFile(source);
  } catch (error) {
    throw new FilePreviewError('INVALID_XLSX', `The spreadsheet could not be read: ${error.message}`);
  }
  return workbook;
}

function sheetMetadata(worksheet, index) {
  return {
    index,
    name: worksheet.name,
    state: worksheet.state || 'visible',
    rowCount: worksheet.actualRowCount || 0,
    columnCount: worksheet.actualColumnCount || 0
  };
}

function worksheetMerges(worksheet, visibleRows, visibleColumns) {
  const ranges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];
  const merges = [];
  for (const range of ranges) {
    const match = String(range).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!match) continue;
    const toColumnNumber = (letters) => {
      let value = 0;
      for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
      return value;
    };
    const merge = {
      startRow: Number(match[2]),
      startColumn: toColumnNumber(match[1]),
      endRow: Number(match[4]),
      endColumn: toColumnNumber(match[3])
    };
    if (merge.startRow > visibleRows || merge.startColumn > visibleColumns) continue;
    merges.push(merge);
    if (merges.length >= XLSX_MAX_VISIBLE_MERGES) break;
  }
  return { merges, truncated: ranges.length > merges.length };
}

async function buildXlsxPreview(source, stats, requestedSheetIndex = 0) {
  const workbook = await loadWorkbook(source, stats);
  if (!workbook.worksheets.length) {
    throw new FilePreviewError('EMPTY_XLSX', 'The spreadsheet does not contain any worksheets.');
  }

  const parsedIndex = Number.parseInt(requestedSheetIndex, 10);
  const sheetIndex = Number.isInteger(parsedIndex)
    ? Math.max(0, Math.min(parsedIndex, workbook.worksheets.length - 1))
    : 0;
  const worksheet = workbook.worksheets[sheetIndex];
  const totalRows = Math.max(worksheet.actualRowCount || 0, 1);
  const totalColumns = Math.max(worksheet.actualColumnCount || 0, 1);
  const visibleRows = Math.min(totalRows, XLSX_MAX_ROWS);
  const visibleColumns = Math.min(totalColumns, XLSX_MAX_COLUMNS);
  const rows = [];
  let remainingTextBytes = XLSX_MAX_RESPONSE_TEXT_BYTES;
  let truncatedContent = false;

  for (let rowNumber = 1; rowNumber <= visibleRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = [];
    for (let columnNumber = 1; columnNumber <= visibleColumns; columnNumber += 1) {
      const cell = row.getCell(columnNumber);
      const perCell = truncateUtf8(displayCellValue(cell), XLSX_MAX_CELL_TEXT_BYTES);
      const withinResponse = truncateUtf8(perCell.value, remainingTextBytes);
      remainingTextBytes -= withinResponse.bytes;
      truncatedContent ||= perCell.truncated || withinResponse.truncated;
      cells.push({ value: withinResponse.value, type: cell.type, style: compactCellStyle(cell) });
    }
    rows.push(cells);
  }

  const columnWidths = [];
  for (let columnNumber = 1; columnNumber <= visibleColumns; columnNumber += 1) {
    const width = worksheet.getColumn(columnNumber).width;
    columnWidths.push(Number.isFinite(width) ? Math.max(6, Math.min(width, 60)) : null);
  }
  const mergeResult = worksheetMerges(worksheet, XLSX_MAX_ROWS, XLSX_MAX_COLUMNS);

  return {
    kind: 'xlsx',
    sheets: workbook.worksheets.map(sheetMetadata),
    sheet: {
      ...sheetMetadata(worksheet, sheetIndex),
      rows,
      columnWidths,
      merges: mergeResult.merges,
      visibleRowCount: visibleRows,
      visibleColumnCount: visibleColumns,
      truncatedRows: totalRows > visibleRows,
      truncatedColumns: totalColumns > visibleColumns,
      truncatedContent,
      truncatedMerges: mergeResult.truncated
    }
  };
}

export function createXlsxPreview(source, stats, requestedSheetIndex = 0) {
  return withPreviewSlot('xlsx', () => {
    const resolvedSource = typeof source === 'function' ? source() : source;
    return buildXlsxPreview(resolvedSource, stats, requestedSheetIndex);
  });
}

function zipEntryDate(entry) {
  try {
    const date = entry.getLastModDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function encryptedZipError(error) {
  return /encrypt|password/i.test(String(error?.message || error));
}

function buildZipPreview(source, stats) {
  if (sourceSize(source, stats) > ZIP_MAX_FILE_BYTES) {
    throw new FilePreviewError('ZIP_TOO_LARGE', `ZIP previews are limited to ${ZIP_MAX_FILE_BYTES} compressed bytes.`);
  }

  return new Promise((resolve, reject) => {
    openZip(source, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    }, (openError, zipfile) => {
      if (openError) {
        reject(new FilePreviewError('INVALID_ZIP', `The ZIP archive could not be read: ${openError.message}`));
        return;
      }

      let settled = false;
      let totalEntries = 0;
      let totalCompressedSize = 0;
      let totalUncompressedSize = 0;
      let visibleNameBytes = 0;
      let encrypted = false;
      let omittedEntries = false;
      const entries = [];
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const rejectLimit = (message) => finish(() => {
        zipfile.close();
        reject(new FilePreviewError('ZIP_TOO_LARGE', message));
      });

      if (Number(zipfile.entryCount || 0) > ZIP_MAX_SCANNED_ENTRIES) {
        rejectLimit(`ZIP previews are limited to ${ZIP_MAX_SCANNED_ENTRIES} entries.`);
        return;
      }

      zipfile.on('entry', (entry) => {
        totalEntries += 1;
        if (totalEntries > ZIP_MAX_SCANNED_ENTRIES) return rejectLimit(`ZIP previews are limited to ${ZIP_MAX_SCANNED_ENTRIES} entries.`);

        const rawName = String(entry.fileName || '');
        const rawNameBytes = Buffer.byteLength(rawName, 'utf8');
        if (rawNameBytes > ZIP_MAX_ENTRY_NAME_BYTES) return rejectLimit(`ZIP entry names are limited to ${ZIP_MAX_ENTRY_NAME_BYTES} bytes.`);

        totalUncompressedSize += Number(entry.uncompressedSize || 0);
        totalCompressedSize += Number(entry.compressedSize || 0);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0 || (entry.generalPurposeBitFlag & 0x40) !== 0) encrypted = true;

        if (!encrypted) {
          const normalizedName = rawName.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\u0000/g, '');
          const normalizedBytes = Buffer.byteLength(normalizedName, 'utf8');
          if (
            normalizedName &&
            entries.length < ZIP_MAX_VISIBLE_ENTRIES &&
            visibleNameBytes + normalizedBytes <= ZIP_MAX_VISIBLE_NAME_BYTES
          ) {
            visibleNameBytes += normalizedBytes;
            entries.push({
              name: normalizedName,
              directory: normalizedName.endsWith('/'),
              compressedSize: Number(entry.compressedSize || 0),
              uncompressedSize: Number(entry.uncompressedSize || 0),
              modifiedAt: zipEntryDate(entry)
            });
          } else if (normalizedName) {
            omittedEntries = true;
          }
        }
        zipfile.readEntry();
      });

      zipfile.on('end', () => finish(() => resolve({
        kind: 'zip',
        encrypted,
        entries: encrypted ? [] : entries,
        totalEntries,
        totalCompressedSize,
        totalUncompressedSize,
        truncated: !encrypted && (omittedEntries || totalEntries > entries.length)
      })));

      zipfile.on('error', (error) => finish(() => {
        if (encrypted || encryptedZipError(error)) {
          resolve({ kind: 'zip', encrypted: true, entries: [], totalEntries, truncated: false });
          return;
        }
        reject(new FilePreviewError('INVALID_ZIP', `The ZIP archive could not be read: ${error.message}`));
      }));
      zipfile.readEntry();
    });
  });
}

export function createZipPreview(source, stats) {
  return withPreviewSlot('zip', () => {
    const resolvedSource = typeof source === 'function' ? source() : source;
    return buildZipPreview(resolvedSource, stats);
  });
}

function normalizedPositiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function validateSevenZipWorkerPreview(value, options = {}) {
  const maxVisibleEntries = Math.min(
    SEVEN_ZIP_MAX_VISIBLE_ENTRIES,
    normalizedPositiveInteger(
      options.maxVisibleEntries,
      SEVEN_ZIP_MAX_VISIBLE_ENTRIES,
      1,
      SEVEN_ZIP_MAX_VISIBLE_ENTRIES
    )
  );
  if (!value || value.kind !== '7z' || value.metadataOnly !== true || value.parserEngine !== 'javascript') {
    throw new FilePreviewError('INVALID_7Z', 'The JavaScript 7z parser returned an invalid response.');
  }
  if (!Array.isArray(value.entries) || value.entries.length > maxVisibleEntries) {
    throw new FilePreviewError('SEVEN_ZIP_METADATA_LIMIT', 'The JavaScript 7z parser returned too many entries.');
  }

  let visibleNameBytes = 0;
  const entries = value.entries.map((entry) => {
    const name = String(entry?.name || '');
    const nameBytes = Buffer.byteLength(name, 'utf8');
    visibleNameBytes += nameBytes;
    if (
      !name
      || nameBytes > SEVEN_ZIP_MAX_ENTRY_NAME_BYTES
      || visibleNameBytes > SEVEN_ZIP_MAX_VISIBLE_NAME_BYTES
      || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)
    ) {
      throw new FilePreviewError('SEVEN_ZIP_METADATA_LIMIT', 'The JavaScript 7z parser returned unsafe entry metadata.');
    }
    return {
      name,
      directory: entry?.directory === true,
      compressedSize: Number.isSafeInteger(entry?.compressedSize) && entry.compressedSize >= 0
        ? entry.compressedSize
        : 0,
      uncompressedSize: Number.isSafeInteger(entry?.uncompressedSize) && entry.uncompressedSize >= 0
        ? entry.uncompressedSize
        : 0,
      modifiedAt: typeof entry?.modifiedAt === 'string' && entry.modifiedAt.length <= 64
        ? entry.modifiedAt
        : null
    };
  });

  const encrypted = value.encrypted === true;
  if (encrypted && entries.length !== 0) {
    throw new FilePreviewError('INVALID_7Z', 'Encrypted 7z metadata must not expose archive entries.');
  }

  const safeTotal = (candidate) => (
    Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0
  );
  return {
    kind: '7z',
    metadataOnly: true,
    parserEngine: 'javascript',
    encrypted,
    entries: encrypted ? [] : entries,
    totalEntries: encrypted ? 0 : safeTotal(value.totalEntries),
    totalEntriesExact: encrypted ? false : value.totalEntriesExact === true,
    totalCompressedSize: safeTotal(value.totalCompressedSize),
    totalUncompressedSize: encrypted ? 0 : safeTotal(value.totalUncompressedSize),
    totalsExact: encrypted ? false : value.totalsExact === true,
    truncated: encrypted ? false : value.truncated === true
  };
}

function inspectSevenZipWithJavaScriptParser(source, stats, options) {
  const timeoutMs = normalizedPositiveInteger(
    options.timeoutMs,
    SEVEN_ZIP_DEFAULT_TIMEOUT_MS,
    1000,
    300 * 1000
  );
  const maxHeaderBytes = normalizedPositiveInteger(
    options.maxHeaderBytes,
    SEVEN_ZIP_DEFAULT_MAX_HEADER_BYTES,
    64 * 1024,
    SEVEN_ZIP_MAX_HEADER_BYTES
  );
  const maxCompressedHeaderBytes = normalizedPositiveInteger(
    options.maxCompressedHeaderBytes,
    Math.min(maxHeaderBytes, 128 * 1024 * 1024),
    64 * 1024,
    Math.min(maxHeaderBytes, SEVEN_ZIP_MAX_HEADER_BYTES)
  );
  const maxSingleReadBytes = normalizedPositiveInteger(
    options.maxSingleReadBytes,
    Math.min(320 * 1024 * 1024, Math.max(maxHeaderBytes, maxCompressedHeaderBytes) + 1024 * 1024),
    64 * 1024,
    320 * 1024 * 1024
  );
  const maxTotalReadBytes = normalizedPositiveInteger(
    options.maxTotalReadBytes,
    Math.min(1024 * 1024 * 1024, (maxHeaderBytes * 3) + maxCompressedHeaderBytes + (16 * 1024 * 1024)),
    1024 * 1024,
    1024 * 1024 * 1024
  );
  const maxScannedEntries = normalizedPositiveInteger(
    options.maxScannedEntries,
    100_000,
    1,
    SEVEN_ZIP_MAX_SCANNED_ENTRIES
  );
  const workerOldGenerationMb = Math.min(640, Math.max(256, 128 + Math.ceil(maxHeaderBytes / (512 * 1024))));
  const expectedSize = sourceSize(source, stats);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 32) {
    throw new FilePreviewError('INVALID_7Z', 'The 7z archive size is invalid.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let receivedMessage = false;
    const worker = new Worker(new URL('./seven-zip-parser-worker.js', import.meta.url), {
      workerData: {
        filePath: source,
        expectedSize,
        options: {
          maxVisibleEntries: options.maxVisibleEntries,
          maxScannedEntries,
          maxEntryNameBytes: SEVEN_ZIP_MAX_ENTRY_NAME_BYTES,
          maxVisibleNameBytes: SEVEN_ZIP_MAX_VISIBLE_NAME_BYTES,
          maxHeaderBytes,
          maxCompressedHeaderBytes,
          maxSingleReadBytes,
          maxTotalReadBytes
        }
      },
      env: { LZMA_NATIVE_DISABLE: '1' },
      execArgv: process.execArgv.filter((argument) => !/^(?:--input-type|--max-old-space-size|--max_old_space_size|--max-semi-space-size|--max_semi_space_size)(?:=|$)/u.test(argument)),
      name: 'recorddrive-7z',
      resourceLimits: {
        maxOldGenerationSizeMb: workerOldGenerationMb,
        maxYoungGenerationSizeMb: 32,
        codeRangeSizeMb: 32,
        stackSizeMb: 8
      },
      trackUnmanagedFds: true
    });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new FilePreviewError('SEVEN_ZIP_TIMEOUT', 'The JavaScript 7z parser exceeded its time limit.'));
      });
    }, timeoutMs);
    timer.unref?.();

    worker.once('message', (message) => {
      receivedMessage = true;
      finish(() => {
        void worker.terminate();
        if (!message?.ok) {
          const code = message?.error?.code === 'SEVEN_ZIP_METADATA_LIMIT'
            ? 'SEVEN_ZIP_METADATA_LIMIT'
            : 'INVALID_7Z';
          reject(new FilePreviewError(code, String(message?.error?.message || 'The 7z archive could not be parsed.')));
          return;
        }
        try {
          resolve(validateSevenZipWorkerPreview(message.preview, options));
        } catch (error) {
          reject(error);
        }
      });
    });

    worker.once('error', (error) => {
      finish(() => {
        const code = error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? 'SEVEN_ZIP_METADATA_LIMIT'
          : 'INVALID_7Z';
        reject(new FilePreviewError(code, `The JavaScript 7z parser failed: ${error.message}`));
      });
    });

    worker.once('exit', (code) => {
      if (settled || receivedMessage) return;
      finish(() => reject(new FilePreviewError(
        code === 0 ? 'INVALID_7Z' : 'SEVEN_ZIP_METADATA_LIMIT',
        `The JavaScript 7z parser stopped before returning metadata (exit ${code}).`
      )));
    });
  });
}

async function buildSevenZipPreview(source, stats, options = {}) {
  if (options.enabled === false) {
    throw new FilePreviewError(
      'SEVEN_ZIP_DISABLED',
      '7z preview is disabled by the server security policy.'
    );
  }
  if (typeof source !== 'string' || !source) {
    throw new FilePreviewError('INVALID_7Z', '7z previews require a server-side archive path.');
  }
  return inspectSevenZipWithJavaScriptParser(source, stats, options);
}

export function createSevenZipPreview(source, stats, options = {}) {
  return withPreviewSlot('7z', () => {
    const resolvedSource = typeof source === 'function' ? source() : source;
    return buildSevenZipPreview(resolvedSource, stats, options);
  });
}

