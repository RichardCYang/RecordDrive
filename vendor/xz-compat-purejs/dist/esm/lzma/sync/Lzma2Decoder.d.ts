/**
 * Synchronous LZMA2 Decoder
 *
 * LZMA2 is a container format that wraps LZMA chunks with framing.
 * Decodes LZMA2 data from a buffer or BufferList.
 */
import { type BufferLike } from 'extract-base-iterator';
import { type OutputSink } from '../types.js';
/**
 * Synchronous LZMA2 decoder
 */
export declare class Lzma2Decoder {
    private lzmaDecoder;
    private dictionarySize;
    constructor(properties: Buffer | Uint8Array, outputSink?: OutputSink);
    /**
     * Reset the dictionary (for stream boundaries)
     */
    resetDictionary(): void;
    /**
     * Reset all probability models (for stream boundaries)
     */
    resetProbabilities(): void;
    /**
     * Set LZMA properties
     */
    setLcLpPb(lc: number, lp: number, pb: number): boolean;
    /**
     * Feed uncompressed data to the dictionary (for subsequent LZMA chunks)
     */
    feedUncompressed(data: Buffer): void;
    /**
     * Decode raw LZMA data (used internally for LZMA2 chunks)
     * @param input - LZMA compressed data
     * @param offset - Input offset
     * @param outSize - Expected output size
     * @param solid - Use solid mode
     * @returns Decompressed data
     */
    decodeLzmaData(input: Buffer, offset: number, outSize: number, solid?: boolean): Buffer;
    /**
     * Decode LZMA2 data with streaming output
     * @param input - LZMA2 compressed data (Buffer or BufferList)
     * @returns Total number of bytes written to sink
     */
    decodeWithSink(input: BufferLike): number;
    /**
     * Decode LZMA2 data
     * @param input - LZMA2 compressed data (Buffer or BufferList)
     * @param unpackSize - Expected output size (optional, for pre-allocation)
     * @returns Decompressed data
     */
    decode(input: BufferLike, unpackSize?: number): Buffer;
}
/**
 * Decode LZMA2 data synchronously
 * @param input - LZMA2 compressed data (Buffer or BufferList)
 * @param properties - 1-byte properties (dictionary size)
 * @param unpackSize - Expected output size (optional, autodetects if not provided)
 * @param outputSink - Optional output sink with write callback for streaming (returns bytes written)
 * @returns Decompressed data (or bytes written if outputSink provided)
 */
export declare function decodeLzma2(input: BufferLike, properties: Buffer | Uint8Array, unpackSize?: number, outputSink?: {
    write(buffer: Buffer): void;
}): Buffer | number;
