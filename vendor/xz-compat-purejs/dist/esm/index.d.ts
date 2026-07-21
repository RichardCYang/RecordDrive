/**
 * XZ-Compat: XZ/LZMA Decompression Library
 *
 * Pure JavaScript implementation with optional native acceleration
 * via lzma-native on Node.js 10+.
 *
 * Works on Node.js 0.8+ with automatic performance optimization
 * when native bindings are available.
 */
export { decode7zLzma, decode7zLzma2, type SevenZDecodeCallback } from './sevenz.js';
export { type BufferLike, createXZDecoder, decodeXZ, type XzDecodeCallback } from './xz/Decoder.js';
export { createLzma2Decoder, createLzmaDecoder, decodeLzma, decodeLzma2 } from './lzma/index.js';
export * from './filters/index.js';
export { isNativeAvailable } from './native.js';
export type { DecodeCallback } from './sevenz.js';
