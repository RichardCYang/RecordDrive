import { Transform } from 'extract-base-iterator';
/**
 * Decode BCJ (x86) filtered data (synchronous, for buffered use)
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - BCJ filtered data
 * @param _properties - Unused for BCJ
 * @param _unpackSize - Unused for BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcj(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a streaming BCJ decoder Transform.
 * Processes data chunk by chunk, buffering incomplete instructions.
 */
export declare function createBcjDecoder(_properties?: Buffer, _unpackSize?: number): InstanceType<typeof Transform>;
