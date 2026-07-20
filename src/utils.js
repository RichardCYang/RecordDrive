import path from 'node:path';

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);
  const value = Number(bytes) / (1024 ** exponent);
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(value, locale = 'en') {
  if (!value) return '-';
  const date = new Date(value.endsWith?.('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul'
  }).format(date);
}

export function fileKind(mimeType = '', filename = '') {
  const mime = mimeType.toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('zip') || ['.zip', '.rar', '.7z', '.tar', '.gz'].includes(extension)) return 'archive';
  if (mime.includes('spreadsheet') || mime.includes('excel') || ['.xls', '.xlsx', '.csv'].includes(extension)) return 'sheet';
  if (mime.includes('presentation') || ['.ppt', '.pptx'].includes(extension)) return 'slide';
  if (mime.includes('word') || mime.startsWith('text/') || ['.doc', '.docx', '.md'].includes(extension)) return 'document';
  return 'file';
}

export function filePreviewKind(mimeType = '', filename = '') {
  const mime = String(mimeType).toLowerCase();
  const extension = path.extname(String(filename)).toLowerCase();
  if (extension === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (extension === '.xlsx' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (extension === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip';
  return '';
}

export function safeInternalPath(value, fallback = '/') {
  const candidate = String(value || '');
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return fallback;
  }

  try {
    const base = new URL('http://recorddrive.local');
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin) return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return fallback;
  }
}

export function requestWantsJson(req) {
  const requestedWith = String(req.get?.('x-requested-with') || '').toLowerCase();
  if (requestedWith === 'xmlhttprequest') return true;
  if (req.is?.('application/json')) return true;
  return req.accepts?.(['html', 'json']) === 'json';
}

export function safeOriginalName(name) {
  const normalized = path.basename(String(name || 'unnamed-file')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized.slice(0, 240) || 'unnamed-file';
}

export function setFlash(req, type, message) {
  req.session.flash = { type, message };
}
