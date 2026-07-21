import type { Transform } from 'stream';
/**
 * Decode ARM Thumb BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * ARM Thumb BL instruction format (2 x 16-bit):
 * - First half-word: 1111 0xxx xxxx xxxx (high bits of offset)
 * - Second half-word: 1111 1xxx xxxx xxxx (low bits of offset)
 *
 * @param input - ARM Thumb BCJ filtered data
 * @param _properties - Unused for ARM Thumb BCJ
 * @param _unpackSize - Unused for ARM Thumb BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjArmt(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create an ARM Thumb BCJ decoder Transform stream
 */
export declare function createBcjArmtDecoder(properties?: Buffer, unpackSize?: number): Transform;
