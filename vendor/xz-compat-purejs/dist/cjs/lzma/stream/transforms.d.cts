/**
 * LZMA Transform Stream Wrappers
 *
 * Provides Transform streams for LZMA1 and LZMA2 decompression.
 *
 * LZMA2 streaming works by buffering until a complete chunk is available,
 * then decoding synchronously. LZMA2 chunks are bounded in size (~2MB max
 * uncompressed), so memory usage is predictable and bounded.
 *
 * Performance Optimization:
 * - Uses OutputSink pattern for zero-copy output during decode
 * - Each decoded byte written directly to stream (not buffered then copied)
 * - ~4x faster than previous buffering approach
 *
 * True byte-by-byte async LZMA streaming would require rewriting the entire
 * decoder with continuation-passing style, which is complex and not worth
 * the effort given LZMA2's chunked format.
 */
import { Transform } from 'extract-base-iterator';
/**
 * Create an LZMA2 decoder Transform stream
 *
 * This is a streaming decoder that processes LZMA2 chunks incrementally.
 * Memory usage is O(dictionary_size + max_chunk_size) instead of O(folder_size).
 *
 * @param properties - 1-byte LZMA2 properties (dictionary size)
 * @returns Transform stream that decompresses LZMA2 data
 */
export declare function createLzma2Decoder(properties: Buffer | Uint8Array): InstanceType<typeof Transform>;
/**
 * Create an LZMA1 decoder Transform stream
 *
 * Note: LZMA1 has no chunk boundaries, so this requires knowing the
 * uncompressed size upfront. The stream buffers all input, then
 * decompresses when complete.
 *
 * For true streaming, use LZMA2 which has built-in chunking.
 *
 * Optimization: Pre-allocates input buffer and copies chunks once,
 * avoiding the double-buffering of Buffer.concat().
 *
 * @param properties - 5-byte LZMA properties
 * @param unpackSize - Expected uncompressed size
 * @returns Transform stream that decompresses LZMA1 data
 */
export declare function createLzmaDecoder(properties: Buffer | Uint8Array, unpackSize: number): InstanceType<typeof Transform>;
