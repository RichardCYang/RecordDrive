// BCJ (ARM Thumb) filter codec - converts ARM Thumb branch instruction addresses
// This filter makes ARM Thumb executables more compressible by LZMA
//
// ARM Thumb uses 16-bit instructions, but BL (branch with link) spans two 16-bit words.
// The filter converts relative addresses to absolute during compression.
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
    get createBcjArmtDecoder () {
        return createBcjArmtDecoder;
    },
    get decodeBcjArmt () {
        return decodeBcjArmt;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _createBufferingDecoderts = /*#__PURE__*/ _interop_require_default(require("../../utils/createBufferingDecoder.js"));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function decodeBcjArmt(input, _properties, _unpackSize) {
    var output = (0, _extractbaseiterator.bufferFrom)(input); // Copy since we modify in place
    var pos = 0;
    // Process 2-byte aligned positions
    while(pos + 4 <= output.length){
        // Read two 16-bit values (little-endian)
        var w0 = output[pos] | output[pos + 1] << 8;
        var w1 = output[pos + 2] | output[pos + 3] << 8;
        // Check for BL instruction pair:
        // First word: 0xF000-0xF7FF (1111 0xxx xxxx xxxx)
        // Second word: 0xF800-0xFFFF (1111 1xxx xxxx xxxx)
        if ((w0 & 0xf800) === 0xf000 && (w1 & 0xf800) === 0xf800) {
            // Extract and combine the offset parts
            // High 11 bits from w0, low 11 bits from w1
            var hi = w0 & 0x7ff;
            var lo = w1 & 0x7ff;
            // Combine into 22-bit offset (in half-words)
            var addr = hi << 11 | lo;
            // Sign-extend 22-bit to 32-bit
            if (addr & 0x200000) {
                addr |= 0xffc00000;
            }
            // Convert absolute to relative:
            // Subtract current position (in half-words, so divide by 2)
            // Thumb PC is 2 half-words (4 bytes) ahead
            var relAddr = addr - (pos >>> 1);
            // Write back
            var newHi = relAddr >>> 11 & 0x7ff;
            var newLo = relAddr & 0x7ff;
            output[pos] = newHi & 0xff;
            output[pos + 1] = 0xf0 | newHi >>> 8 & 0x07;
            output[pos + 2] = newLo & 0xff;
            output[pos + 3] = 0xf8 | newLo >>> 8 & 0x07;
            pos += 4;
        } else {
            pos += 2;
        }
    }
    return output;
}
function createBcjArmtDecoder(properties, unpackSize) {
    return (0, _createBufferingDecoderts.default)(decodeBcjArmt, properties, unpackSize);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }