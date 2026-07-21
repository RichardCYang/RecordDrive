// BCJ (x86) filter codec - converts x86 CALL/JMP relative addresses
// This is a simple filter that makes executables more compressible by LZMA
//
// BCJ transforms relative addresses in x86 CALL (0xE8) and JMP (0xE9) instructions
// to absolute addresses, which creates more repetitive patterns for compression.
//
// Reference: https://github.com/tukaani-project/xz/blob/master/src/liblzma/simple/x86.c
//
// This implementation uses true streaming - processes data chunk by chunk
// while buffering incomplete instructions across chunk boundaries.
import { allocBuffer, bufferFrom, Transform } from 'extract-base-iterator';
// Test if byte is 0x00 or 0xFF (valid MSB for converted addresses)
function Test86MSByte(b) {
    return b === 0 || b === 0xff;
}
// Lookup table for mask to bit number conversion (used in false positive prevention)
const MASK_TO_BIT_NUMBER = [
    0,
    1,
    2,
    2,
    3
];
/**
 * Core x86 BCJ conversion function (matches reference x86_code)
 * Works for both encoding and decoding based on isEncoder flag
 *
 * @param state - Filter state (prevMask and prevPos)
 * @param nowPos - Current position in the overall stream
 * @param isEncoder - true for encoding, false for decoding
 * @param buffer - Buffer to process (modified in place)
 * @param size - Size of buffer
 * @returns Number of bytes processed
 */ function x86Code(state, nowPos, isEncoder, buffer, size) {
    let prevMask = state.prevMask;
    let prevPos = state.prevPos;
    if (size < 5) {
        return 0;
    }
    // Decay prev_pos if too far from current position
    if (nowPos - prevPos > 5) {
        prevPos = nowPos - 5;
    }
    const limit = size - 5;
    let bufferPos = 0;
    while(bufferPos <= limit){
        const opcode = buffer[bufferPos];
        // Check for CALL (0xE8) or JMP (0xE9) opcode
        if (opcode !== 0xe8 && opcode !== 0xe9) {
            bufferPos++;
            continue;
        }
        // Calculate offset from previous position
        const offset = nowPos + bufferPos - prevPos;
        prevPos = nowPos + bufferPos;
        // Update mask based on offset
        if (offset > 5) {
            prevMask = 0;
        } else {
            for(let i = 0; i < offset; i++){
                prevMask &= 0x77;
                prevMask <<= 1;
            }
        }
        // Get the high byte of the address
        let b = buffer[bufferPos + 4];
        // Check if this looks like a valid address to convert
        if (Test86MSByte(b) && prevMask >> 1 <= 4 && prevMask >> 1 !== 3) {
            // Read 32-bit address (big-endian style: high byte first in src)
            let src = b << 24 | buffer[bufferPos + 3] << 16 | buffer[bufferPos + 2] << 8 | buffer[bufferPos + 1];
            // Make src unsigned 32-bit
            src = src >>> 0;
            let dest;
            // Conversion loop with false positive correction
            while(true){
                if (isEncoder) {
                    dest = src + (nowPos + bufferPos + 5) >>> 0;
                } else {
                    dest = src - (nowPos + bufferPos + 5) >>> 0;
                }
                if (prevMask === 0) {
                    break;
                }
                const i = MASK_TO_BIT_NUMBER[prevMask >> 1];
                b = dest >>> 24 - i * 8 & 0xff;
                if (!Test86MSByte(b)) {
                    break;
                }
                // XOR correction for false positive prevention
                src = (dest ^ (1 << 32 - i * 8) - 1) >>> 0;
            }
            // Write back the converted address
            // High byte: ~(((dest >> 24) & 1) - 1) produces 0x00 or 0xFF
            buffer[bufferPos + 4] = ~((dest >>> 24 & 1) - 1) & 0xff;
            buffer[bufferPos + 3] = dest >>> 16 & 0xff;
            buffer[bufferPos + 2] = dest >>> 8 & 0xff;
            buffer[bufferPos + 1] = dest & 0xff;
            bufferPos += 5;
            prevMask = 0;
        } else {
            bufferPos++;
            prevMask |= 1;
            if (Test86MSByte(b)) {
                prevMask |= 0x10;
            }
        }
    }
    // Save state
    state.prevMask = prevMask;
    state.prevPos = prevPos;
    return bufferPos;
}
/**
 * Decode BCJ (x86) filtered data (synchronous, for buffered use)
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - BCJ filtered data
 * @param _properties - Unused for BCJ
 * @param _unpackSize - Unused for BCJ
 * @returns Unfiltered data
 */ export function decodeBcj(input, _properties, _unpackSize) {
    const output = bufferFrom(input); // Copy since we modify in place
    const state = {
        prevMask: 0,
        prevPos: 0xfffffffb
    };
    x86Code(state, 0, false, output, output.length);
    return output;
}
/**
 * Create a streaming BCJ decoder Transform.
 * Processes data chunk by chunk, buffering incomplete instructions.
 */ export function createBcjDecoder(_properties, _unpackSize) {
    // State that persists across chunks
    const state = {
        prevMask: 0,
        prevPos: 0xfffffffb
    };
    let globalPos = 0; // Position in the overall stream
    let pending = null; // Bytes pending from previous chunk
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
            // We need at least 5 bytes to process an instruction
            if (data.length < 5) {
                pending = data;
                callback(null, allocBuffer(0));
                return;
            }
            // Process the buffer
            const output = bufferFrom(data);
            const processed = x86Code(state, globalPos, false, output, output.length);
            if (processed === 0) {
                // Not enough data to process
                pending = data;
                callback(null, allocBuffer(0));
                return;
            }
            // Output processed bytes, keep unprocessed as pending
            const result = output.slice(0, processed);
            pending = output.slice(processed);
            globalPos += processed;
            callback(null, result);
        },
        flush: function(callback) {
            // Output any remaining pending bytes
            if (pending && pending.length > 0) {
                // Process final bytes - can't convert incomplete instructions
                this.push(pending);
            }
            callback(null);
        }
    });
    return transform;
}
