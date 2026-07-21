/**
 * XZ-Compat: XZ/LZMA Decompression Library
 *
 * Pure JavaScript implementation with native acceleration disabled.
 *
 * Uses the bundled JavaScript decoder in every environment.
 */ // ============================================================================
// High-Level APIs (Recommended)
// ============================================================================
// 7z-specific decoders - accept properties separately, try native automatically
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
        return _indexts.createLzma2Decoder;
    },
    get createLzmaDecoder () {
        return _indexts.createLzmaDecoder;
    },
    get createXZDecoder () {
        return _Decoderts.createXZDecoder;
    },
    get decode7zLzma () {
        return _sevenzts.decode7zLzma;
    },
    get decode7zLzma2 () {
        return _sevenzts.decode7zLzma2;
    },
    get decodeLzma () {
        return _indexts.decodeLzma;
    },
    get decodeLzma2 () {
        return _indexts.decodeLzma2;
    },
    get decodeXZ () {
        return _Decoderts.decodeXZ;
    },
    get isNativeAvailable () {
        return _nativets.isNativeAvailable;
    }
});
var _sevenzts = require("./sevenz.js");
var _Decoderts = require("./xz/Decoder.js");
var _indexts = require("./lzma/index.js");
_export_star(require("./filters/index.js"), exports);
var _nativets = require("./native.js");
function _export_star(from, to) {
    Object.keys(from).forEach(function(k) {
        if (k !== "default" && !Object.prototype.hasOwnProperty.call(to, k)) {
            Object.defineProperty(to, k, {
                enumerable: true,
                get: function() {
                    return from[k];
                }
            });
        }
    });
    return from;
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }