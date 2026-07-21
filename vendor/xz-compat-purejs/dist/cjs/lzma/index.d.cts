/**
 * LZMA Decoder Module
 *
 * Provides both synchronous and streaming LZMA1/LZMA2 decoders.
 *
 * Synchronous API: Use when input is a complete Buffer
 * Streaming API: Use with Transform streams for memory-efficient decompression
 *
 * LZMA1 vs LZMA2:
 * - LZMA2 is chunked and supports true streaming with bounded memory
 * - LZMA1 has no chunk boundaries and requires buffering all input for streaming
 */
export { createLzma2Decoder, createLzmaDecoder } from './stream/transforms.js';
export { decodeLzma2 } from './sync/Lzma2Decoder.js';
export { decodeLzma } from './sync/LzmaDecoder.js';
