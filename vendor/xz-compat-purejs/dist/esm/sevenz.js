/**
 * High-Level 7z-Specific Decoders
 *
 * These functions accept properties separately (matching 7z format structure)
 * and execute the bundled pure-JavaScript decoder path.
 *
 * This preserves the API that 7z files require while maintaining
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
 */ import { decodeLzma2 } from './lzma/sync/Lzma2Decoder.js';
import { decodeLzma } from './lzma/sync/LzmaDecoder.js';
import { tryLoadNative } from './native.js';
const schedule = typeof setImmediate === 'function' ? setImmediate : (fn)=>process.nextTick(fn);
/**
 * Decode LZMA-compressed data from a 7z file
 */ export function decode7zLzma(data, properties, unpackSize, callback) {
    const worker = (cb)=>{
        const fallback = ()=>{
            schedule(()=>{
                try {
                    cb(null, decodeLzma(data, properties, unpackSize));
                } catch (err) {
                    cb(err);
                }
            });
        };
        const native = tryLoadNative();
        if (native === null || native === void 0 ? void 0 : native.lzma) {
            try {
                // Defensive unreachable branch retained for upstream API compatibility
                const buf = Buffer.isBuffer(data) ? data : data.toBuffer();
                const promise = native.lzma(buf, properties, unpackSize);
                if (promise && typeof promise.then === 'function') {
                    promise.then((value)=>cb(null, value), fallback);
                    return;
                }
            } catch  {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise((resolve, reject)=>worker((err, value)=>err ? reject(err) : resolve(value)));
}
export function decode7zLzma2(data, properties, unpackSize, callback) {
    const worker = (cb)=>{
        const fallback = ()=>{
            schedule(()=>{
                try {
                    cb(null, decodeLzma2(data, properties, unpackSize));
                } catch (err) {
                    cb(err);
                }
            });
        };
        const native = tryLoadNative();
        if (native === null || native === void 0 ? void 0 : native.lzma2) {
            try {
                // Defensive unreachable branch retained for upstream API compatibility
                const buf = Buffer.isBuffer(data) ? data : data.toBuffer();
                const promise = native.lzma2(buf, properties, unpackSize);
                if (promise && typeof promise.then === 'function') {
                    promise.then((value)=>cb(null, value), fallback);
                    return;
                }
            } catch  {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise((resolve, reject)=>worker((err, value)=>err ? reject(err) : resolve(value)));
}
