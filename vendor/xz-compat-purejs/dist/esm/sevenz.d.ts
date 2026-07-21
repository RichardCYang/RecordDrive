/**
 * High-Level 7z-Specific Decoders
 *
 * These functions accept properties separately (matching 7z format structure)
 * and execute either the native lzma-native path or the pure JS fallback.
 *
 * This provides automatic native acceleration for 7z files while maintaining
 * the API that 7z-iterator expects.
 *
 * IMPORTANT: Buffer Management Pattern
 *
 * ❌ SLOW - DO NOT use OutputSink with buffering:
 *   const chunks: Buffer[] = [];
 *   decodeLzma2(data, props, size, { write: c => chunks.push(c) });
 *   return Buffer.concat(chunks);  // ← 3 copies: push + concat + return
 *
 *   OutWindow → chunks.push(chunk) → Buffer.concat(chunks) → result
 *              COPY TO ARRAY              COPY ALL            FINAL BUFFER
 *
 * ✅ FAST - Direct return (let decoder manage buffer):
 *   return decodeLzma2(data, props, size) as Buffer;  // ← 1 copy
 *
 *   OutWindow → pre-allocated buffer → result
 *               DIRECT WRITE
 *
 * The decodeLzma2() function internally pre-allocates the exact output size
 * and writes directly to it. Wrapping with an OutputSink that buffers to an
 * array defeats this optimization by creating unnecessary intermediate copies.
 */
import type { BufferLike } from 'extract-base-iterator';
/** Callback for async decode operations: (error, result) => void */
export type DecodeCallback<T = Buffer> = (error: Error | null, result?: T) => void;
/** Callback invoked when an async 7z decode completes */
export type SevenZDecodeCallback = DecodeCallback<Buffer>;
export declare function decode7zLzma(data: BufferLike, properties: Buffer, unpackSize: number, callback: SevenZDecodeCallback): void;
export declare function decode7zLzma(data: BufferLike, properties: Buffer, unpackSize: number): Promise<Buffer>;
/**
 * Decode LZMA2-compressed data from a 7z file
 */
export declare function decode7zLzma2(data: BufferLike, properties: Buffer, unpackSize: number | undefined, callback: SevenZDecodeCallback): void;
export declare function decode7zLzma2(data: BufferLike, properties: Buffer, unpackSize?: number): Promise<Buffer>;
