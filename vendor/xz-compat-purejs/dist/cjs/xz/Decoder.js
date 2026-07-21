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
 */ "use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: Object.getOwnPropertyDescriptor(all, name).get
    });
}
_export(exports, {
    get createXZDecoder () {
        return createXZDecoder;
    },
    get decodeXZ () {
        return decodeXZ;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _Bcjts = require("../filters/bcj/Bcj.js");
var _BcjArmts = require("../filters/bcj/BcjArm.js");
var _BcjArm64ts = require("../filters/bcj/BcjArm64.js");
var _BcjArmtts = require("../filters/bcj/BcjArmt.js");
var _BcjIa64ts = require("../filters/bcj/BcjIa64.js");
var _BcjPpcts = require("../filters/bcj/BcjPpc.js");
var _BcjSparcts = require("../filters/bcj/BcjSparc.js");
var _Deltats = require("../filters/delta/Delta.js");
var _indexts = require("../lzma/index.js");
var _nativets = require("../native.js");
// XZ magic bytes
var XZ_MAGIC = [
    0xfd,
    0x37,
    0x7a,
    0x58,
    0x5a,
    0x00
];
var XZ_FOOTER_MAGIC = [
    0x59,
    0x5a
]; // "YZ"
// Filter IDs (from XZ specification)
var FILTER_DELTA = 0x03;
var FILTER_BCJ_X86 = 0x04;
var FILTER_BCJ_PPC = 0x05;
var FILTER_BCJ_IA64 = 0x06;
var FILTER_BCJ_ARM = 0x07;
var FILTER_BCJ_ARMT = 0x08;
var FILTER_BCJ_SPARC = 0x09;
var FILTER_BCJ_ARM64 = 0x0a;
var FILTER_LZMA2 = 0x21;
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
    for(var i = 0; i < expected.length; i++){
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
    var value = 0;
    var i = 0;
    var byte;
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
    }while (byte & 0x80);
    return {
        value: value,
        bytesRead: i
    };
}
/**
 * Apply a preprocessing filter (BCJ/Delta) to decompressed data
 */ function applyFilter(data, filter) {
    switch(filter.id){
        case FILTER_BCJ_X86:
            return (0, _Bcjts.decodeBcj)(data, filter.props);
        case FILTER_BCJ_ARM:
            return (0, _BcjArmts.decodeBcjArm)(data, filter.props);
        case FILTER_BCJ_ARM64:
            return (0, _BcjArm64ts.decodeBcjArm64)(data, filter.props);
        case FILTER_BCJ_ARMT:
            return (0, _BcjArmtts.decodeBcjArmt)(data, filter.props);
        case FILTER_BCJ_PPC:
            return (0, _BcjPpcts.decodeBcjPpc)(data, filter.props);
        case FILTER_BCJ_SPARC:
            return (0, _BcjSparcts.decodeBcjSparc)(data, filter.props);
        case FILTER_BCJ_IA64:
            return (0, _BcjIa64ts.decodeBcjIa64)(data, filter.props);
        case FILTER_DELTA:
            return (0, _Deltats.decodeDelta)(data, filter.props);
        default:
            throw new Error("Unsupported filter: 0x".concat(filter.id.toString(16)));
    }
}
/**
 * Parse XZ Block Header to extract filters and LZMA2 properties
 */ function parseBlockHeader(input, offset, _checkSize) {
    // Block header size
    var blockHeaderSizeRaw = input[offset];
    if (blockHeaderSizeRaw === 0) {
        throw new Error('Invalid block header size (index indicator found instead of block)');
    }
    var blockHeaderSize = (blockHeaderSizeRaw + 1) * 4;
    // Parse block header
    var blockHeaderStart = offset;
    offset++; // skip size byte
    var blockFlags = input[offset++];
    var numFilters = (blockFlags & 0x03) + 1;
    var hasCompressedSize = (blockFlags & 0x40) !== 0;
    var hasUncompressedSize = (blockFlags & 0x80) !== 0;
    // Skip optional sizes
    if (hasCompressedSize) {
        var result = decodeMultibyte(input, offset);
        offset += result.bytesRead;
    }
    if (hasUncompressedSize) {
        var result1 = decodeMultibyte(input, offset);
        offset += result1.bytesRead;
    }
    // Parse all filters
    var filters = [];
    var lzma2Props = null;
    for(var i = 0; i < numFilters; i++){
        var filterIdResult = decodeMultibyte(input, offset);
        var filterId = filterIdResult.value;
        offset += filterIdResult.bytesRead;
        var propsSizeResult = decodeMultibyte(input, offset);
        offset += propsSizeResult.bytesRead;
        var filterProps = input.slice(offset, offset + propsSizeResult.value);
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
            throw new Error("Unsupported filter: 0x".concat(filterId.toString(16)));
        }
    }
    if (!lzma2Props) {
        throw new Error('No LZMA2 filter found in XZ block');
    }
    // Skip to end of block header (must be aligned to 4 bytes)
    var blockDataStart = blockHeaderStart + blockHeaderSize;
    return {
        filters: filters,
        lzma2Props: lzma2Props,
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
    var getByte = Buffer.isBuffer(input) ? function(offset) {
        return input[offset];
    } : function(offset) {
        return input.readByte(offset);
    };
    // Local multibyte decoder using bound getByte
    var decodeMultibyteLocal = function decodeMultibyteLocal(offset) {
        var value = 0;
        var i = 0;
        var byte;
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
        }while (byte & 0x80);
        return {
            value: value,
            bytesRead: i
        };
    };
    var offset = indexStart;
    // Index indicator (0x00)
    if (getByte(offset) !== 0x00) {
        throw new Error('Invalid index indicator');
    }
    offset++;
    // Number of records
    var countResult = decodeMultibyteLocal(offset);
    var recordCount = countResult.value;
    offset += countResult.bytesRead;
    var records = [];
    // Parse each record
    for(var i = 0; i < recordCount; i++){
        // Unpadded Size (header + compressed data + check)
        var unpaddedResult = decodeMultibyteLocal(offset);
        offset += unpaddedResult.bytesRead;
        // Uncompressed size
        var uncompressedResult = decodeMultibyteLocal(offset);
        offset += uncompressedResult.bytesRead;
        records.push({
            compressedPos: 0,
            unpaddedSize: unpaddedResult.value,
            compressedDataSize: 0,
            uncompressedSize: uncompressedResult.value
        });
    }
    // Calculate actual positions by walking through blocks
    var currentPos = 12; // After stream header
    for(var i1 = 0; i1 < records.length; i1++){
        var record = records[i1];
        // Record where this block's header starts
        record.compressedPos = currentPos;
        // Get block header size from the actual data
        var headerSizeRaw = getByte(currentPos);
        var headerSize = (headerSizeRaw + 1) * 4;
        // Calculate compressed data size from unpadded size
        record.compressedDataSize = record.unpaddedSize - headerSize - checkSize;
        // Move to next block: unpaddedSize + padding to 4-byte boundary
        var paddedSize = Math.ceil(record.unpaddedSize / 4) * 4;
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
    var checkType = readByte(input, 7) & 0x0f;
    // Check sizes based on check type
    var checkSizes = {
        0: 0,
        1: 4,
        4: 8,
        10: 32
    };
    var checkSize = (_checkSizes_checkType = checkSizes[checkType]) !== null && _checkSizes_checkType !== void 0 ? _checkSizes_checkType : 0;
    // Find footer by skipping stream padding (null bytes at end before footer)
    // Stream padding must be multiple of 4 bytes
    var footerEnd = input.length;
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
    var backwardSizeLE = readUInt32LE(input, footerEnd - 8);
    if (backwardSizeLE === null) {
        throw new Error('Invalid backward size');
    }
    var backwardSize = (backwardSizeLE + 1) * 4;
    var indexStart = footerEnd - 12 - backwardSize;
    // Parse Index to get block information
    var blockRecords = parseIndex(input, indexStart, checkSize);
    // Handle empty files (no blocks) - return empty buffer
    if (blockRecords.length === 0) return (0, _extractbaseiterator.allocBuffer)(0);
    // Calculate total uncompressed size for multi-block decision
    var totalUncompressedSize = 0;
    for(var i = 0; i < blockRecords.length; i++){
        totalUncompressedSize += blockRecords[i].uncompressedSize;
    }
    // Small multi-block files: use Buffer.concat directly (avoids BufferList overhead)
    // Threshold of 64KB: below this, the overhead of linked list nodes isn't worth it
    var BUFFERLIST_THRESHOLD = 64 * 1024; // 64KB
    // Single block OR small multi-block: return Buffer directly
    if (blockRecords.length === 1 || totalUncompressedSize < BUFFERLIST_THRESHOLD) {
        var record = blockRecords[0];
        var recordStart = record.compressedPos;
        var blockInfo = parseBlockHeader(input, recordStart, checkSize);
        var dataStart = recordStart + blockInfo.headerSize;
        var dataEnd = dataStart + record.compressedDataSize;
        var compressedData = input.slice(dataStart, dataEnd);
        var blockOutput = (0, _indexts.decodeLzma2)(compressedData, blockInfo.lzma2Props, record.uncompressedSize);
        for(var j = blockInfo.filters.length - 1; j >= 0; j--){
            blockOutput = applyFilter(blockOutput, blockInfo.filters[j]);
        }
        return blockOutput;
    }
    // Multi-block (large): use BufferList to avoid large contiguous allocation
    var output = new _extractbaseiterator.BufferList();
    for(var i1 = 0; i1 < blockRecords.length; i1++){
        var record1 = blockRecords[i1];
        var recordStart1 = record1.compressedPos;
        // Parse block header
        var blockInfo1 = parseBlockHeader(input, recordStart1, checkSize);
        // Extract compressed data for this block
        var dataStart1 = recordStart1 + blockInfo1.headerSize;
        var dataEnd1 = dataStart1 + record1.compressedDataSize;
        // Note: XZ blocks have padding AFTER the check field to align to 4 bytes,
        // but the compressedSize from index is exact - no need to strip padding.
        // LZMA2 data includes a 0x00 end marker which must NOT be stripped.
        var compressedData1 = input.slice(dataStart1, dataEnd1);
        // Decompress this block with LZMA2 (fast path, no buffering)
        var blockOutput1 = (0, _indexts.decodeLzma2)(compressedData1, blockInfo1.lzma2Props, record1.uncompressedSize);
        // Apply preprocessing filters in reverse order (BCJ/Delta applied after LZMA2)
        // Filters are stored in order they were applied during compression,
        // so we need to reverse for decompression
        for(var j1 = blockInfo1.filters.length - 1; j1 >= 0; j1--){
            blockOutput1 = applyFilter(blockOutput1, blockInfo1.filters[j1]);
        }
        // Append block to BufferList
        output.append(blockOutput1);
    }
    return output;
}
function decodeXZ(input, callback) {
    var worker = function worker(cb) {
        var _native_xz;
        var fallback = function fallback() {
            try {
                cb(null, decodeXZPure(input));
            } catch (err) {
                cb(err);
            }
        };
        var native = (0, _nativets.tryLoadNative)();
        if (native === null || native === void 0 ? void 0 : (_native_xz = native.xz) === null || _native_xz === void 0 ? void 0 : _native_xz.decompress) {
            try {
                var promise = native.xz.decompress(input);
                if (promise && typeof promise.then === 'function') {
                    promise.then(function(value) {
                        return cb(null, value);
                    }, fallback);
                    return;
                }
            } catch (unused) {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise(function(resolve, reject) {
        return worker(function(err, value) {
            return err ? reject(err) : resolve(value);
        });
    });
}
function createXZDecoder() {
    var bufferList = new _extractbaseiterator.BufferList();
    // Cache native module lookup (only done once)
    var native = (0, _nativets.tryLoadNative)();
    // Choose decoder: native (async via callback) or pure JS (sync wrapped in callback)
    var decodeLzma2Block = (native === null || native === void 0 ? void 0 : native.lzma2) ? function(data, props, size, cb) {
        var _native_lzma2;
        (_native_lzma2 = native.lzma2) === null || _native_lzma2 === void 0 ? void 0 : _native_lzma2.call(native, data, props, size).then(function(result) {
            return cb(null, result);
        }, function(err) {
            return cb(err);
        });
    } : function(data, props, size, cb) {
        try {
            cb(null, (0, _indexts.decodeLzma2)(data, props, size));
        } catch (err) {
            cb(err);
        }
    };
    return new _extractbaseiterator.Transform({
        transform: function transform(chunk, _encoding, callback) {
            bufferList.append(chunk);
            callback();
        },
        flush: function flush(callback) {
            var _this = this;
            var _checkSizes_checkType;
            var input = bufferList;
            // One-time binding for buffer access (avoids repeated Buffer.isBuffer checks)
            var getByte = Buffer.isBuffer(input) ? function(offset) {
                return input[offset];
            } : function(offset) {
                return input.readByte(offset);
            };
            var getUInt32LE = Buffer.isBuffer(input) ? function(offset) {
                return offset < 0 || offset + 4 > input.length ? null : input.readUInt32LE(offset);
            } : function(offset) {
                return input.readUInt32LEAt(offset);
            };
            var equals = function equals(offset, expected) {
                if (offset + expected.length > input.length) return false;
                for(var i = 0; i < expected.length; i++){
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
            var checkType = getByte(7) & 0x0f;
            // Check sizes based on check type
            var checkSizes = {
                0: 0,
                1: 4,
                4: 8,
                10: 32
            };
            var checkSize = (_checkSizes_checkType = checkSizes[checkType]) !== null && _checkSizes_checkType !== void 0 ? _checkSizes_checkType : 0;
            // Find footer by skipping stream padding (null bytes at end before footer)
            var footerEnd = input.length;
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
            var backwardSizeLE = getUInt32LE(footerEnd - 8);
            if (backwardSizeLE === null) {
                callback(new Error('Invalid backward size'));
                return;
            }
            var backwardSize = (backwardSizeLE + 1) * 4;
            var indexStart = footerEnd - 12 - backwardSize;
            // Parse Index to get block information
            var blockRecords = parseIndex(input, indexStart, checkSize);
            // Decompress blocks sequentially (native is async)
            var blockIndex = 0;
            var pushBlock = function pushBlock1(err) {
                if (err) return callback(err);
                if (blockIndex >= blockRecords.length) {
                    // All blocks processed - purge input BufferList to free memory
                    if (!Buffer.isBuffer(input)) input.clear();
                    callback(null);
                    return;
                }
                var record = blockRecords[blockIndex++];
                var recordStart = record.compressedPos;
                // Parse block header (need to get the header bytes)
                // Read header size byte first
                var headerSizeRaw = getByte(recordStart);
                var headerSize = (headerSizeRaw + 1) * 4;
                // Read the full header to parse filters
                var headerData = input.slice(recordStart, recordStart + headerSize);
                var blockInfo = parseBlockHeader(headerData, 0, checkSize);
                // Extract compressed data for this block
                var dataStart = recordStart + headerSize;
                var dataEnd = dataStart + record.compressedDataSize;
                var compressedData = input.slice(dataStart, dataEnd);
                // Decompress this block (native or pure JS, callback-based)
                decodeLzma2Block(compressedData, blockInfo.lzma2Props, record.uncompressedSize, function(decodeErr, blockOutput) {
                    if (decodeErr || !blockOutput) {
                        pushBlock(decodeErr || new Error('Decode returned no data'));
                        return;
                    }
                    // Apply preprocessing filters in reverse order
                    for(var j = blockInfo.filters.length - 1; j >= 0; j--){
                        blockOutput = applyFilter(blockOutput, blockInfo.filters[j]);
                    }
                    // Push the block output immediately (streaming)
                    _this.push(blockOutput);
                    // Continue with next block
                    pushBlock(null);
                });
            };
            // Start processing blocks
            pushBlock(null);
        }
    });
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }