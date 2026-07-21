// BCJ (ARM 32-bit) filter codec - converts ARM branch instruction addresses
// This filter makes ARM executables more compressible by LZMA
//
// ARM branch instructions (BL) use relative addressing. The filter converts
// these to absolute addresses during compression, and back during decompression.
//
// Reference: https://github.com/tukaani-project/xz/blob/master/src/liblzma/simple/arm.c
//
// This implementation uses true streaming - processes data chunk by chunk.
import { allocBuffer, bufferFrom, Transform } from 'extract-base-iterator';
/**
 * Core ARM BCJ conversion function (matches reference arm_code)
 * Works for both encoding and decoding based on isEncoder flag
 *
 * ARM BL instruction format:
 * - 4 bytes aligned
 * - Byte pattern: XX XX XX EB (where EB = 0xEB opcode for BL)
 * - Lower 24 bits are signed offset (in words, not bytes)
 * - ARM pipeline adds +8 to the effective address
 *
 * @param nowPos - Current position in the overall stream
 * @param isEncoder - true for encoding, false for decoding
 * @param buffer - Buffer to process (modified in place)
 * @param size - Size of buffer
 * @returns Number of bytes processed
 */ function armCode(nowPos, isEncoder, buffer, size) {
    // Only process complete 4-byte groups
    size = size & ~3;
    let i = 0;
    for(; i < size; i += 4){
        // Check for BL instruction: byte 3 is 0xEB
        if (buffer[i + 3] === 0xeb) {
            // Read 24-bit value (little-endian in bytes 0-2)
            let src = buffer[i + 2] << 16 | buffer[i + 1] << 8 | buffer[i + 0];
            // Left shift by 2 (convert from words to bytes)
            src <<= 2;
            // Sign-extend from 26-bit to 32-bit
            if (src & 0x02000000) {
                src |= 0xfc000000;
            }
            src = src | 0; // Make signed 32-bit
            let dest;
            if (isEncoder) {
                // Encoding: relative to absolute
                // dest = now_pos + i + 8 + src
                dest = nowPos + i + 8 + src;
            } else {
                // Decoding: absolute to relative
                // dest = src - (now_pos + i + 8)
                dest = src - (nowPos + i + 8);
            }
            // Right shift by 2 (convert back from bytes to words)
            dest >>>= 2;
            // Write back lower 24 bits (little-endian)
            buffer[i + 2] = dest >>> 16 & 0xff;
            buffer[i + 1] = dest >>> 8 & 0xff;
            buffer[i + 0] = dest & 0xff;
        }
    }
    return i;
}
/**
 * Decode ARM BCJ filtered data (synchronous, for buffered use)
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - ARM BCJ filtered data
 * @param _properties - Unused for ARM BCJ
 * @param _unpackSize - Unused for ARM BCJ
 * @returns Unfiltered data
 */ export function decodeBcjArm(input, _properties, _unpackSize) {
    const output = bufferFrom(input); // Copy since we modify in place
    armCode(0, false, output, output.length);
    return output;
}
/**
 * Create a streaming ARM BCJ decoder Transform.
 * Processes data in 4-byte aligned chunks.
 */ export function createBcjArmDecoder(_properties, _unpackSize) {
    let globalPos = 0; // Position in the overall stream (in bytes)
    let pending = null; // Incomplete 4-byte group
    const transform = new Transform({
        transform: (chunk, _encoding, callback)=>{
            // Combine pending bytes with new chunk
            let data;
            if (pending && pending.length > 0) {
                data = Buffer.concat([
                    pending,
                    chunk
                ]);
            } else {
                data = chunk;
            }
            // Process only complete 4-byte groups
            const completeBytes = data.length & ~3;
            if (completeBytes === 0) {
                pending = data;
                callback(null, allocBuffer(0));
                return;
            }
            const output = bufferFrom(data.slice(0, completeBytes));
            pending = data.length > completeBytes ? data.slice(completeBytes) : null;
            armCode(globalPos, false, output, output.length);
            globalPos += completeBytes;
            callback(null, output);
        },
        flush: function(callback) {
            if (pending && pending.length > 0) {
                this.push(pending);
            }
            callback(null);
        }
    });
    return transform;
}
