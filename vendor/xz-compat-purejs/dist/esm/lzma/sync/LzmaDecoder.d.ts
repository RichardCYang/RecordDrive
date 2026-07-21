/**
 * Synchronous LZMA1 Decoder
 *
 * Decodes LZMA1 compressed data from a buffer.
 * All operations are synchronous.
 */
import { type BufferLike } from 'extract-base-iterator';
import { type OutputSink } from '../types.js';
/**
 * Synchronous LZMA1 decoder
 */
export declare class LzmaDecoder {
    private outWindow;
    private rangeDecoder;
    private isMatchDecoders;
    private isRepDecoders;
    private isRepG0Decoders;
    private isRepG1Decoders;
    private isRepG2Decoders;
    private isRep0LongDecoders;
    private posSlotDecoder;
    private posDecoders;
    private posAlignDecoder;
    private lenDecoder;
    private repLenDecoder;
    private literalDecoder;
    private dictionarySize;
    private dictionarySizeCheck;
    private posStateMask;
    private state;
    private rep0;
    private rep1;
    private rep2;
    private rep3;
    private prevByte;
    private totalPos;
    constructor(outputSink?: OutputSink);
    /**
     * Set dictionary size
     */
    setDictionarySize(dictionarySize: number): boolean;
    /**
     * Set lc, lp, pb properties
     */
    setLcLpPb(lc: number, lp: number, pb: number): boolean;
    /**
     * Set decoder properties from 5-byte buffer
     */
    setDecoderProperties(properties: Buffer | Uint8Array): boolean;
    /**
     * Initialize probability tables
     */
    private initProbabilities;
    /**
     * Reset probabilities only (for LZMA2 state reset)
     */
    resetProbabilities(): void;
    /**
     * Reset dictionary position (for LZMA2 dictionary reset)
     */
    resetDictionary(): void;
    /**
     * Feed uncompressed data into the dictionary (for LZMA2 uncompressed chunks)
     * This updates the sliding window so subsequent LZMA chunks can reference this data.
     */
    feedUncompressed(data: Buffer): void;
    /**
     * Flush any remaining data in the OutWindow to the sink
     */
    flushOutWindow(): void;
    /**
     * Decode LZMA data with streaming output (no buffer accumulation)
     * @param input - Compressed input buffer or BufferList
     * @param inputOffset - Offset into input buffer
     * @param outSize - Expected output size
     * @param solid - If true, preserve state from previous decode
     * @returns Number of bytes written to sink
     */
    decodeWithSink(input: BufferLike, inputOffset: number, outSize: number, solid?: boolean): number;
    /**
     * Decode LZMA data directly into caller's buffer (zero-copy)
     * @param input - Compressed input buffer or BufferList
     * @param inputOffset - Offset into input buffer
     * @param outSize - Expected output size
     * @param output - Pre-allocated output buffer to write to
     * @param outputOffset - Offset in output buffer to start writing
     * @param solid - If true, preserve state from previous decode
     * @returns Number of bytes written
     */
    decodeToBuffer(input: BufferLike, inputOffset: number, outSize: number, output: Buffer, outputOffset: number, solid?: boolean): number;
    /**
     * Decode LZMA data
     * @param input - Compressed input buffer or BufferList
     * @param inputOffset - Offset into input buffer
     * @param outSize - Expected output size
     * @param solid - If true, preserve state from previous decode
     * @returns Decompressed data
     */
    decode(input: BufferLike, inputOffset: number, outSize: number, solid?: boolean): Buffer;
}
/**
 * Decode LZMA1 data synchronously
 *
 * Note: LZMA1 is a low-level format. Native bindings (lzma-native) expect
 * self-describing data (like XZ), but here we accept raw LZMA with properties
 * specified separately. Pure JS implementation is used for LZMA1.
 *
 * @param input - Compressed data (without 5-byte properties header) or BufferList
 * @param properties - 5-byte LZMA properties
 * @param outSize - Expected output size
 * @param outputSink - Optional output sink with write callback for streaming (returns bytes written)
 * @returns Decompressed data (or bytes written if outputSink provided)
 */
export declare function decodeLzma(input: BufferLike, properties: Buffer | Uint8Array, outSize: number, outputSink?: {
    write(buffer: Buffer): void;
}): Buffer | number;
