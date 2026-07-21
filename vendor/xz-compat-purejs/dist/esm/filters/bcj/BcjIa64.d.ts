import type { Transform } from 'stream';
/**
 * Decode IA64 BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - IA64 BCJ filtered data
 * @param _properties - Unused for IA64 BCJ
 * @param _unpackSize - Unused for IA64 BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjIa64(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create an IA64 BCJ decoder Transform stream
 */
export declare function createBcjIa64Decoder(properties?: Buffer, unpackSize?: number): Transform;
