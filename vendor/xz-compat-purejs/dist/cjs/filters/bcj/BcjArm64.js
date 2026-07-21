// BCJ (ARM64/AArch64) filter codec - converts ARM64 branch instruction addresses
// This filter makes ARM64 executables more compressible by LZMA
//
// ARM64 uses 32-bit fixed-width instructions. Branch instructions use 26-bit signed offsets.
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
    get createBcjArm64Decoder () {
        return createBcjArm64Decoder;
    },
    get decodeBcjArm64 () {
        return decodeBcjArm64;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _createBufferingDecoderts = /*#__PURE__*/ _interop_require_default(require("../../utils/createBufferingDecoder.js"));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
function decodeBcjArm64(input, _properties, _unpackSize) {
    var output = (0, _extractbaseiterator.bufferFrom)(input); // Copy since we modify in place
    var pos = 0;
    // Process 4-byte aligned positions
    while(pos + 4 <= output.length){
        // Read 32-bit value (little-endian)
        var instr = output[pos] | output[pos + 1] << 8 | output[pos + 2] << 16 | output[pos + 3] << 24 >>> 0;
        // Check for B/BL instruction: (instr & 0x7C000000) === 0x14000000
        // This matches both B (0x14000000) and BL (0x94000000)
        if ((instr & 0x7c000000) === 0x14000000) {
            // Extract 26-bit offset
            var addr = instr & 0x03ffffff;
            // Sign-extend 26-bit to 32-bit
            if (addr & 0x02000000) {
                addr |= 0xfc000000;
            }
            // Convert absolute to relative: subtract current position (in words)
            var relAddr = addr - (pos >>> 2);
            // Clear old offset and write new one, preserve opcode
            instr = instr & 0xfc000000 | relAddr & 0x03ffffff;
            // Write back (little-endian)
            output[pos] = instr & 0xff;
            output[pos + 1] = instr >>> 8 & 0xff;
            output[pos + 2] = instr >>> 16 & 0xff;
            output[pos + 3] = instr >>> 24 & 0xff;
        }
        pos += 4;
    }
    return output;
}
function createBcjArm64Decoder(properties, unpackSize) {
    return (0, _createBufferingDecoderts.default)(decodeBcjArm64, properties, unpackSize);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }