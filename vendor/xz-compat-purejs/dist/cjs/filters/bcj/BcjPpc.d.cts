import type { Transform } from 'stream';
/**
 * Decode PowerPC BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * PowerPC B/BL instruction format (big-endian):
 * - 4 bytes aligned
 * - Opcode 0x48 in high byte with AA=0, LK=1 (0x48000001 mask 0xFC000003)
 * - Bits 6-29 are 24-bit signed offset (in words)
 *
 * @param input - PowerPC BCJ filtered data
 * @param _properties - Unused for PowerPC BCJ
 * @param _unpackSize - Unused for PowerPC BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjPpc(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a PowerPC BCJ decoder Transform stream
 */
export declare function createBcjPpcDecoder(properties?: Buffer, unpackSize?: number): Transform;
