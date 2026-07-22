import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

// Defense in depth. The bundled xz-compat fork cannot load native add-ons, but
// force the upstream-compatible switch before importing the parser as well.
process.env.LZMA_NATIVE_DISABLE = '1';

function verifyPureJavaScriptParserSupplyChain() {
  const require = createRequire(import.meta.url);
  const parserPackage = JSON.parse(fs.readFileSync(require.resolve('7z-iterator/package.json'), 'utf8'));
  const decoderPackagePath = require.resolve('xz-compat/package.json');
  const decoderPackage = JSON.parse(fs.readFileSync(decoderPackagePath, 'utf8'));
  if (parserPackage.version !== '2.2.9') {
    throw new Error('Unexpected 7z-iterator version. Refusing to parse archives.');
  }
  if (
    decoderPackage.version !== '1.2.7-recorddrive.1'
    || decoderPackage.recorddriveSecurity?.nativeAddons !== false
    || decoderPackage.recorddriveSecurity?.runtimePackageInstallation !== false
  ) {
    throw new Error('The hardened pure-JavaScript xz decoder is not installed.');
  }
  const decoderRoot = path.dirname(decoderPackagePath);
  const pending = [decoderRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed inside the hardened xz decoder.');
      }
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.(?:node|dll|exe|wasm)$/iu.test(entry.name)) {
        throw new Error('Native or WebAssembly parser payloads are not allowed.');
      }
    }
  }
}

verifyPureJavaScriptParserSupplyChain();
const { SevenZipParser } = await import('7z-iterator');

const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SIGNATURE_HEADER_SIZE = 32;
const PROPERTY = Object.freeze({
  END: 0x00,
  HEADER: 0x01,
  PACK_INFO: 0x06,
  UNPACK_INFO: 0x07,
  SUBSTREAMS_INFO: 0x08,
  SIZE: 0x09,
  CRC: 0x0a,
  FOLDER: 0x0b,
  CODERS_UNPACK_SIZE: 0x0c,
  ENCODED_HEADER: 0x17
});
const CODEC = Object.freeze({
  COPY: '00',
  LZMA: '030101',
  LZMA2: '21',
  AES: '06f10701'
});
const BIDI_AND_CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

class ParserLimitError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SEVEN_ZIP_METADATA_LIMIT';
  }
}

class InvalidArchiveError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_7Z';
  }
}

function safeInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function bigintToSafeNumber(value, label) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidArchiveError(`${label} exceeds the supported integer range.`);
  }
  return Number(value);
}

class Cursor {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  ensure(length, label = '7z header') {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.buffer.length) {
      throw new InvalidArchiveError(`Truncated ${label}.`);
    }
  }

  byte(label) {
    this.ensure(1, label);
    return this.buffer[this.offset++];
  }

  bytes(length, label) {
    this.ensure(length, label);
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  uint32(label) {
    this.ensure(4, label);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  number(label, maximum = Number.MAX_SAFE_INTEGER) {
    const first = this.byte(label);
    if (first === 0xff) {
      this.ensure(8, label);
      const value = this.buffer.readBigUInt64LE(this.offset);
      this.offset += 8;
      const number = bigintToSafeNumber(value, label);
      if (number > maximum) {
        throw new ParserLimitError(`${label} (${number}) exceeds its safety limit (${maximum}).`);
      }
      return number;
    }

    let extraBytes = 0;
    let marker = 0x80;
    while ((first & marker) !== 0 && extraBytes < 8) {
      extraBytes += 1;
      marker >>>= 1;
    }
    if (extraBytes > 7) throw new InvalidArchiveError(`Invalid ${label}.`);

    this.ensure(extraBytes, label);
    let value = BigInt(first & (marker - 1));
    for (let index = 0; index < extraBytes; index += 1) {
      value = (value << 8n) | BigInt(this.buffer[this.offset + extraBytes - 1 - index]);
    }
    this.offset += extraBytes;
    const number = bigintToSafeNumber(value, label);
    if (number > maximum) {
      throw new ParserLimitError(`${label} (${number}) exceeds its safety limit (${maximum}).`);
    }
    return number;
  }
}

class BoundedFileSource {
  constructor(filePath, limits) {
    this.fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(this.fd);
    if (!stat.isFile()) {
      this.close();
      throw new InvalidArchiveError('The 7z source is not a regular file.');
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < SIGNATURE_HEADER_SIZE) {
      this.close();
      throw new InvalidArchiveError('The 7z archive is too small or too large to address safely.');
    }
    this.size = stat.size;
    this.maxSingleReadBytes = limits.maxSingleReadBytes;
    this.maxTotalReadBytes = limits.maxTotalReadBytes;
    this.totalReadBytes = 0;
    this.closed = false;
  }

  read(position, length) {
    if (this.closed) throw new InvalidArchiveError('The 7z source is closed.');
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
      throw new InvalidArchiveError('Invalid 7z read range.');
    }
    if (length > this.maxSingleReadBytes) {
      throw new ParserLimitError('A 7z metadata read exceeded its per-read safety limit.');
    }
    if (position > this.size) {
      throw new InvalidArchiveError('A 7z metadata read points outside the archive.');
    }
    const availableLength = Math.min(length, this.size - position);
    if (this.totalReadBytes + availableLength > this.maxTotalReadBytes) {
      throw new ParserLimitError('7z metadata reads exceeded the cumulative safety limit.');
    }

    const output = Buffer.alloc(availableLength);
    let readTotal = 0;
    while (readTotal < availableLength) {
      const count = fs.readSync(this.fd, output, readTotal, availableLength - readTotal, position + readTotal);
      if (count === 0) break;
      readTotal += count;
    }
    this.totalReadBytes += readTotal;
    return readTotal === availableLength ? output : output.subarray(0, readTotal);
  }

  getSize() {
    return this.size;
  }

  createReadStream() {
    throw new InvalidArchiveError('Entry extraction is disabled for 7z previews.');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== undefined) fs.closeSync(this.fd);
  }
}

function readDefinedVector(cursor, count, label) {
  const allDefined = cursor.byte(label) !== 0;
  if (allDefined) return count;
  const bytes = cursor.bytes(Math.ceil(count / 8), label);
  let defined = 0;
  for (let index = 0; index < count; index += 1) {
    if ((bytes[Math.floor(index / 8)] & (0x80 >>> (index % 8))) !== 0) defined += 1;
  }
  return defined;
}

function codecKey(id) {
  return Buffer.from(id).toString('hex');
}

function parseFolder(cursor, limits) {
  const coderCount = cursor.number('encoded-header coder count', limits.maxCoders);
  if (coderCount < 1) throw new InvalidArchiveError('The encoded header has no coder.');

  const coders = [];
  let inputStreams = 0;
  let outputStreams = 0;
  for (let index = 0; index < coderCount; index += 1) {
    const flags = cursor.byte('encoded-header coder flags');
    if ((flags & 0x80) !== 0) {
      throw new InvalidArchiveError('Alternative encoded-header coder methods are not supported.');
    }
    const idSize = flags & 0x0f;
    if (idSize < 1 || idSize > 8) throw new InvalidArchiveError('Invalid encoded-header codec identifier.');
    const complex = (flags & 0x10) !== 0;
    const hasProperties = (flags & 0x20) !== 0;
    const id = cursor.bytes(idSize, 'encoded-header codec identifier');
    const inputs = complex ? cursor.number('encoded-header input stream count', limits.maxStreams) : 1;
    const outputs = complex ? cursor.number('encoded-header output stream count', limits.maxStreams) : 1;
    if (inputs < 1 || outputs < 1) throw new InvalidArchiveError('Invalid encoded-header stream count.');

    let properties = Buffer.alloc(0);
    if (hasProperties) {
      const propertySize = cursor.number('encoded-header coder properties', limits.maxCoderPropertyBytes);
      properties = cursor.bytes(propertySize, 'encoded-header coder properties');
    }

    coders.push({ id, properties, inputs, outputs });
    inputStreams += inputs;
    outputStreams += outputs;
    if (inputStreams > limits.maxStreams || outputStreams > limits.maxStreams) {
      throw new ParserLimitError('The encoded header has too many coder streams.');
    }
  }

  const bindPairCount = outputStreams - 1;
  for (let index = 0; index < bindPairCount; index += 1) {
    cursor.number('encoded-header bind input', limits.maxStreams);
    cursor.number('encoded-header bind output', limits.maxStreams);
  }
  const packedStreamCount = inputStreams - bindPairCount;
  if (packedStreamCount < 1 || packedStreamCount > limits.maxStreams) {
    throw new InvalidArchiveError('Invalid encoded-header packed stream count.');
  }
  if (packedStreamCount !== 1) {
    for (let index = 0; index < packedStreamCount; index += 1) {
      cursor.number('encoded-header packed stream index', limits.maxStreams);
    }
  }

  return { coders, outputStreams };
}

function parsePackInfo(cursor, limits) {
  const packPosition = cursor.number('encoded-header pack position');
  const packStreamCount = cursor.number('encoded-header pack stream count', limits.maxPackStreams);
  if (packStreamCount < 1) throw new InvalidArchiveError('The encoded header has no packed stream.');
  const packSizes = [];

  while (cursor.remaining() > 0) {
    const property = cursor.byte('encoded-header PackInfo property');
    if (property === PROPERTY.END) break;
    if (property === PROPERTY.SIZE) {
      for (let index = 0; index < packStreamCount; index += 1) {
        packSizes.push(cursor.number('encoded-header packed size', limits.maxCompressedHeaderBytes));
      }
      continue;
    }
    if (property === PROPERTY.CRC) {
      const defined = readDefinedVector(cursor, packStreamCount, 'encoded-header packed CRC vector');
      cursor.bytes(defined * 4, 'encoded-header packed CRC values');
      continue;
    }
    throw new InvalidArchiveError(`Unsupported encoded-header PackInfo property: ${property}.`);
  }

  if (packSizes.length !== packStreamCount) {
    throw new InvalidArchiveError('The encoded header does not provide every packed size.');
  }
  const packedBytes = packSizes.reduce((total, size) => total + size, 0);
  if (!Number.isSafeInteger(packedBytes) || packedBytes > limits.maxCompressedHeaderBytes) {
    throw new ParserLimitError('The compressed 7z metadata header is too large.');
  }
  return { packPosition, packStreamCount, packSizes, packedBytes };
}

function parseUnpackInfo(cursor, limits) {
  const folders = [];
  let sawFolders = false;
  let sawUnpackSizes = false;

  while (cursor.remaining() > 0) {
    const property = cursor.byte('encoded-header UnpackInfo property');
    if (property === PROPERTY.END) break;
    if (property === PROPERTY.FOLDER) {
      if (sawFolders) throw new InvalidArchiveError('Duplicate encoded-header Folder block.');
      sawFolders = true;
      const folderCount = cursor.number('encoded-header folder count', limits.maxFolders);
      if (folderCount < 1) throw new InvalidArchiveError('The encoded header has no folder.');
      if (cursor.byte('encoded-header external-folder flag') !== 0) {
        throw new InvalidArchiveError('External encoded-header folders are not supported.');
      }
      for (let index = 0; index < folderCount; index += 1) {
        folders.push(parseFolder(cursor, limits));
      }
      continue;
    }
    if (property === PROPERTY.CODERS_UNPACK_SIZE) {
      if (!sawFolders || sawUnpackSizes) throw new InvalidArchiveError('Invalid encoded-header unpack-size block.');
      sawUnpackSizes = true;
      for (const folder of folders) {
        folder.unpackSizes = [];
        for (let index = 0; index < folder.outputStreams; index += 1) {
          folder.unpackSizes.push(cursor.number('encoded-header unpacked size', limits.maxHeaderBytes));
        }
      }
      continue;
    }
    if (property === PROPERTY.CRC) {
      if (!sawFolders) throw new InvalidArchiveError('Invalid encoded-header CRC block.');
      const defined = readDefinedVector(cursor, folders.length, 'encoded-header unpacked CRC vector');
      cursor.bytes(defined * 4, 'encoded-header unpacked CRC values');
      continue;
    }
    throw new InvalidArchiveError(`Unsupported encoded-header UnpackInfo property: ${property}.`);
  }

  if (!sawFolders || !sawUnpackSizes) {
    throw new InvalidArchiveError('The encoded header is missing folder or unpack-size information.');
  }
  return folders;
}

function inspectEncodedHeader(buffer, limits) {
  const cursor = new Cursor(buffer);
  if (cursor.byte('next header type') !== PROPERTY.ENCODED_HEADER) return { encrypted: false, encoded: false };

  let packInfo = null;
  let folders = null;
  while (cursor.remaining() > 0) {
    const property = cursor.byte('encoded-header property');
    if (property === PROPERTY.END) break;
    if (property === PROPERTY.PACK_INFO) {
      if (packInfo) throw new InvalidArchiveError('Duplicate encoded-header PackInfo block.');
      packInfo = parsePackInfo(cursor, limits);
      continue;
    }
    if (property === PROPERTY.UNPACK_INFO) {
      if (folders) throw new InvalidArchiveError('Duplicate encoded-header UnpackInfo block.');
      folders = parseUnpackInfo(cursor, limits);
      continue;
    }
    if (property === PROPERTY.SUBSTREAMS_INFO) {
      throw new InvalidArchiveError('Encoded-header substreams are not supported for metadata preview.');
    }
    throw new InvalidArchiveError(`Unsupported encoded-header property: ${property}.`);
  }

  if (!packInfo || !folders || folders.length !== 1 || packInfo.packStreamCount !== 1) {
    throw new InvalidArchiveError('Only a single bounded encoded-header stream is supported.');
  }
  const coders = folders[0].coders;
  const encrypted = coders.some((coder) => codecKey(coder.id) === CODEC.AES);
  if (encrypted) return { encrypted: true, encoded: true };
  if (coders.length !== 1) {
    throw new InvalidArchiveError('Complex encoded-header coder chains are not supported.');
  }

  const coder = coders[0];
  const key = codecKey(coder.id);
  if (![CODEC.COPY, CODEC.LZMA, CODEC.LZMA2].includes(key)) {
    throw new InvalidArchiveError(`Unsupported encoded-header codec: ${key}.`);
  }
  if (key === CODEC.COPY && coder.properties.length !== 0) {
    throw new InvalidArchiveError('COPY encoded headers must not have coder properties.');
  }
  if (key === CODEC.LZMA && coder.properties.length !== 5) {
    throw new InvalidArchiveError('LZMA encoded headers require five property bytes.');
  }
  if (key === CODEC.LZMA2 && coder.properties.length !== 1) {
    throw new InvalidArchiveError('LZMA2 encoded headers require one property byte.');
  }

  const unpackSize = folders[0].unpackSizes.at(-1);
  if (!Number.isSafeInteger(unpackSize) || unpackSize < 1 || unpackSize > limits.maxHeaderBytes) {
    throw new ParserLimitError('The expanded 7z metadata header is too large.');
  }

  return { encrypted: false, encoded: true, ...packInfo, unpackSize };
}

function inspectSignatureAndHeader(source, limits) {
  const signatureHeader = source.read(0, SIGNATURE_HEADER_SIZE);
  if (signatureHeader.length !== SIGNATURE_HEADER_SIZE || !signatureHeader.subarray(0, 6).equals(SIGNATURE)) {
    throw new InvalidArchiveError('Not a valid 7z archive.');
  }
  if (signatureHeader[6] !== 0) {
    throw new InvalidArchiveError(`Unsupported 7z major version: ${signatureHeader[6]}.`);
  }
  if (signatureHeader.readUInt32LE(8) !== crc32(signatureHeader.subarray(12, 32))) {
    throw new InvalidArchiveError('The 7z start header CRC is invalid.');
  }

  const nextOffset = bigintToSafeNumber(signatureHeader.readBigUInt64LE(12), 'Next Header Offset');
  const nextSize = bigintToSafeNumber(signatureHeader.readBigUInt64LE(20), 'Next Header Size');
  if (nextSize < 1 || nextSize > limits.maxHeaderBytes) {
    throw new ParserLimitError('The 7z next header exceeds the metadata safety limit.');
  }
  const absoluteOffset = SIGNATURE_HEADER_SIZE + nextOffset;
  if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset > source.getSize() || nextSize > source.getSize() - absoluteOffset) {
    throw new InvalidArchiveError('The 7z next header points outside the archive.');
  }

  const nextHeader = source.read(absoluteOffset, nextSize);
  if (signatureHeader.readUInt32LE(28) !== crc32(nextHeader)) {
    throw new InvalidArchiveError('The 7z next header CRC is invalid.');
  }
  const encoded = inspectEncodedHeader(nextHeader, limits);
  if (encoded.encoded && !encoded.encrypted) {
    if (encoded.packPosition > nextOffset || encoded.packedBytes > nextOffset - encoded.packPosition) {
      throw new InvalidArchiveError('The compressed metadata header points outside the packed-data area.');
    }
  }
  return encoded;
}

function streamInfoUsesAes(streamsInfo) {
  return Boolean(streamsInfo?.folders?.some((folder) => (
    folder?.coders?.some((coder) => codecKey(coder.id) === CODEC.AES)
  )));
}

function sanitizeArchivePath(value) {
  const raw = String(value ?? '').normalize('NFC').replace(/\\/g, '/');
  if (!raw || BIDI_AND_CONTROL.test(raw) || /^[a-zA-Z]:\//u.test(raw) || /^\//u.test(raw)) return null;
  const parts = raw.split('/');
  if (parts.some((part) => part === '..')) return null;
  const normalized = parts.filter((part) => part && part !== '.').join('/');
  return normalized || null;
}

function safeTimestamp(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

function addCapped(total, value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return total;
  return Math.min(Number.MAX_SAFE_INTEGER, total + number);
}

async function parseArchive() {
  const options = workerData?.options || {};
  const limits = {
    maxHeaderBytes: safeInteger(options.maxHeaderBytes, 128 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
    maxCompressedHeaderBytes: safeInteger(options.maxCompressedHeaderBytes, 128 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
    maxSingleReadBytes: safeInteger(options.maxSingleReadBytes, 160 * 1024 * 1024, 64 * 1024, 320 * 1024 * 1024),
    maxTotalReadBytes: safeInteger(options.maxTotalReadBytes, 512 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
    maxCoders: 8,
    maxStreams: 16,
    maxPackStreams: 4,
    maxFolders: 4,
    maxCoderPropertyBytes: 4096
  };
  const maxScannedEntries = safeInteger(options.maxScannedEntries, 100_000, 1, 250_000);
  const maxVisibleEntries = Math.min(
    maxScannedEntries,
    safeInteger(options.maxVisibleEntries, 2500, 1, 2500)
  );
  const maxEntryNameBytes = safeInteger(options.maxEntryNameBytes, 1024, 64, 8192);
  const maxVisibleNameBytes = safeInteger(options.maxVisibleNameBytes, 1024 * 1024, 4096, 8 * 1024 * 1024);

  const source = new BoundedFileSource(workerData.filePath, limits);
  let parser;
  try {
    if (Number.isSafeInteger(workerData.expectedSize) && workerData.expectedSize !== source.getSize()) {
      throw new InvalidArchiveError('The 7z source changed before metadata parsing began.');
    }
    const encoded = inspectSignatureAndHeader(source, limits);
    if (encoded.encrypted) {
      return {
        kind: '7z',
        metadataOnly: true,
        parserEngine: 'javascript',
        encrypted: true,
        entries: [],
        totalEntries: 0,
        totalEntriesExact: false,
        totalCompressedSize: source.getSize(),
        totalUncompressedSize: 0,
        totalsExact: false,
        truncated: false
      };
    }

    parser = new SevenZipParser(source);
    await parser.parse();

    if (streamInfoUsesAes(parser.streamsInfo)) {
      return {
        kind: '7z',
        metadataOnly: true,
        parserEngine: 'javascript',
        encrypted: true,
        entries: [],
        totalEntries: 0,
        totalEntriesExact: false,
        totalCompressedSize: source.getSize(),
        totalUncompressedSize: 0,
        totalsExact: false,
        truncated: false
      };
    }

    const parsedEntries = parser.getEntries();
    const scannedEntryCount = Math.min(parsedEntries.length, maxScannedEntries);
    const scanLimited = parsedEntries.length > scannedEntryCount;

    const entries = [];
    let totalEntries = 0;
    let totalUncompressedSize = 0;
    let visibleNameBytes = 0;
    let omitted = scanLimited;

    for (let index = 0; index < scannedEntryCount; index += 1) {
      const parsed = parsedEntries[index];
      if (parsed?.isAntiFile) {
        omitted = true;
        continue;
      }
      totalEntries += 1;
      totalUncompressedSize = addCapped(totalUncompressedSize, parsed?.size);
      const name = sanitizeArchivePath(parsed?.path);
      if (!name) {
        omitted = true;
        continue;
      }
      const nameBytes = Buffer.byteLength(name, 'utf8');
      if (nameBytes > maxEntryNameBytes) {
        omitted = true;
        continue;
      }
      if (entries.length >= maxVisibleEntries || visibleNameBytes + nameBytes > maxVisibleNameBytes) {
        omitted = true;
        continue;
      }
      visibleNameBytes += nameBytes;
      entries.push({
        name,
        directory: parsed?.type === 'directory',
        compressedSize: 0,
        uncompressedSize: Number.isSafeInteger(parsed?.size) && parsed.size >= 0 ? parsed.size : 0,
        modifiedAt: safeTimestamp(parsed?.mtime)
      });
    }

    return {
      kind: '7z',
      metadataOnly: true,
      parserEngine: 'javascript',
      encrypted: false,
      entries,
      totalEntries,
      totalEntriesExact: !scanLimited,
      totalCompressedSize: source.getSize(),
      totalUncompressedSize,
      totalsExact: !scanLimited,
      truncated: omitted || entries.length < totalEntries
    };
  } finally {
    try {
      parser?.close?.();
    } catch {
      // The bounded source is closed below regardless of parser cleanup.
    }
    source.close();
  }
}

try {
  const preview = await parseArchive();
  parentPort.postMessage({ ok: true, preview });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code === 'SEVEN_ZIP_METADATA_LIMIT' ? 'SEVEN_ZIP_METADATA_LIMIT' : 'INVALID_7Z',
      message: String(error?.message || 'The 7z archive could not be parsed.').slice(0, 1024)
    }
  });
}
