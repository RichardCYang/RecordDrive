/**
 * LZMA Decoder Module
 *
 * Provides both synchronous and streaming LZMA1/LZMA2 decoders.
 *
 * Synchronous API: Use when input is a complete Buffer
 * Streaming API: Use with Transform streams for memory-efficient decompression
 *
 * LZMA1 vs LZMA2:
 * - LZMA2 is chunked and supports true streaming with bounded memory
 * - LZMA1 has no chunk boundaries and requires buffering all input for streaming
 */ // Streaming decoders (Transform streams)
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
    get createLzma2Decoder () {
        return _transformsts.createLzma2Decoder;
    },
    get createLzmaDecoder () {
        return _transformsts.createLzmaDecoder;
    },
    get decodeLzma () {
        return _LzmaDecoderts.decodeLzma;
    },
    get decodeLzma2 () {
        return _Lzma2Decoderts.decodeLzma2;
    }
});
var _transformsts = require("./stream/transforms.js");
var _Lzma2Decoderts = require("./sync/Lzma2Decoder.js");
var _LzmaDecoderts = require("./sync/LzmaDecoder.js");
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }