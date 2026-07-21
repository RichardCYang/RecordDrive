import type { Transform } from 'stream';
/**
 * Decode SPARC BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * SPARC CALL instruction matching (big-endian):
 * - First byte 0x40 and (second byte & 0xC0) == 0x00, OR
 * - First byte 0x7F and (second byte & 0xC0) == 0xC0
 *
 * @param input - SPARC BCJ filtered data
 * @param _properties - Unused for SPARC BCJ
 * @param _unpackSize - Unused for SPARC BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjSparc(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a SPARC BCJ decoder Transform stream
 */
export declare function createBcjSparcDecoder(properties?: Buffer, unpackSize?: number): Transform;
