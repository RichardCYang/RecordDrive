import type { Transform as TransformType } from 'stream';
type DecodeFn = (input: Buffer, properties?: Buffer, unpackSize?: number) => Buffer;
/**
 * Helper to create a Transform stream from a synchronous decoder
 *
 * This buffers all input and applies the decoder when the stream ends.
 * This is suitable for codecs that don't support true streaming.
 */
export default function createBufferingDecoder(decodeFn: DecodeFn, properties?: Buffer, unpackSize?: number): InstanceType<typeof TransformType>;
export {};
