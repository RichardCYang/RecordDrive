// Delta filter codec - stores differences between consecutive bytes
// Useful for data with gradual changes (images, audio, sensor data)
//
// The Delta filter stores the difference between each byte and the byte
// N positions before it, where N is the "distance" parameter (default 1).
// This makes data with regular patterns more compressible.
//
// This implementation uses true streaming - processes data chunk by chunk
// while maintaining state between chunks.
"use strict";
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
    get createDeltaDecoder () {
        return createDeltaDecoder;
    },
    get decodeDelta () {
        return decodeDelta;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
function decodeDelta(input, properties, _unpackSize) {
    // Distance parameter: default is 1
    var distance = 1;
    if (properties && properties.length >= 1) {
        // Properties byte contains (distance - 1)
        distance = properties[0] + 1;
    }
    var output = (0, _extractbaseiterator.bufferFrom)(input); // Copy since we modify in place
    // State buffer for multi-byte distance
    var state = [];
    for(var i = 0; i < distance; i++){
        state.push(0);
    }
    for(var j = 0; j < output.length; j++){
        var idx = j % distance;
        state[idx] = state[idx] + output[j] & 0xff;
        output[j] = state[idx];
    }
    return output;
}
function createDeltaDecoder(properties, _unpackSize) {
    // Distance parameter: default is 1
    var distance = 1;
    if (properties && properties.length >= 1) {
        distance = properties[0] + 1;
    }
    // State buffer for multi-byte distance
    var state = [];
    for(var i = 0; i < distance; i++){
        state.push(0);
    }
    var byteIndex = 0;
    return new _extractbaseiterator.Transform({
        transform: function transform(chunk, _encoding, callback) {
            var output = (0, _extractbaseiterator.allocBuffer)(chunk.length);
            for(var j = 0; j < chunk.length; j++){
                var idx = byteIndex % distance;
                state[idx] = state[idx] + chunk[j] & 0xff;
                output[j] = state[idx];
                byteIndex++;
            }
            callback(null, output);
        }
    });
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }