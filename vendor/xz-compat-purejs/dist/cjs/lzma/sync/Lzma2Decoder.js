/**
 * Synchronous LZMA2 Decoder
 *
 * LZMA2 is a container format that wraps LZMA chunks with framing.
 * Decodes LZMA2 data from a buffer or BufferList.
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
    get Lzma2Decoder () {
        return Lzma2Decoder;
    },
    get decodeLzma2 () {
        return decodeLzma2;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _Lzma2ChunkParserts = require("../lib/Lzma2ChunkParser.js");
var _typests = require("../types.js");
var _LzmaDecoderts = require("./LzmaDecoder.js");
function _class_call_check(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}
/**
 * Read multiple bytes from BufferLike into a Buffer
 */ function readBytes(input, offset, length) {
    if (Buffer.isBuffer(input)) {
        return input.slice(offset, offset + length);
    }
    // For BufferList, create a new Buffer with the data
    var buf = (0, _extractbaseiterator.bufferFrom)(new Array(length));
    for(var i = 0; i < length; i++){
        buf[i] = input.readByte(offset + i);
    }
    return buf;
}
var Lzma2Decoder = /*#__PURE__*/ function() {
    "use strict";
    function Lzma2Decoder(properties, outputSink) {
        _class_call_check(this, Lzma2Decoder);
        if (!properties || properties.length < 1) {
            throw new Error('LZMA2 requires properties byte');
        }
        this.dictionarySize = (0, _typests.parseLzma2DictionarySize)(properties[0]);
        this.lzmaDecoder = new _LzmaDecoderts.LzmaDecoder(outputSink);
        this.lzmaDecoder.setDictionarySize(this.dictionarySize);
    }
    var _proto = Lzma2Decoder.prototype;
    /**
   * Reset the dictionary (for stream boundaries)
   */ _proto.resetDictionary = function resetDictionary() {
        this.lzmaDecoder.resetDictionary();
    };
    /**
   * Reset all probability models (for stream boundaries)
   */ _proto.resetProbabilities = function resetProbabilities() {
        this.lzmaDecoder.resetProbabilities();
    };
    /**
   * Set LZMA properties
   */ _proto.setLcLpPb = function setLcLpPb(lc, lp, pb) {
        return this.lzmaDecoder.setLcLpPb(lc, lp, pb);
    };
    /**
   * Feed uncompressed data to the dictionary (for subsequent LZMA chunks)
   */ _proto.feedUncompressed = function feedUncompressed(data) {
        this.lzmaDecoder.feedUncompressed(data);
    };
    /**
   * Decode raw LZMA data (used internally for LZMA2 chunks)
   * @param input - LZMA compressed data
   * @param offset - Input offset
   * @param outSize - Expected output size
   * @param solid - Use solid mode
   * @returns Decompressed data
   */ _proto.decodeLzmaData = function decodeLzmaData(input, offset, outSize) {
        var solid = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : false;
        return this.lzmaDecoder.decode(input, offset, outSize, solid);
    };
    /**
   * Decode LZMA2 data with streaming output
   * @param input - LZMA2 compressed data (Buffer or BufferList)
   * @returns Total number of bytes written to sink
   */ _proto.decodeWithSink = function decodeWithSink(input) {
        var totalBytes = 0;
        var offset = 0;
        while(true){
            var result = (0, _Lzma2ChunkParserts.parseLzma2ChunkHeader)(input, offset);
            if (!result.success) {
                throw new Error('Truncated LZMA2 chunk header');
            }
            var chunk = result.chunk;
            if (chunk.type === 'end') {
                break;
            }
            // Handle dictionary reset
            if (chunk.dictReset) {
                this.lzmaDecoder.resetDictionary();
            }
            // Handle state reset
            if (chunk.stateReset) {
                this.lzmaDecoder.resetProbabilities();
            }
            // Apply new properties if present
            if (chunk.newProps) {
                var _chunk_newProps = chunk.newProps, lc = _chunk_newProps.lc, lp = _chunk_newProps.lp, pb = _chunk_newProps.pb;
                this.lzmaDecoder.setLcLpPb(lc, lp, pb);
            }
            var dataOffset = offset + chunk.headerSize;
            var useSolid = !chunk.stateReset || chunk.stateReset && !chunk.dictReset;
            if (chunk.type === 'uncompressed') {
                // Read uncompressed data directly
                var uncompData = readBytes(input, dataOffset, chunk.uncompSize);
                // Feed uncompressed data to dictionary so subsequent LZMA chunks can reference it
                this.lzmaDecoder.feedUncompressed(uncompData);
                totalBytes += uncompData.length;
                offset = dataOffset + chunk.uncompSize;
            } else {
                // LZMA compressed chunk - decode directly from BufferLike
                totalBytes += this.lzmaDecoder.decodeWithSink(input, dataOffset, chunk.uncompSize, useSolid);
                offset = dataOffset + chunk.compSize;
            }
        }
        // Flush any remaining data in the OutWindow
        this.lzmaDecoder.flushOutWindow();
        return totalBytes;
    };
    /**
   * Decode LZMA2 data
   * @param input - LZMA2 compressed data (Buffer or BufferList)
   * @param unpackSize - Expected output size (optional, for pre-allocation)
   * @returns Decompressed data
   */ _proto.decode = function decode(input, unpackSize) {
        // Pre-allocate output buffer if size is known and safe for this Node version
        var outputBuffer = null;
        var outputPos = 0;
        var outputChunks = [];
        // Use canAllocateBufferSize to dynamically check if pre-allocation is safe
        var canPreAllocate = unpackSize && unpackSize > 0 && (0, _extractbaseiterator.canAllocateBufferSize)(unpackSize);
        if (canPreAllocate) {
            outputBuffer = (0, _extractbaseiterator.allocBufferUnsafe)(unpackSize);
        }
        var offset = 0;
        // Parse and decode LZMA2 chunks one at a time
        while(true){
            var result = (0, _Lzma2ChunkParserts.parseLzma2ChunkHeader)(input, offset);
            if (!result.success) {
                throw new Error('Truncated LZMA2 chunk header');
            }
            var chunk = result.chunk;
            if (chunk.type === 'end') {
                break;
            }
            var dataOffset = offset + chunk.headerSize;
            // Handle dictionary reset
            if (chunk.dictReset) {
                this.lzmaDecoder.resetDictionary();
            }
            // Handle state reset
            if (chunk.stateReset) {
                this.lzmaDecoder.resetProbabilities();
            }
            // Apply new properties if present
            if (chunk.newProps) {
                var _chunk_newProps = chunk.newProps, lc = _chunk_newProps.lc, lp = _chunk_newProps.lp, pb = _chunk_newProps.pb;
                this.lzmaDecoder.setLcLpPb(lc, lp, pb);
            }
            // Determine solid mode
            var useSolid = !chunk.stateReset || chunk.stateReset && !chunk.dictReset;
            if (chunk.type === 'uncompressed') {
                // Read uncompressed data
                var uncompData = readBytes(input, dataOffset, chunk.uncompSize);
                // Copy to output
                if (outputBuffer) {
                    uncompData.copy(outputBuffer, outputPos);
                    outputPos += uncompData.length;
                } else {
                    outputChunks.push(uncompData);
                }
                // Feed uncompressed data to dictionary so subsequent LZMA chunks can reference it
                this.lzmaDecoder.feedUncompressed(uncompData);
                offset = dataOffset + chunk.uncompSize;
            } else {
                // LZMA compressed chunk - decode directly from BufferLike
                if (outputBuffer) {
                    // Zero-copy: decode directly into caller's buffer
                    var bytesWritten = this.lzmaDecoder.decodeToBuffer(input, dataOffset, chunk.uncompSize, outputBuffer, outputPos, useSolid);
                    outputPos += bytesWritten;
                } else {
                    // No pre-allocation: decode to new buffer and collect chunks
                    var chunkData = readBytes(input, dataOffset, chunk.compSize);
                    var decoded = this.lzmaDecoder.decode(chunkData, 0, chunk.uncompSize, useSolid);
                    outputChunks.push(decoded);
                }
                offset = dataOffset + chunk.compSize;
            }
        }
        // Return pre-allocated buffer or concatenated chunks
        if (outputBuffer) {
            return outputPos < outputBuffer.length ? outputBuffer.slice(0, outputPos) : outputBuffer;
        }
        // Use bufferConcat which handles large buffers safely via pairwise combination
        return (0, _extractbaseiterator.bufferConcat)(outputChunks);
    };
    return Lzma2Decoder;
}();
function decodeLzma2(input, properties, unpackSize, outputSink) {
    // For very large outputs on old Node versions, we cannot return a single Buffer
    // Use streaming mode internally to handle large outputs on modern Node
    if (!outputSink && unpackSize && unpackSize > 0 && !(0, _extractbaseiterator.canAllocateBufferSize)(unpackSize)) {
        // Large output - use streaming mode with internal chunking
        var chunks = [];
        var sink = {
            write: function write(buffer) {
                chunks.push(buffer);
            }
        };
        var decoder = new Lzma2Decoder(properties, sink);
        decoder.decodeWithSink(input);
        // Combine chunks at the end - use bufferConcat for safe combination
        return (0, _extractbaseiterator.bufferConcat)(chunks);
    }
    var decoder1 = new Lzma2Decoder(properties, outputSink);
    if (outputSink) {
        // Zero-copy mode: write to sink during decode
        return decoder1.decodeWithSink(input);
    }
    // Buffering mode: returns Buffer (zero-copy)
    return decoder1.decode(input, unpackSize);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }