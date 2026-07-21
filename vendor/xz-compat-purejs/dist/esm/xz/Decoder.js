/**
 * XZ Decompression Module
 *
 * XZ is a container format that wraps LZMA2 compressed data.
 * This module provides both synchronous and streaming XZ decoders.
 *
 * Pure JavaScript implementation, works on Node.js 0.8+
 *
 * IMPORTANT: Buffer Management Pattern
 *
 * When calling decodeLzma2(), use the direct return pattern:
 *
 * ✅ CORRECT - Fast path:
 *   const output = decodeLzma2(data, props, size) as Buffer;
 *
 * ❌ WRONG - Slow path (do NOT buffer):
 *   const chunks: Buffer[] = [];
 *   decodeLzma2(data, props, size, { write: c => chunks.push(c) });
 *   return Buffer.concat(chunks);  // ← Unnecessary copies!
 */ import { allocBuffer, BufferList, Transform } from 'extract-base-iterator';
import { decodeBcj } from '../filters/bcj/Bcj.js';
import { decodeBcjArm } from '../filters/bcj/BcjArm.js';
import { decodeBcjArm64 } from '../filters/bcj/BcjArm64.js';
import { decodeBcjArmt } from '../filters/bcj/BcjArmt.js';
import { decodeBcjIa64 } from '../filters/bcj/BcjIa64.js';
import { decodeBcjPpc } from '../filters/bcj/BcjPpc.js';
import { decodeBcjSparc } from '../filters/bcj/BcjSparc.js';
import { decodeDelta } from '../filters/delta/Delta.js';
import { decodeLzma2 } from '../lzma/index.js';
import { tryLoadNative } from '../native.js';
// XZ magic bytes
const XZ_MAGIC = [
    0xfd,
    0x37,
    0x7a,
    0x58,
    0x5a,
    0x00
];
const XZ_FOOTER_MAGIC = [
    0x59,
    0x5a
]; // "YZ"
// Filter IDs (from XZ specification)
const FILTER_DELTA = 0x03;
const FILTER_BCJ_X86 = 0x04;
const FILTER_BCJ_PPC = 0x05;
const FILTER_BCJ_IA64 = 0x06;
const FILTER_BCJ_ARM = 0x07;
const FILTER_BCJ_ARMT = 0x08;
const FILTER_BCJ_SPARC = 0x09;
const FILTER_BCJ_ARM64 = 0x0a;
const FILTER_LZMA2 = 0x21;
/**
 * Read a byte from Buffer or BufferList
 */ function readByte(buf, offset) {
    return Buffer.isBuffer(buf) ? buf[offset] : buf.readByte(offset);
}
/**
 * Read UInt32LE from Buffer or BufferList (returns null if out of bounds)
 */ function readUInt32LE(buf, offset) {
    if (Buffer.isBuffer(buf)) {
        if (offset < 0 || offset + 4 > buf.length) return null;
        return buf.readUInt32LE(offset);
    }
    return buf.readUInt32LEAt(offset);
}
/**
 * Compare buffer contents at offset with expected byte sequence
 * Works with both Buffer and BufferList
 */ function bufferEquals(buf, offset, expected) {
    if (offset + expected.length > buf.length) {
        return false;
    }
    for(let i = 0; i < expected.length; i++){
        if (readByte(buf, offset + i) !== expected[i]) {
            return false;
        }
    }
    return true;
}
/**
 * Decode variable-length integer (XZ multibyte encoding)
 * Works with both Buffer and BufferList
 */ function decodeMultibyte(buf, offset) {
    let value = 0;
    let i = 0;
    let byte;
    do {
        if (offset + i >= buf.length) {
            throw new Error('Truncated multibyte integer');
        }
        byte = readByte(buf, offset + i);
        value |= (byte & 0x7f) << i * 7;
        i++;
        if (i > 4) {
            throw new Error('Multibyte integer too large');
        }
    }while (byte & 0x80)
    return {
        value,
        bytesRead: i
    };
}
/**
 * Apply a preprocessing filter (BCJ/Delta) to decompressed data
 */ function applyFilter(data, filter) {
    switch(filter.id){
        case FILTER_BCJ_X86:
            return decodeBcj(data, filter.props);
        case FILTER_BCJ_ARM:
            return decodeBcjArm(data, filter.props);
        case FILTER_BCJ_ARM64:
            return decodeBcjArm64(data, filter.props);
        case FILTER_BCJ_ARMT:
            return decodeBcjArmt(data, filter.props);
        case FILTER_BCJ_PPC:
            return decodeBcjPpc(data, filter.props);
        case FILTER_BCJ_SPARC:
            return decodeBcjSparc(data, filter.props);
        case FILTER_BCJ_IA64:
            return decodeBcjIa64(data, filter.props);
        case FILTER_DELTA:
            return decodeDelta(data, filter.props);
        default:
            throw new Error(`Unsupported filter: 0x${filter.id.toString(16)}`);
    }
}
/**
 * Parse XZ Block Header to extract filters and LZMA2 properties
 */ function parseBlockHeader(input, offset, _checkSize) {
    // Block header size
    const blockHeaderSizeRaw = input[offset];
    if (blockHeaderSizeRaw === 0) {
        throw new Error('Invalid block header size (index indicator found instead of block)');
    }
    const blockHeaderSize = (blockHeaderSizeRaw + 1) * 4;
    // Parse block header
    const blockHeaderStart = offset;
    offset++; // skip size byte
    const blockFlags = input[offset++];
    const numFilters = (blockFlags & 0x03) + 1;
    const hasCompressedSize = (blockFlags & 0x40) !== 0;
    const hasUncompressedSize = (blockFlags & 0x80) !== 0;
    // Skip optional sizes
    if (hasCompressedSize) {
        const result = decodeMultibyte(input, offset);
        offset += result.bytesRead;
    }
    if (hasUncompressedSize) {
        const result = decodeMultibyte(input, offset);
        offset += result.bytesRead;
    }
    // Parse all filters
    const filters = [];
    let lzma2Props = null;
    for(let i = 0; i < numFilters; i++){
        const filterIdResult = decodeMultibyte(input, offset);
        const filterId = filterIdResult.value;
        offset += filterIdResult.bytesRead;
        const propsSizeResult = decodeMultibyte(input, offset);
        offset += propsSizeResult.bytesRead;
        const filterProps = input.slice(offset, offset + propsSizeResult.value);
        offset += propsSizeResult.value;
        if (filterId === FILTER_LZMA2) {
            // LZMA2 must be the last filter
            lzma2Props = filterProps;
        } else if (filterId === FILTER_DELTA || filterId >= FILTER_BCJ_X86 && filterId <= FILTER_BCJ_ARM64) {
            // Preprocessing filter - store for later application
            filters.push({
                id: filterId,
                props: filterProps
            });
        } else {
            throw new Error(`Unsupported filter: 0x${filterId.toString(16)}`);
        }
    }
    if (!lzma2Props) {
        throw new Error('No LZMA2 filter found in XZ block');
    }
    // Skip to end of block header (must be aligned to 4 bytes)
    const blockDataStart = blockHeaderStart + blockHeaderSize;
    return {
        filters,
        lzma2Props,
        headerSize: blockHeaderSize,
        dataStart: blockDataStart,
        dataEnd: input.length,
        nextOffset: blockDataStart
    };
}
/**
 * Parse XZ Index to get block positions
 * Works with both Buffer and BufferList
 */ function parseIndex(input, indexStart, checkSize) {
    // One-time binding for buffer access (avoids repeated Buffer.isBuffer checks)
    const getByte = Buffer.isBuffer(input) ? (offset)=>input[offset] : (offset)=>input.readByte(offset);
    // Local multibyte decoder using bound getByte
    const decodeMultibyteLocal = (offset)=>{
        let value = 0;
        let i = 0;
        let byte;
        do {
            if (offset + i >= input.length) {
                throw new Error('Truncated multibyte integer');
            }
            byte = getByte(offset + i);
            value |= (byte & 0x7f) << i * 7;
            i++;
            if (i > 4) {
                throw new Error('Multibyte integer too large');
            }
        }while (byte & 0x80)
        return {
            value,
            bytesRead: i
        };
    };
    let offset = indexStart;
    // Index indicator (0x00)
    if (getByte(offset) !== 0x00) {
        throw new Error('Invalid index indicator');
    }
    offset++;
    // Number of records
    const countResult = decodeMultibyteLocal(offset);
    const recordCount = countResult.value;
    offset += countResult.bytesRead;
    const records = [];
    // Parse each record
    for(let i = 0; i < recordCount; i++){
        // Unpadded Size (header + compressed data + check)
        const unpaddedResult = decodeMultibyteLocal(offset);
        offset += unpaddedResult.bytesRead;
        // Uncompressed size
        const uncompressedResult = decodeMultibyteLocal(offset);
        offset += uncompressedResult.bytesRead;
        records.push({
            compressedPos: 0,
            unpaddedSize: unpaddedResult.value,
            compressedDataSize: 0,
            uncompressedSize: uncompressedResult.value
        });
    }
    // Calculate actual positions by walking through blocks
    let currentPos = 12; // After stream header
    for(let i = 0; i < records.length; i++){
        const record = records[i];
        // Record where this block's header starts
        record.compressedPos = currentPos;
        // Get block header size from the actual data
        const headerSizeRaw = getByte(currentPos);
        const headerSize = (headerSizeRaw + 1) * 4;
        // Calculate compressed data size from unpadded size
        record.compressedDataSize = record.unpaddedSize - headerSize - checkSize;
        // Move to next block: unpaddedSize + padding to 4-byte boundary
        const paddedSize = Math.ceil(record.unpaddedSize / 4) * 4;
        currentPos += paddedSize;
    }
    return records;
}
/**
 * Pure JS XZ decompression (handles all XZ spec features)
 * Returns BufferList for memory efficiency with large files.
 */ function decodeXZPure(input) {
    var _checkSizes_checkType;
    // Verify XZ magic
    if (input.length < 12 || !bufferEquals(input, 0, XZ_MAGIC)) {
        throw new Error('Invalid XZ magic bytes');
    }
    // Stream flags at offset 6-7
    const checkType = readByte(input, 7) & 0x0f;
    // Check sizes based on check type
    const checkSizes = {
        0: 0,
        1: 4,
        4: 8,
        10: 32
    };
    const checkSize = (_checkSizes_checkType = checkSizes[checkType]) !== null && _checkSizes_checkType !== void 0 ? _checkSizes_checkType : 0;
    // Find footer by skipping stream padding (null bytes at end before footer)
    // Stream padding must be multiple of 4 bytes
    let footerEnd = input.length;
    while(footerEnd > 12 && readByte(input, footerEnd - 1) === 0x00){
        footerEnd--;
    }
    // Align to 4-byte boundary (stream padding rules)
    while(footerEnd % 4 !== 0 && footerEnd > 12){
        footerEnd++;
    }
    // Verify footer magic (at footerEnd - 2)
    if (!bufferEquals(input, footerEnd - 2, XZ_FOOTER_MAGIC)) {
        throw new Error('Invalid XZ footer magic');
    }
    // Get backward size (tells us where index starts) - at footerEnd - 8
    const backwardSizeLE = readUInt32LE(input, footerEnd - 8);
    if (backwardSizeLE === null) {
        throw new Error('Invalid backward size');
    }
    const backwardSize = (backwardSizeLE + 1) * 4;
    const indexStart = footerEnd - 12 - backwardSize;
    // Parse Index to get block information
    const blockRecords = parseIndex(input, indexStart, checkSize);
    // Handle empty files (no blocks) - return empty buffer
    if (blockRecords.length === 0) return allocBuffer(0);
    // Calculate total uncompressed size for multi-block decision
    let totalUncompressedSize = 0;
    for(let i = 0; i < blockRecords.length; i++){
        totalUncompressedSize += blockRecords[i].uncompressedSize;
    }
    // Small multi-block files: use Buffer.concat directly (avoids BufferList overhead)
    // Threshold of 64KB: below this, the overhead of linked list nodes isn't worth it
    const BUFFERLIST_THRESHOLD = 64 * 1024; // 64KB
    // Single block OR small multi-block: return Buffer directly
    if (blockRecords.length === 1 || totalUncompressedSize < BUFFERLIST_THRESHOLD) {
        const record = blockRecords[0];
        const recordStart = record.compressedPos;
        const blockInfo = parseBlockHeader(input, recordStart, checkSize);
        const dataStart = recordStart + blockInfo.headerSize;
        const dataEnd = dataStart + record.compressedDataSize;
        const compressedData = input.slice(dataStart, dataEnd);
        let blockOutput = decodeLzma2(compressedData, blockInfo.lzma2Props, record.uncompressedSize);
        for(let j = blockInfo.filters.length - 1; j >= 0; j--){
            blockOutput = applyFilter(blockOutput, blockInfo.filters[j]);
        }
        return blockOutput;
    }
    // Multi-block (large): use BufferList to avoid large contiguous allocation
    const output = new BufferList();
    for(let i = 0; i < blockRecords.length; i++){
        const record = blockRecords[i];
        const recordStart = record.compressedPos;
        // Parse block header
        const blockInfo = parseBlockHeader(input, recordStart, checkSize);
        // Extract compressed data for this block
        const dataStart = recordStart + blockInfo.headerSize;
        const dataEnd = dataStart + record.compressedDataSize;
        // Note: XZ blocks have padding AFTER the check field to align to 4 bytes,
        // but the compressedSize from index is exact - no need to strip padding.
        // LZMA2 data includes a 0x00 end marker which must NOT be stripped.
        const compressedData = input.slice(dataStart, dataEnd);
        // Decompress this block with LZMA2 (fast path, no buffering)
        let blockOutput = decodeLzma2(compressedData, blockInfo.lzma2Props, record.uncompressedSize);
        // Apply preprocessing filters in reverse order (BCJ/Delta applied after LZMA2)
        // Filters are stored in order they were applied during compression,
        // so we need to reverse for decompression
        for(let j = blockInfo.filters.length - 1; j >= 0; j--){
            blockOutput = applyFilter(blockOutput, blockInfo.filters[j]);
        }
        // Append block to BufferList
        output.append(blockOutput);
    }
    return output;
}
export function decodeXZ(input, callback) {
    const worker = (cb)=>{
        var _native_xz;
        const fallback = ()=>{
            try {
                cb(null, decodeXZPure(input));
            } catch (err) {
                cb(err);
            }
        };
        const native = tryLoadNative();
        if (native === null || native === void 0 ? void 0 : (_native_xz = native.xz) === null || _native_xz === void 0 ? void 0 : _native_xz.decompress) {
            try {
                const promise = native.xz.decompress(input);
                if (promise && typeof promise.then === 'function') {
                    promise.then((value)=>cb(null, value), fallback);
                    return;
                }
            } catch  {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise((resolve, reject)=>worker((err, value)=>err ? reject(err) : resolve(value)));
}
/**
 * Create an XZ decompression Transform stream
 * @returns Transform stream that decompresses XZ data
 *
 * Uses the bundled pure-JavaScript decoder in every environment.
 */ export function createXZDecoder() {
    const bufferList = new BufferList();
    // Cache native module lookup (only done once)
    const native = tryLoadNative();
    // Choose decoder: native (async via callback) or pure JS (sync wrapped in callback)
    const decodeLzma2Block = (native === null || native === void 0 ? void 0 : native.lzma2) ? (data, props, size, cb)=>{
        var _native_lzma2;
        (_native_lzma2 = native.lzma2) === null || _native_lzma2 === void 0 ? void 0 : _native_lzma2.call(native, data, props, size).then((result)=>cb(null, result), (err)=>cb(err));
    } : (data, props, size, cb)=>{
        try {
            cb(null, decodeLzma2(data, props, size));
        } catch (err) {
            cb(err);
        }
    };
    return new Transform({
        transform (chunk, _encoding, callback) {
            bufferList.append(chunk);
            callback();
        },
        flush (callback) {
            var _checkSizes_checkType;
            const input = bufferList;
            // One-time binding for buffer access (avoids repeated Buffer.isBuffer checks)
            const getByte = Buffer.isBuffer(input) ? (offset)=>input[offset] : (offset)=>input.readByte(offset);
            const getUInt32LE = Buffer.isBuffer(input) ? (offset)=>offset < 0 || offset + 4 > input.length ? null : input.readUInt32LE(offset) : (offset)=>input.readUInt32LEAt(offset);
            const equals = (offset, expected)=>{
                if (offset + expected.length > input.length) return false;
                for(let i = 0; i < expected.length; i++){
                    if (getByte(offset + i) !== expected[i]) return false;
                }
                return true;
            };
            // Verify XZ magic (need at least 12 bytes)
            if (input.length < 12 || !equals(0, XZ_MAGIC)) {
                callback(new Error('Invalid XZ magic bytes'));
                return;
            }
            // Stream flags at offset 6-7
            const checkType = getByte(7) & 0x0f;
            // Check sizes based on check type
            const checkSizes = {
                0: 0,
                1: 4,
                4: 8,
                10: 32
            };
            const checkSize = (_checkSizes_checkType = checkSizes[checkType]) !== null && _checkSizes_checkType !== void 0 ? _checkSizes_checkType : 0;
            // Find footer by skipping stream padding (null bytes at end before footer)
            let footerEnd = input.length;
            while(footerEnd > 12 && getByte(footerEnd - 1) === 0x00){
                footerEnd--;
            }
            // Align to 4-byte boundary
            while(footerEnd % 4 !== 0 && footerEnd > 12){
                footerEnd++;
            }
            // Verify footer magic (at footerEnd - 2)
            if (!equals(footerEnd - 2, XZ_FOOTER_MAGIC)) {
                callback(new Error('Invalid XZ footer magic'));
                return;
            }
            // Get backward size (at footerEnd - 8)
            const backwardSizeLE = getUInt32LE(footerEnd - 8);
            if (backwardSizeLE === null) {
                callback(new Error('Invalid backward size'));
                return;
            }
            const backwardSize = (backwardSizeLE + 1) * 4;
            const indexStart = footerEnd - 12 - backwardSize;
            // Parse Index to get block information
            const blockRecords = parseIndex(input, indexStart, checkSize);
            // Decompress blocks sequentially (native is async)
            let blockIndex = 0;
            const pushBlock = (err)=>{
                if (err) return callback(err);
                if (blockIndex >= blockRecords.length) {
                    // All blocks processed - purge input BufferList to free memory
                    if (!Buffer.isBuffer(input)) input.clear();
                    callback(null);
                    return;
                }
                const record = blockRecords[blockIndex++];
                const recordStart = record.compressedPos;
                // Parse block header (need to get the header bytes)
                // Read header size byte first
                const headerSizeRaw = getByte(recordStart);
                const headerSize = (headerSizeRaw + 1) * 4;
                // Read the full header to parse filters
                const headerData = input.slice(recordStart, recordStart + headerSize);
                const blockInfo = parseBlockHeader(headerData, 0, checkSize);
                // Extract compressed data for this block
                const dataStart = recordStart + headerSize;
                const dataEnd = dataStart + record.compressedDataSize;
                const compressedData = input.slice(dataStart, dataEnd);
                // Decompress this block (native or pure JS, callback-based)
                decodeLzma2Block(compressedData, blockInfo.lzma2Props, record.uncompressedSize, (decodeErr, blockOutput)=>{
                    if (decodeErr || !blockOutput) {
                        pushBlock(decodeErr || new Error('Decode returned no data'));
                        return;
                    }
                    // Apply preprocessing filters in reverse order
                    for(let j = blockInfo.filters.length - 1; j >= 0; j--){
                        blockOutput = applyFilter(blockOutput, blockInfo.filters[j]);
                    }
                    // Push the block output immediately (streaming)
                    this.push(blockOutput);
                    // Continue with next block
                    pushBlock(null);
                });
            };
            // Start processing blocks
            pushBlock(null);
        }
    });
}
