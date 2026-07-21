/**
 * Synchronous Range Decoder for LZMA
 *
 * Decodes arithmetic-coded bits from a buffer.
 * All operations are synchronous - for streaming use the async version.
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
    get BitTreeDecoder () {
        return BitTreeDecoder;
    },
    get RangeDecoder () {
        return RangeDecoder;
    },
    get reverseDecodeFromArray () {
        return reverseDecodeFromArray;
    }
});
function _class_call_check(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}
var RangeDecoder = /*#__PURE__*/ function() {
    "use strict";
    function RangeDecoder() {
        _class_call_check(this, RangeDecoder);
        this.pos = 0;
        this.code = 0;
        this.range = 0;
        this.getByte = function() {
            return 0;
        };
    }
    var _proto = RangeDecoder.prototype;
    /**
   * Set input buffer and initialize decoder state
   */ _proto.setInput = function setInput(input) {
        var offset = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0;
        this.pos = offset;
        // One-time binding for byte access (avoids repeated Buffer.isBuffer checks)
        this.getByte = Buffer.isBuffer(input) ? function(o) {
            return input[o];
        } : function(o) {
            return input.readByte(o);
        };
        this.init();
    };
    /**
   * Initialize range decoder (reads first 5 bytes)
   */ _proto.init = function init() {
        this.code = 0;
        this.range = -1; // 0xFFFFFFFF as signed int
        // First byte is ignored (should be 0)
        this.pos++;
        // Read 4 bytes into code
        for(var i = 0; i < 4; i++){
            this.code = this.code << 8 | this.getByte(this.pos++);
        }
    };
    /**
   * Get current position in input buffer
   */ _proto.getPosition = function getPosition() {
        return this.pos;
    };
    /**
   * Normalize range if needed (read more bytes)
   */ _proto.normalize = function normalize() {
        if ((this.range & 0xff000000) === 0) {
            this.code = this.code << 8 | this.getByte(this.pos++);
            this.range <<= 8;
        }
    };
    /**
   * Decode a single bit using probability model
   * @param probs - Probability array
   * @param index - Index into probability array
   * @returns Decoded bit (0 or 1)
   */ _proto.decodeBit = function decodeBit(probs, index) {
        var prob = probs[index];
        var newBound = (this.range >>> 11) * prob;
        if ((this.code ^ 0x80000000) < (newBound ^ 0x80000000)) {
            this.range = newBound;
            probs[index] += 2048 - prob >>> 5;
            this.normalize();
            return 0;
        }
        this.range -= newBound;
        this.code -= newBound;
        probs[index] -= prob >>> 5;
        this.normalize();
        return 1;
    };
    /**
   * Decode direct bits (not probability-based)
   * @param numTotalBits - Number of bits to decode
   * @returns Decoded value
   */ _proto.decodeDirectBits = function decodeDirectBits(numTotalBits) {
        var result = 0;
        for(var i = numTotalBits; i > 0; i--){
            this.range >>>= 1;
            var t = this.code - this.range >>> 31;
            this.code -= this.range & t - 1;
            result = result << 1 | 1 - t;
            this.normalize();
        }
        return result;
    };
    return RangeDecoder;
}();
var BitTreeDecoder = /*#__PURE__*/ function() {
    "use strict";
    function BitTreeDecoder(numBitLevels) {
        _class_call_check(this, BitTreeDecoder);
        this.numBitLevels = numBitLevels;
        this.models = new Uint16Array(1 << numBitLevels);
        this.init();
    }
    var _proto = BitTreeDecoder.prototype;
    /**
   * Initialize probability models
   */ _proto.init = function init() {
        for(var i = 0; i < this.models.length; i++){
            this.models[i] = 1024; // kProbInitValue
        }
    };
    /**
   * Decode a symbol (forward bit order)
   */ _proto.decode = function decode(rangeDecoder) {
        var m = 1;
        for(var i = this.numBitLevels; i > 0; i--){
            m = m << 1 | rangeDecoder.decodeBit(this.models, m);
        }
        return m - (1 << this.numBitLevels);
    };
    /**
   * Decode a symbol (reverse bit order)
   */ _proto.reverseDecode = function reverseDecode(rangeDecoder) {
        var m = 1;
        var symbol = 0;
        for(var i = 0; i < this.numBitLevels; i++){
            var bit = rangeDecoder.decodeBit(this.models, m);
            m = m << 1 | bit;
            symbol |= bit << i;
        }
        return symbol;
    };
    return BitTreeDecoder;
}();
function reverseDecodeFromArray(models, startIndex, rangeDecoder, numBitLevels) {
    var m = 1;
    var symbol = 0;
    for(var i = 0; i < numBitLevels; i++){
        var bit = rangeDecoder.decodeBit(models, startIndex + m);
        m = m << 1 | bit;
        symbol |= bit << i;
    }
    return symbol;
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }