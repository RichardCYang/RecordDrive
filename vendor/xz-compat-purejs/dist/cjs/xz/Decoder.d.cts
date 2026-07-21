/**
 * XZ Decompression Module
 *
 * XZ is a container format that wraps LZMA2 compressed data.
 * This module provides both synchronous and streaming XZ decoders.
 *
 * Pure JavaScript implementation, works on Node.js 0.8+
 *
 * IMPORTANT: Buffer Management Pattern
 *
 * When calling decodeLzma2(), use the direct return pattern:
 *
 * ✅ CORRECT - Fast path:
 *   const output = decodeLzma2(data, props, size) as Buffer;
 *
 * ❌ WRONG - Slow path (do NOT buffer):
 *   const chunks: Buffer[] = [];
 *   decodeLzma2(data, props, size, { write: c => chunks.push(c) });
 *   return Buffer.concat(chunks);  // ← Unnecessary copies!
 */
import { type BufferLike } from 'extract-base-iterator';
import type { Transform as TransformType } from 'stream';
import type { DecodeCallback } from '../sevenz.js';
export type { BufferLike } from 'extract-base-iterator';
/** Callback invoked when an async decode completes */
export type XzDecodeCallback = DecodeCallback<BufferLike>;
/**
 * Decompress XZ data. With a callback the result is provided asynchronously;
 * otherwise a Promise resolves with the decoded data.
 *
 * Returns Buffer for single-block files (most small files).
 * Returns BufferList for multi-block files (avoids large contiguous allocation).
 */
export declare function decodeXZ(input: Buffer, callback: XzDecodeCallback): void;
export declare function decodeXZ(input: Buffer): Promise<BufferLike>;
/**
 * Create an XZ decompression Transform stream
 * @returns Transform stream that decompresses XZ data
 *
 * Uses native lzma-native bindings when available for better performance.
 * Falls back to pure JS implementation on older Node versions or when native is unavailable.
 */
export declare function createXZDecoder(): TransformType;
