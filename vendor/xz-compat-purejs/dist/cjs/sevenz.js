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
 */ "use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: Object.getOwnPropertyDescriptor(all, name).get
    });
}
_export(exports, {
    get decode7zLzma () {
        return decode7zLzma;
    },
    get decode7zLzma2 () {
        return decode7zLzma2;
    }
});
var _Lzma2Decoderts = require("./lzma/sync/Lzma2Decoder.js");
var _LzmaDecoderts = require("./lzma/sync/LzmaDecoder.js");
var _nativets = require("./native.js");
var schedule = typeof setImmediate === 'function' ? setImmediate : function(fn) {
    return process.nextTick(fn);
};
function decode7zLzma(data, properties, unpackSize, callback) {
    var worker = function worker(cb) {
        var fallback = function fallback() {
            schedule(function() {
                try {
                    cb(null, (0, _LzmaDecoderts.decodeLzma)(data, properties, unpackSize));
                } catch (err) {
                    cb(err);
                }
            });
        };
        var native = (0, _nativets.tryLoadNative)();
        if (native === null || native === void 0 ? void 0 : native.lzma) {
            try {
                // Defensive unreachable branch retained for upstream API compatibility
                var buf = Buffer.isBuffer(data) ? data : data.toBuffer();
                var promise = native.lzma(buf, properties, unpackSize);
                if (promise && typeof promise.then === 'function') {
                    promise.then(function(value) {
                        return cb(null, value);
                    }, fallback);
                    return;
                }
            } catch (unused) {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise(function(resolve, reject) {
        return worker(function(err, value) {
            return err ? reject(err) : resolve(value);
        });
    });
}
function decode7zLzma2(data, properties, unpackSize, callback) {
    var worker = function worker(cb) {
        var fallback = function fallback() {
            schedule(function() {
                try {
                    cb(null, (0, _Lzma2Decoderts.decodeLzma2)(data, properties, unpackSize));
                } catch (err) {
                    cb(err);
                }
            });
        };
        var native = (0, _nativets.tryLoadNative)();
        if (native === null || native === void 0 ? void 0 : native.lzma2) {
            try {
                // Defensive unreachable branch retained for upstream API compatibility
                var buf = Buffer.isBuffer(data) ? data : data.toBuffer();
                var promise = native.lzma2(buf, properties, unpackSize);
                if (promise && typeof promise.then === 'function') {
                    promise.then(function(value) {
                        return cb(null, value);
                    }, fallback);
                    return;
                }
            } catch (unused) {
            // fall through to fallback
            }
        }
        fallback();
    };
    if (typeof callback === 'function') return worker(callback);
    return new Promise(function(resolve, reject) {
        return worker(function(err, value) {
            return err ? reject(err) : resolve(value);
        });
    });
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }