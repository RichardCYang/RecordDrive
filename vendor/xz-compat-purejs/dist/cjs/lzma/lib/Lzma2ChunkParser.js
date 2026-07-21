/**
 * LZMA2 Chunk Parser
 *
 * Shared parsing logic for LZMA2 chunk headers.
 * Used by both synchronous and streaming decoders.
 *
 * LZMA2 control byte ranges:
 * 0x00         = End of stream
 * 0x01         = Uncompressed chunk, dictionary reset
 * 0x02         = Uncompressed chunk, no dictionary reset
 * 0x80-0x9F    = LZMA chunk, no reset (solid mode)
 * 0xA0-0xBF    = LZMA chunk, reset state (probabilities)
 * 0xC0-0xDF    = LZMA chunk, reset state + new properties
 * 0xE0-0xFF    = LZMA chunk, reset dictionary + state + new properties
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
    get hasCompleteChunk () {
        return hasCompleteChunk;
    },
    get parseLzma2ChunkHeader () {
        return parseLzma2ChunkHeader;
    }
});
/**
 * Read a byte from BufferLike at offset
 */ function readByte(input, offset) {
    return Buffer.isBuffer(input) ? input[offset] : input.readByte(offset);
}
/**
 * Get length of BufferLike
 */ function getLength(input) {
    return Buffer.isBuffer(input) ? input.length : input.length;
}
function parseLzma2ChunkHeader(input, offset) {
    var len = getLength(input);
    if (offset >= len) {
        return {
            success: false,
            needBytes: 1
        };
    }
    var control = readByte(input, offset);
    // End of stream
    if (control === 0x00) {
        return {
            success: true,
            chunk: {
                type: 'end',
                headerSize: 1,
                dictReset: false,
                stateReset: false,
                newProps: null,
                uncompSize: 0,
                compSize: 0
            }
        };
    }
    // Uncompressed chunk
    if (control === 0x01 || control === 0x02) {
        // Need 3 bytes: control + 2 size bytes
        if (offset + 3 > len) {
            return {
                success: false,
                needBytes: 3 - (len - offset)
            };
        }
        var uncompSize = (readByte(input, offset + 1) << 8 | readByte(input, offset + 2)) + 1;
        return {
            success: true,
            chunk: {
                type: 'uncompressed',
                headerSize: 3,
                dictReset: control === 0x01,
                stateReset: false,
                newProps: null,
                uncompSize: uncompSize,
                compSize: 0
            }
        };
    }
    // LZMA compressed chunk
    if (control >= 0x80) {
        var hasNewProps = control >= 0xc0;
        var minHeaderSize = hasNewProps ? 6 : 5; // control + 2 uncomp + 2 comp + (1 props)
        if (offset + minHeaderSize > len) {
            return {
                success: false,
                needBytes: minHeaderSize - (len - offset)
            };
        }
        // Parse sizes
        var uncompHigh = control & 0x1f;
        var uncompSize1 = (uncompHigh << 16 | readByte(input, offset + 1) << 8 | readByte(input, offset + 2)) + 1;
        var compSize = (readByte(input, offset + 3) << 8 | readByte(input, offset + 4)) + 1;
        // Parse properties if present
        var newProps = null;
        if (hasNewProps) {
            var propsByte = readByte(input, offset + 5);
            var lc = propsByte % 9;
            var remainder = ~~(propsByte / 9);
            var lp = remainder % 5;
            var pb = ~~(remainder / 5);
            newProps = {
                lc: lc,
                lp: lp,
                pb: pb
            };
        }
        return {
            success: true,
            chunk: {
                type: 'lzma',
                headerSize: minHeaderSize,
                dictReset: control >= 0xe0,
                stateReset: control >= 0xa0,
                newProps: newProps,
                uncompSize: uncompSize1,
                compSize: compSize
            }
        };
    }
    // Invalid control byte
    throw new Error("Invalid LZMA2 control byte: 0x".concat(control.toString(16)));
}
function hasCompleteChunk(input, offset) {
    var result = parseLzma2ChunkHeader(input, offset);
    if (result.success === false) {
        return {
            success: false,
            needBytes: result.needBytes
        };
    }
    var chunk = result.chunk;
    var dataSize = chunk.type === 'uncompressed' ? chunk.uncompSize : chunk.compSize;
    var totalSize = chunk.headerSize + dataSize;
    var len = getLength(input);
    if (offset + totalSize > len) {
        return {
            success: false,
            needBytes: totalSize - (len - offset)
        };
    }
    return {
        success: true,
        chunk: chunk,
        totalSize: totalSize
    };
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }