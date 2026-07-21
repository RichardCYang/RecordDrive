/**
 * XZ-Compat: XZ/LZMA Decompression Library
 *
 * Pure JavaScript implementation with native acceleration disabled.
 *
 * Uses the bundled JavaScript decoder in every environment.
 */ // ============================================================================
// High-Level APIs (Recommended)
// ============================================================================
// 7z-specific decoders - accept properties separately, try native automatically
export { decode7zLzma, decode7zLzma2 } from './sevenz.js';
// XZ container format - self-describing, works great with native acceleration
export { createXZDecoder, decodeXZ } from './xz/Decoder.js';
// ============================================================================
// Low-Level APIs (Backward Compatibility)
// ============================================================================
// Raw LZMA decoders (for specialized use cases)
export { createLzma2Decoder, createLzmaDecoder, decodeLzma, decodeLzma2 } from './lzma/index.js';
// ============================================================================
// Supporting APIs
// ============================================================================
// Preprocessing filters (BCJ/Delta - used by 7z-iterator)
export * from './filters/index.js';
// Native acceleration utilities
export { isNativeAvailable } from './native.js';
