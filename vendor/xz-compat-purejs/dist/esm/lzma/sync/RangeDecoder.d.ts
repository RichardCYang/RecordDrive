/**
 * Synchronous Range Decoder for LZMA
 *
 * Decodes arithmetic-coded bits from a buffer.
 * All operations are synchronous - for streaming use the async version.
 */
import type { BufferLike } from 'extract-base-iterator';
/**
 * Range decoder for synchronous buffer-based LZMA decoding
 */
export declare class RangeDecoder {
    private pos;
    private code;
    private range;
    private getByte;
    constructor();
    /**
     * Set input buffer and initialize decoder state
     */
    setInput(input: BufferLike, offset?: number): void;
    /**
     * Initialize range decoder (reads first 5 bytes)
     */
    private init;
    /**
     * Get current position in input buffer
     */
    getPosition(): number;
    /**
     * Normalize range if needed (read more bytes)
     */
    private normalize;
    /**
     * Decode a single bit using probability model
     * @param probs - Probability array
     * @param index - Index into probability array
     * @returns Decoded bit (0 or 1)
     */
    decodeBit(probs: Uint16Array, index: number): number;
    /**
     * Decode direct bits (not probability-based)
     * @param numTotalBits - Number of bits to decode
     * @returns Decoded value
     */
    decodeDirectBits(numTotalBits: number): number;
}
/**
 * Bit tree decoder for multi-bit symbols
 */
export declare class BitTreeDecoder {
    private numBitLevels;
    private models;
    constructor(numBitLevels: number);
    /**
     * Initialize probability models
     */
    init(): void;
    /**
     * Decode a symbol (forward bit order)
     */
    decode(rangeDecoder: RangeDecoder): number;
    /**
     * Decode a symbol (reverse bit order)
     */
    reverseDecode(rangeDecoder: RangeDecoder): number;
}
/**
 * Static reverse decode from external probability array
 */
export declare function reverseDecodeFromArray(models: Uint16Array, startIndex: number, rangeDecoder: RangeDecoder, numBitLevels: number): number;
