import ExcelJS from 'exceljs';
import yauzl from 'yauzl';

const XLSX_MAX_FILE_BYTES = 25 * 1024 * 1024;
const XLSX_MAX_ROWS = 200;
const XLSX_MAX_COLUMNS = 50;
const ZIP_MAX_VISIBLE_ENTRIES = 2500;
const WORKBOOK_CACHE_LIMIT = 2;
const workbookCache = new Map();

export class FilePreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FilePreviewError';
    this.code = code;
  }
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
    result[side] = {
      style: definition.style,
      color: normalizeArgb(definition.color)
    };
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

function cacheWorkbook(cacheKey, workbook) {
  workbookCache.delete(cacheKey);
  workbookCache.set(cacheKey, workbook);
  while (workbookCache.size > WORKBOOK_CACHE_LIMIT) {
    const oldestKey = workbookCache.keys().next().value;
    workbookCache.delete(oldestKey);
  }
}

async function loadWorkbook(filePath, stats) {
  if (stats.size > XLSX_MAX_FILE_BYTES) {
    throw new FilePreviewError(
      'XLSX_TOO_LARGE',
      `Spreadsheet previews are limited to ${XLSX_MAX_FILE_BYTES} bytes.`
    );
  }

  const cacheKey = `${filePath}:${stats.size}:${stats.mtimeMs}`;
  const cached = workbookCache.get(cacheKey);
  if (cached) {
    cacheWorkbook(cacheKey, cached);
    return cached;
  }

  for (const key of workbookCache.keys()) {
    if (key.startsWith(`${filePath}:`)) workbookCache.delete(key);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    throw new FilePreviewError('INVALID_XLSX', `The spreadsheet could not be read: ${error.message}`);
  }
  cacheWorkbook(cacheKey, workbook);
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

function worksheetMerges(worksheet) {
  const ranges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];
  return ranges.map((range) => {
    const match = String(range).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!match) return null;
    const toColumnNumber = (letters) => {
      let value = 0;
      for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
      return value;
    };
    return {
      startRow: Number(match[2]),
      startColumn: toColumnNumber(match[1]),
      endRow: Number(match[4]),
      endColumn: toColumnNumber(match[3])
    };
  }).filter(Boolean);
}

export async function createXlsxPreview(filePath, stats, requestedSheetIndex = 0) {
  const workbook = await loadWorkbook(filePath, stats);
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

  for (let rowNumber = 1; rowNumber <= visibleRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells = [];
    for (let columnNumber = 1; columnNumber <= visibleColumns; columnNumber += 1) {
      const cell = row.getCell(columnNumber);
      cells.push({
        value: displayCellValue(cell),
        type: cell.type,
        style: compactCellStyle(cell)
      });
    }
    rows.push(cells);
  }

  const columnWidths = [];
  for (let columnNumber = 1; columnNumber <= visibleColumns; columnNumber += 1) {
    const width = worksheet.getColumn(columnNumber).width;
    columnWidths.push(Number.isFinite(width) ? Math.max(6, Math.min(width, 60)) : null);
  }

  return {
    kind: 'xlsx',
    sheets: workbook.worksheets.map(sheetMetadata),
    sheet: {
      ...sheetMetadata(worksheet, sheetIndex),
      rows,
      columnWidths,
      merges: worksheetMerges(worksheet),
      visibleRowCount: visibleRows,
      visibleColumnCount: visibleColumns,
      truncatedRows: totalRows > visibleRows,
      truncatedColumns: totalColumns > visibleColumns
    }
  };
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
  return /encrypt|password/i.test(String(error?.message || ''));
}

export function createZipPreview(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: false
    }, (openError, zipfile) => {
      if (openError) {
        if (encryptedZipError(openError)) {
          resolve({ kind: 'zip', encrypted: true, entries: [], totalEntries: 0, truncated: false });
          return;
        }
        reject(new FilePreviewError('INVALID_ZIP', `The ZIP archive could not be read: ${openError.message}`));
        return;
      }

      const entries = [];
      let totalEntries = 0;
      let encrypted = false;
      let totalUncompressedSize = 0;
      let totalCompressedSize = 0;
      let settled = false;

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };

      zipfile.on('entry', (entry) => {
        totalEntries += 1;
        totalUncompressedSize += Number(entry.uncompressedSize || 0);
        totalCompressedSize += Number(entry.compressedSize || 0);
        if ((entry.generalPurposeBitFlag & 0x1) !== 0 || (entry.generalPurposeBitFlag & 0x40) !== 0) {
          encrypted = true;
        }

        if (!encrypted && entries.length < ZIP_MAX_VISIBLE_ENTRIES) {
          const normalizedName = String(entry.fileName || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/\u0000/g, '');
          if (normalizedName) {
            entries.push({
              name: normalizedName,
              directory: normalizedName.endsWith('/'),
              compressedSize: Number(entry.compressedSize || 0),
              uncompressedSize: Number(entry.uncompressedSize || 0),
              modifiedAt: zipEntryDate(entry)
            });
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
        truncated: !encrypted && totalEntries > entries.length
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

