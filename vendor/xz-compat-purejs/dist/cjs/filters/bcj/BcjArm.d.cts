import { Transform } from 'extract-base-iterator';
/**
 * Decode ARM BCJ filtered data (synchronous, for buffered use)
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - ARM BCJ filtered data
 * @param _properties - Unused for ARM BCJ
 * @param _unpackSize - Unused for ARM BCJ
 * @returns Unfiltered data
 */
export declare function decodeBcjArm(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a streaming ARM BCJ decoder Transform.
 * Processes data in 4-byte aligned chunks.
 */
export declare function createBcjArmDecoder(_properties?: Buffer, _unpackSize?: number): InstanceType<typeof Transform>;
