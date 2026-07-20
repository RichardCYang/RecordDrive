import fs from 'node:fs';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
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
const SEVEN_ZIP_MAX_SCANNED_ENTRIES = 10000;
const SEVEN_ZIP_MAX_ENTRY_NAME_BYTES = 1024;
const SEVEN_ZIP_MAX_VISIBLE_NAME_BYTES = 1024 * 1024;
const SEVEN_ZIP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SEVEN_ZIP_DEFAULT_TIMEOUT_MS = 20 * 1000;
const PREVIEW_CONCURRENCY_LIMITS = Object.freeze({ xlsx: 2, zip: 4, '7z': 2 });
const activePreviews = { xlsx: 0, zip: 0, '7z': 0 };

export function previewFileSizeLimit(kind) {
  if (kind === 'xlsx') return XLSX_MAX_FILE_BYTES;
  if (kind === 'zip') return ZIP_MAX_FILE_BYTES;
  // 7z previews use only the archive metadata listing command and never load
  // the complete archive into memory, so compressed file size is not a gate.
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
  if (!Number.isSafeInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

function cappedArchiveNumber(value) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
}

function addCappedArchiveNumber(total, value) {
  return Math.min(Number.MAX_SAFE_INTEGER, total + cappedArchiveNumber(value));
}

function normalizeArchiveEntryName(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\u0000/g, '');
}

function sevenZipEntryDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(\.\d+)?/);
  if (!match) return null;
  return `${match[1]}T${match[2]}${match[3] || ''}`;
}

function encryptedSevenZipError(value) {
  return /password|encrypted archive|wrong password|can(?:not|'t) open encrypted/i.test(String(value || ''));
}

function sevenZipBinaryCandidates(configuredBinary) {
  const configured = String(configuredBinary || '').trim();
  if (configured) return [configured];
  return process.platform === 'win32'
    ? ['7zz.exe', '7z.exe', '7za.exe']
    : ['7zz', '7z', '7za'];
}

function sevenZipChildEnvironment() {
  const allowedKeys = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR'];
  const environment = {};
  for (const key of allowedKeys) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  if (process.platform !== 'win32') {
    environment.LANG = 'C.UTF-8';
    environment.LC_ALL = 'C.UTF-8';
  }
  return environment;
}

function inspectSevenZipWithBinary(binary, source, stats, options) {
  const timeoutMs = normalizedPositiveInteger(
    options.timeoutMs,
    SEVEN_ZIP_DEFAULT_TIMEOUT_MS,
    1000,
    120 * 1000
  );
  const maxOutputBytes = normalizedPositiveInteger(
    options.maxOutputBytes,
    SEVEN_ZIP_MAX_OUTPUT_BYTES,
    64 * 1024,
    64 * 1024 * 1024
  );
  const maxScannedEntries = normalizedPositiveInteger(
    options.maxScannedEntries,
    SEVEN_ZIP_MAX_SCANNED_ENTRIES,
    1,
    100000
  );
  const maxVisibleEntries = Math.min(
    maxScannedEntries,
    normalizedPositiveInteger(
      options.maxVisibleEntries,
      SEVEN_ZIP_MAX_VISIBLE_ENTRIES,
      1,
      SEVEN_ZIP_MAX_VISIBLE_ENTRIES
    )
  );

  return new Promise((resolve, reject) => {
    const child = spawn(binary, [
      'l',
      '-slt',
      '-sccUTF-8',
      '-bso1',
      '-bse2',
      '-bsp0',
      '-y',
      '--',
      source
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sevenZipChildEnvironment()
    });

    const decoder = new StringDecoder('utf8');
    let settled = false;
    let timer = null;
    let outputBytes = 0;
    let lineBuffer = '';
    let diagnostic = '';
    let inEntrySection = false;
    let fields = Object.create(null);
    let archiveProperties = Object.create(null);
    let totalEntries = 0;
    let totalCompressedSize = 0;
    let totalUncompressedSize = 0;
    let visibleNameBytes = 0;
    let encrypted = false;
    let omittedEntries = false;
    let stopReason = '';
    const entries = [];

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    const stopChild = (reason) => {
      if (!stopReason) stopReason = reason;
      if (!child.killed) child.kill('SIGKILL');
    };

    const appendDiagnostic = (value) => {
      if (diagnostic.length >= 64 * 1024) return;
      diagnostic += String(value).slice(0, (64 * 1024) - diagnostic.length);
    };

    const processEntry = (entryFields) => {
      const normalizedName = normalizeArchiveEntryName(entryFields.Path);
      if (!normalizedName) return;

      totalEntries += 1;
      totalCompressedSize = addCappedArchiveNumber(totalCompressedSize, entryFields['Packed Size']);
      totalUncompressedSize = addCappedArchiveNumber(totalUncompressedSize, entryFields.Size);

      if (String(entryFields.Encrypted || '').trim() === '+') {
        encrypted = true;
        stopChild('encrypted');
        return;
      }

      if (totalEntries > maxScannedEntries) {
        omittedEntries = true;
        stopChild('metadata-limit');
        return;
      }

      const nameBytes = Buffer.byteLength(normalizedName, 'utf8');
      if (nameBytes > SEVEN_ZIP_MAX_ENTRY_NAME_BYTES) {
        omittedEntries = true;
        return;
      }

      const directory = String(entryFields.Folder || '').trim() === '+'
        || normalizedName.endsWith('/')
        || /^D/i.test(String(entryFields.Attributes || '').trim());

      if (
        entries.length >= maxVisibleEntries
        || visibleNameBytes + nameBytes > SEVEN_ZIP_MAX_VISIBLE_NAME_BYTES
      ) {
        omittedEntries = true;
        return;
      }

      visibleNameBytes += nameBytes;
      entries.push({
        name: normalizedName,
        directory,
        compressedSize: cappedArchiveNumber(entryFields['Packed Size']),
        uncompressedSize: cappedArchiveNumber(entryFields.Size),
        modifiedAt: sevenZipEntryDate(entryFields.Modified)
      });
    };

    const flushFields = () => {
      if (!Object.keys(fields).length) return;
      if (inEntrySection) processEntry(fields);
      else archiveProperties = { ...archiveProperties, ...fields };
      fields = Object.create(null);
    };

    const processLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (/^-{5,}\s*$/.test(line)) {
        flushFields();
        inEntrySection = true;
        return;
      }
      if (!line.trim()) {
        flushFields();
        return;
      }
      const separator = line.indexOf(' = ');
      if (separator <= 0) return;
      fields[line.slice(0, separator)] = line.slice(separator + 3);
    };

    const consumeText = (value, final = false) => {
      lineBuffer += value;
      const lines = lineBuffer.split('\n');
      if (!final) lineBuffer = lines.pop();
      else lineBuffer = '';
      for (const line of lines) processLine(line);
      if (final && lineBuffer) processLine(lineBuffer);
    };

    child.stdout.on('data', (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        const decoded = decoder.write(accepted);
        appendDiagnostic(decoded);
        consumeText(decoded);
      }
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        omittedEntries = true;
        stopChild('metadata-limit');
      }
    });

    child.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
      appendDiagnostic(chunk.toString('utf8'));
      if (outputBytes > maxOutputBytes) stopChild('metadata-limit');
    });

    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (exitCode, signal) => finish(() => {
      const decodedTail = decoder.end();
      appendDiagnostic(decodedTail);
      consumeText(decodedTail, true);
      flushFields();

      if (encrypted || encryptedSevenZipError(diagnostic)) {
        resolve({
          kind: '7z',
          metadataOnly: true,
          encrypted: true,
          entries: [],
          totalEntries,
          totalEntriesExact: false,
          totalCompressedSize: cappedArchiveNumber(archiveProperties['Physical Size']) || sourceSize(source, stats),
          totalUncompressedSize,
          totalsExact: false,
          truncated: false
        });
        return;
      }

      if (stopReason === 'timeout' && totalEntries === 0) {
        reject(new FilePreviewError('SEVEN_ZIP_TIMEOUT', 'The 7z metadata listing exceeded its time limit.'));
        return;
      }
      if (stopReason === 'metadata-limit' && totalEntries === 0) {
        reject(new FilePreviewError('SEVEN_ZIP_METADATA_LIMIT', 'The 7z metadata listing exceeded its safety limits.'));
        return;
      }

      const succeeded = exitCode === 0 || exitCode === 1;
      if (!succeeded && !stopReason && totalEntries === 0) {
        const detail = diagnostic.trim().split(/\r?\n/).filter(Boolean).at(-1) || `exit ${exitCode ?? signal ?? 'unknown'}`;
        reject(new FilePreviewError('INVALID_7Z', `The 7z archive could not be read: ${detail}`));
        return;
      }

      const totalEntriesExact = succeeded && !stopReason;
      const physicalSize = cappedArchiveNumber(archiveProperties['Physical Size']) || sourceSize(source, stats);
      resolve({
        kind: '7z',
        metadataOnly: true,
        encrypted: false,
        entries,
        totalEntries,
        totalEntriesExact,
        totalCompressedSize: physicalSize,
        totalUncompressedSize,
        totalsExact: totalEntriesExact,
        truncated: omittedEntries || !totalEntriesExact || totalEntries > entries.length
      });
    }));

    timer = setTimeout(() => stopChild('timeout'), timeoutMs);
    timer.unref?.();
  });
}

async function buildSevenZipPreview(source, stats, options = {}) {
  if (options.enabled !== true) {
    throw new FilePreviewError(
      'SEVEN_ZIP_DISABLED',
      '7z preview is disabled by default because it invokes a native parser on untrusted archives.'
    );
  }
  if (typeof source !== 'string' || !source) {
    throw new FilePreviewError('INVALID_7Z', '7z previews require a server-side archive path.');
  }

  let lastUnavailableError = null;
  for (const binary of sevenZipBinaryCandidates(options.binary)) {
    try {
      return await inspectSevenZipWithBinary(binary, source, stats, options);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        lastUnavailableError = error;
        continue;
      }
      throw error;
    }
  }

  throw new FilePreviewError(
    'SEVEN_ZIP_UNAVAILABLE',
    `A 7-Zip command-line executable is required for 7z previews${lastUnavailableError ? `: ${lastUnavailableError.message}` : '.'}`
  );
}

export function createSevenZipPreview(source, stats, options = {}) {
  return withPreviewSlot('7z', () => {
    const resolvedSource = typeof source === 'function' ? source() : source;
    return buildSevenZipPreview(resolvedSource, stats, options);
  });
}

