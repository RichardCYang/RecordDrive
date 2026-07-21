// BCJ (PowerPC) filter codec - converts PowerPC branch instruction addresses
// This filter makes PowerPC executables more compressible by LZMA
//
// PowerPC is big-endian. Branch instructions use 26-bit signed offsets.
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
    get createBcjPpcDecoder () {
        return createBcjPpcDecoder;
    },
    get decodeBcjPpc () {
        return decodeBcjPpc;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _createBufferingDecoderts = /*#__PURE__*/ _interop_require_default(require("../../utils/createBufferingDecoder.js"));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function decodeBcjPpc(input, _properties, _unpackSize) {
    var output = (0, _extractbaseiterator.bufferFrom)(input); // Copy since we modify in place
    var pos = 0;
    // Process 4-byte aligned positions
    while(pos + 4 <= output.length){
        // Read 32-bit value (big-endian)
        var instr = output[pos] << 24 | output[pos + 1] << 16 | output[pos + 2] << 8 | output[pos + 3];
        // Check for B/BL instruction: (instr & 0xFC000003) === 0x48000001
        if ((instr & 0xfc000003) === 0x48000001) {
            // Extract 26-bit offset (bits 2-27, the LI field)
            var addr = instr & 0x03fffffc;
            // Sign-extend 26-bit to 32-bit
            if (addr & 0x02000000) {
                addr |= 0xfc000000;
            }
            // Convert absolute to relative: subtract current position
            var relAddr = addr - pos;
            // Clear old offset and write new one
            instr = instr & 0xfc000003 | relAddr & 0x03fffffc;
            // Write back (big-endian)
            output[pos] = instr >>> 24 & 0xff;
            output[pos + 1] = instr >>> 16 & 0xff;
            output[pos + 2] = instr >>> 8 & 0xff;
            output[pos + 3] = instr & 0xff;
        }
        pos += 4;
    }
    return output;
}
function createBcjPpcDecoder(properties, unpackSize) {
    return (0, _createBufferingDecoderts.default)(decodeBcjPpc, properties, unpackSize);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }