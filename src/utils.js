import path from 'node:path';

export function formatBytes(bytes = 0) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(Number(bytes)) / Math.log(1024)), units.length - 1);
  const value = Number(bytes) / (1024 ** exponent);
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value.endsWith?.('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
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

export function safeOriginalName(name) {
  const normalized = path.basename(String(name || 'unnamed-file')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return normalized.slice(0, 240) || 'unnamed-file';
}

export function setFlash(req, type, message) {
  req.session.flash = { type, message };
}
