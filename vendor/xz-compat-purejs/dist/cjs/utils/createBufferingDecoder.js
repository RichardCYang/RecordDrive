"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, /**
 * Helper to create a Transform stream from a synchronous decoder
 *
 * This buffers all input and applies the decoder when the stream ends.
 * This is suitable for codecs that don't support true streaming.
 */ "default", {
    enumerable: true,
    get: function() {
        return createBufferingDecoder;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
function createBufferingDecoder(decodeFn, properties, unpackSize) {
    var chunks = [];
    var _totalSize = 0;
    return new _extractbaseiterator.Transform({
        transform: function transform(chunk, _encoding, callback) {
            chunks.push(chunk);
            _totalSize += chunk.length;
            callback();
        },
        flush: function flush(callback) {
            try {
                // Concatenate all chunks
                var input = (0, _extractbaseiterator.bufferFrom)(Buffer.concat(chunks));
                // Decode using the synchronous decoder
                var output = decodeFn(input, properties, unpackSize);
                // Push the result
                this.push(output);
                callback();
            } catch (err) {
                callback(err);
            }
        }
    });
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }