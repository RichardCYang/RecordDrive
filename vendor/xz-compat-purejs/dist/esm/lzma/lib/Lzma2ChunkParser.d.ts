/**
 * LZMA2 Chunk Parser
 *
 * Shared parsing logic for LZMA2 chunk headers.
 * Used by both synchronous and streaming decoders.
 *
 * LZMA2 control byte ranges:
 * 0x00         = End of stream
 * 0x01         = Uncompressed chunk, dictionary reset
 * 0x02         = Uncompressed chunk, no dictionary reset
 * 0x80-0x9F    = LZMA chunk, no reset (solid mode)
 * 0xA0-0xBF    = LZMA chunk, reset state (probabilities)
 * 0xC0-0xDF    = LZMA chunk, reset state + new properties
 * 0xE0-0xFF    = LZMA chunk, reset dictionary + state + new properties
 */
import type { BufferLike } from 'extract-base-iterator';
/**
 * LZMA properties extracted from chunk header
 */
export interface LzmaChunkProps {
    lc: number;
    lp: number;
    pb: number;
}
/**
 * Parsed LZMA2 chunk information
 */
export interface Lzma2Chunk {
    /** Chunk type */
    type: 'end' | 'uncompressed' | 'lzma';
    /** Total bytes consumed by header (including control byte) */
    headerSize: number;
    /** Whether to reset dictionary */
    dictReset: boolean;
    /** Whether to reset state/probabilities */
    stateReset: boolean;
    /** New LZMA properties (only for control >= 0xC0) */
    newProps: LzmaChunkProps | null;
    /** Uncompressed data size */
    uncompSize: number;
    /** Compressed data size (0 for uncompressed chunks) */
    compSize: number;
}
/**
 * Result of parsing attempt
 */
export type ParseResult = {
    success: true;
    chunk: Lzma2Chunk;
} | {
    success: false;
    needBytes: number;
};
/**
 * Parse an LZMA2 chunk header
 *
 * @param input - Input buffer or BufferList
 * @param offset - Offset to start parsing
 * @returns Parsed chunk info or number of bytes needed
 */
export declare function parseLzma2ChunkHeader(input: BufferLike, offset: number): ParseResult;
/** Result type for hasCompleteChunk with totalSize included on success */
export type CompleteChunkResult = {
    success: true;
    chunk: Lzma2Chunk;
    totalSize: number;
} | {
    success: false;
    needBytes: number;
};
/**
 * Check if we have enough data for the complete chunk (header + data)
 */
export declare function hasCompleteChunk(input: BufferLike, offset: number): CompleteChunkResult;
