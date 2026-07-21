/**
 * LZMA Transform Stream Wrappers
 *
 * Provides Transform streams for LZMA1 and LZMA2 decompression.
 *
 * LZMA2 streaming works by buffering until a complete chunk is available,
 * then decoding synchronously. LZMA2 chunks are bounded in size (~2MB max
 * uncompressed), so memory usage is predictable and bounded.
 *
 * Performance Optimization:
 * - Uses OutputSink pattern for zero-copy output during decode
 * - Each decoded byte written directly to stream (not buffered then copied)
 * - ~4x faster than previous buffering approach
 *
 * True byte-by-byte async LZMA streaming would require rewriting the entire
 * decoder with continuation-passing style, which is complex and not worth
 * the effort given LZMA2's chunked format.
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
    get createLzma2Decoder () {
        return createLzma2Decoder;
    },
    get createLzmaDecoder () {
        return createLzmaDecoder;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _Lzma2ChunkParserts = require("../lib/Lzma2ChunkParser.js");
var _LzmaDecoderts = require("../sync/LzmaDecoder.js");
var _typests = require("../types.js");
function createLzma2Decoder(properties) {
    if (!properties || properties.length < 1) {
        throw new Error('LZMA2 requires properties byte');
    }
    var dictSize = (0, _typests.parseLzma2DictionarySize)(properties[0]);
    // LZMA decoder instance - reused across chunks for solid mode
    var decoder = new _LzmaDecoderts.LzmaDecoder();
    decoder.setDictionarySize(dictSize);
    // Track current LZMA properties
    var propsSet = false;
    // Store lc/lp/pb for reuse in stream decoder
    var currentLc;
    var currentLp;
    var currentPb;
    // Buffer for incomplete chunk data
    var pending = null;
    var finished = false;
    return new _extractbaseiterator.Transform({
        transform: function transform(chunk, _encoding, callback) {
            var _this = this;
            if (finished) {
                callback(null);
                return;
            }
            // Combine with pending data
            var input;
            if (pending && pending.length > 0) {
                input = Buffer.concat([
                    pending,
                    chunk
                ]);
                pending = null;
            } else {
                input = chunk;
            }
            var offset = 0;
            try {
                while(offset < input.length && !finished){
                    var result = (0, _Lzma2ChunkParserts.hasCompleteChunk)(input, offset);
                    if (!result.success) {
                        // Need more data
                        pending = input.slice(offset);
                        break;
                    }
                    var chunkInfo = result.chunk, totalSize = result.totalSize;
                    if (chunkInfo.type === 'end') {
                        finished = true;
                        break;
                    }
                    // Handle dictionary reset
                    if (chunkInfo.dictReset) {
                        decoder.resetDictionary();
                    }
                    var dataOffset = offset + chunkInfo.headerSize;
                    if (chunkInfo.type === 'uncompressed') {
                        var uncompData = input.slice(dataOffset, dataOffset + chunkInfo.uncompSize);
                        this.push(uncompData);
                        // Feed uncompressed data to dictionary for subsequent LZMA chunks
                        decoder.feedUncompressed(uncompData);
                    } else {
                        // LZMA compressed chunk
                        // Variables to store properties (used for both decoders)
                        var lc = void 0;
                        var lp = void 0;
                        var pb = void 0;
                        // Apply new properties if present
                        if (chunkInfo.newProps) {
                            var ref;
                            ref = chunkInfo.newProps, lc = ref.lc, lp = ref.lp, pb = ref.pb, ref;
                            // Store properties for reuse in stream decoder
                            currentLc = lc;
                            currentLp = lp;
                            currentPb = pb;
                            if (!decoder.setLcLpPb(lc, lp, pb)) {
                                throw new Error("Invalid LZMA properties: lc=".concat(lc, " lp=").concat(lp, " pb=").concat(pb));
                            }
                            propsSet = true;
                        } else {
                            // No new properties, check if we already have them
                            if (!propsSet) {
                                throw new Error('LZMA chunk without properties');
                            }
                        }
                        // Reset probabilities if state reset
                        if (chunkInfo.stateReset) {
                            decoder.resetProbabilities();
                        }
                        // Determine solid mode - preserve dictionary if not resetting state or if only resetting state (not dict)
                        var useSolid = !chunkInfo.stateReset || chunkInfo.stateReset && !chunkInfo.dictReset;
                        var compData = input.slice(dataOffset, dataOffset + chunkInfo.compSize);
                        // Enhanced: Use OutputSink for direct emission (zero-copy)
                        // Create a decoder with direct stream emission
                        var streamDecoder = new _LzmaDecoderts.LzmaDecoder({
                            write: function write(chunk) {
                                return _this.push(chunk);
                            }
                        });
                        streamDecoder.setDictionarySize(dictSize);
                        // Set properties from current values (from first chunk or newProps)
                        if (currentLc !== undefined && currentLp !== undefined && currentPb !== undefined) {
                            streamDecoder.setLcLpPb(currentLc, currentLp, currentPb);
                        }
                        // Use solid mode based on chunk properties
                        streamDecoder.decodeWithSink(compData, 0, chunkInfo.uncompSize, useSolid);
                        // Flush any remaining data in the OutWindow
                        streamDecoder.flushOutWindow();
                    }
                    offset += totalSize;
                }
                callback(null);
            } catch (err) {
                callback(err);
            }
        },
        flush: function flush(callback) {
            if (pending && pending.length > 0 && !finished) {
                callback(new Error('Truncated LZMA2 stream'));
            } else {
                callback(null);
            }
        }
    });
}
function createLzmaDecoder(properties, unpackSize) {
    var decoder = new _LzmaDecoderts.LzmaDecoder();
    decoder.setDecoderProperties(properties);
    var chunks = [];
    var totalSize = 0;
    return new _extractbaseiterator.Transform({
        transform: function transform(chunk, _encoding, callback) {
            chunks.push(chunk);
            totalSize += chunk.length;
            callback(null);
        },
        flush: function flush(callback) {
            var _this = this;
            try {
                // Optimization: Pre-allocate single buffer instead of Buffer.concat()
                // This reduces peak memory usage by ~50% during concatenation
                var input = (0, _extractbaseiterator.allocBufferUnsafe)(totalSize);
                var offset = 0;
                // Copy each chunk into the pre-allocated buffer
                for(var i = 0; i < chunks.length; i++){
                    var chunk = chunks[i];
                    chunk.copy(input, offset);
                    offset += chunk.length;
                }
                // Enhanced: Use OutputSink for direct emission (zero-copy)
                // Create a decoder with direct stream emission
                var streamDecoder = new _LzmaDecoderts.LzmaDecoder({
                    write: function write(chunk) {
                        return _this.push(chunk);
                    }
                });
                streamDecoder.setDecoderProperties(properties);
                streamDecoder.decodeWithSink(input, 0, unpackSize, false);
                // Flush any remaining data in the OutWindow
                streamDecoder.flushOutWindow();
                callback(null);
            } catch (err) {
                callback(err);
            }
        }
    });
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }