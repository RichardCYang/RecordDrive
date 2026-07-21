import { Transform } from 'extract-base-iterator';
/**
 * Decode Delta filtered data (synchronous, for buffered use)
 * Reverses the delta transformation by adding previous values
 *
 * @param input - Delta filtered data
 * @param properties - Optional 1-byte properties (distance - 1)
 * @param _unpackSize - Unused for Delta
 * @returns Unfiltered data
 */
export declare function decodeDelta(input: Buffer, properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a streaming Delta decoder Transform.
 * Processes data chunk by chunk, maintaining state between chunks.
 */
export declare function createDeltaDecoder(properties?: Buffer, _unpackSize?: number): InstanceType<typeof Transform>;
