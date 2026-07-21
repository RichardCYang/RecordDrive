// BCJ (SPARC) filter codec - converts SPARC branch instruction addresses
// This filter makes SPARC executables more compressible by LZMA
//
// SPARC is big-endian. CALL instructions use 30-bit signed offsets.
// The filter only transforms CALL instructions with specific byte patterns.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c
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
    get createBcjSparcDecoder () {
        return createBcjSparcDecoder;
    },
    get decodeBcjSparc () {
        return decodeBcjSparc;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _createBufferingDecoderts = /*#__PURE__*/ _interop_require_default(require("../../utils/createBufferingDecoder.js"));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function decodeBcjSparc(input, _properties, _unpackSize) {
    var output = (0, _extractbaseiterator.bufferFrom)(input); // Copy since we modify in place
    var pos = 0;
    // Process 4-byte aligned positions
    while(pos + 4 <= output.length){
        var b0 = output[pos];
        var b1 = output[pos + 1];
        // Check for CALL instruction with specific byte patterns:
        // (b0 == 0x40 && (b1 & 0xC0) == 0x00) || (b0 == 0x7F && (b1 & 0xC0) == 0xC0)
        if (b0 === 0x40 && (b1 & 0xc0) === 0x00 || b0 === 0x7f && (b1 & 0xc0) === 0xc0) {
            // Read 32-bit value (big-endian)
            var src = b0 << 24 | b1 << 16 | output[pos + 2] << 8 | output[pos + 3];
            // Shift left by 2 (multiply by 4 for word addressing)
            src <<= 2;
            // Decoding: subtract position
            var dest = src - pos;
            // Shift right by 2
            dest >>>= 2;
            // Reconstruct with sign extension and opcode
            // (((0 - ((dest >> 22) & 1)) << 22) & 0x3FFFFFFF) | (dest & 0x3FFFFF) | 0x40000000
            var signBit = dest >>> 22 & 1;
            var signExtend = signBit ? 0x3fc00000 : 0;
            dest = signExtend | dest & 0x3fffff | 0x40000000;
            // Write back (big-endian)
            output[pos] = dest >>> 24 & 0xff;
            output[pos + 1] = dest >>> 16 & 0xff;
            output[pos + 2] = dest >>> 8 & 0xff;
            output[pos + 3] = dest & 0xff;
        }
        pos += 4;
    }
    return output;
}
function createBcjSparcDecoder(properties, unpackSize) {
    return (0, _createBufferingDecoderts.default)(decodeBcjSparc, properties, unpackSize);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }