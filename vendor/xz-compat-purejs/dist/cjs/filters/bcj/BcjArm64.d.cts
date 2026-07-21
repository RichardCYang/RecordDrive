import type { Transform } from 'stream';
/**
 * Decode ARM64 BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * ARM64 B/BL instruction format (little-endian):
 * - 4 bytes aligned
 * - B: opcode 0x14 (000101xx)
 * - BL: opcode 0x94 (100101xx)
 * - Bits 0-25 are 26-bit signed offset (in words)
 *
 * @param input - ARM64 BCJ filtered data
 * @param _properties - Unused for ARM64 BCJ
 * @param _unpackSize - Unused for ARM64 BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjArm64(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create an ARM64 BCJ decoder Transform stream
 */
export declare function createBcjArm64Decoder(properties?: Buffer, unpackSize?: number): Transform;
