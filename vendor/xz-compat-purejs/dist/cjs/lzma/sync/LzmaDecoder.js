/**
 * Synchronous LZMA1 Decoder
 *
 * Decodes LZMA1 compressed data from a buffer.
 * All operations are synchronous.
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
    get LzmaDecoder () {
        return LzmaDecoder;
    },
    get decodeLzma () {
        return decodeLzma;
    }
});
var _extractbaseiterator = require("extract-base-iterator");
var _typests = require("../types.js");
var _RangeDecoderts = require("./RangeDecoder.js");
function _class_call_check(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}
/**
 * Length decoder for match/rep lengths
 */ var LenDecoder = /*#__PURE__*/ function() {
    "use strict";
    function LenDecoder() {
        _class_call_check(this, LenDecoder);
        this.choice = (0, _typests.initBitModels)(null, 2);
        this.lowCoder = [];
        this.midCoder = [];
        this.highCoder = new _RangeDecoderts.BitTreeDecoder(8);
        this.numPosStates = 0;
    }
    var _proto = LenDecoder.prototype;
    _proto.create = function create(numPosStates) {
        for(; this.numPosStates < numPosStates; this.numPosStates++){
            this.lowCoder[this.numPosStates] = new _RangeDecoderts.BitTreeDecoder(3);
            this.midCoder[this.numPosStates] = new _RangeDecoderts.BitTreeDecoder(3);
        }
    };
    _proto.init = function init() {
        (0, _typests.initBitModels)(this.choice);
        for(var i = this.numPosStates - 1; i >= 0; i--){
            this.lowCoder[i].init();
            this.midCoder[i].init();
        }
        this.highCoder.init();
    };
    _proto.decode = function decode(rangeDecoder, posState) {
        if (rangeDecoder.decodeBit(this.choice, 0) === 0) {
            return this.lowCoder[posState].decode(rangeDecoder);
        }
        if (rangeDecoder.decodeBit(this.choice, 1) === 0) {
            return 8 + this.midCoder[posState].decode(rangeDecoder);
        }
        return 16 + this.highCoder.decode(rangeDecoder);
    };
    return LenDecoder;
}();
/**
 * Single literal decoder (decodes one byte)
 */ var LiteralDecoder2 = /*#__PURE__*/ function() {
    "use strict";
    function LiteralDecoder2() {
        _class_call_check(this, LiteralDecoder2);
        this.decoders = (0, _typests.initBitModels)(null, 0x300);
    }
    var _proto = LiteralDecoder2.prototype;
    _proto.init = function init() {
        (0, _typests.initBitModels)(this.decoders);
    };
    _proto.decodeNormal = function decodeNormal(rangeDecoder) {
        var symbol = 1;
        do {
            symbol = symbol << 1 | rangeDecoder.decodeBit(this.decoders, symbol);
        }while (symbol < 0x100);
        return symbol & 0xff;
    };
    _proto.decodeWithMatchByte = function decodeWithMatchByte(rangeDecoder, matchByte) {
        var symbol = 1;
        do {
            var matchBit = matchByte >> 7 & 1;
            matchByte <<= 1;
            var bit = rangeDecoder.decodeBit(this.decoders, (1 + matchBit << 8) + symbol);
            symbol = symbol << 1 | bit;
            if (matchBit !== bit) {
                while(symbol < 0x100){
                    symbol = symbol << 1 | rangeDecoder.decodeBit(this.decoders, symbol);
                }
                break;
            }
        }while (symbol < 0x100);
        return symbol & 0xff;
    };
    return LiteralDecoder2;
}();
/**
 * Literal decoder (array of single decoders)
 */ var LiteralDecoder = /*#__PURE__*/ function() {
    "use strict";
    function LiteralDecoder() {
        _class_call_check(this, LiteralDecoder);
        this.numPosBits = 0;
        this.numPrevBits = 0;
        this.posMask = 0;
        this.coders = [];
    }
    var _proto = LiteralDecoder.prototype;
    _proto.create = function create(numPosBits, numPrevBits) {
        if (this.coders.length > 0 && this.numPrevBits === numPrevBits && this.numPosBits === numPosBits) {
            return;
        }
        this.numPosBits = numPosBits;
        this.posMask = (1 << numPosBits) - 1;
        this.numPrevBits = numPrevBits;
        this.coders = [];
    };
    _proto.init = function init() {
        for(var i = 0; i < this.coders.length; i++){
            if (this.coders[i]) {
                var _this_coders_i;
                (_this_coders_i = this.coders[i]) === null || _this_coders_i === void 0 ? void 0 : _this_coders_i.init();
            }
        }
    };
    _proto.getDecoder = function getDecoder(pos, prevByte) {
        var index = ((pos & this.posMask) << this.numPrevBits) + ((prevByte & 0xff) >>> 8 - this.numPrevBits);
        var decoder = this.coders[index];
        if (!decoder) {
            decoder = new LiteralDecoder2();
            this.coders[index] = decoder;
        }
        return decoder;
    };
    return LiteralDecoder;
}();
/**
 * Output window (sliding dictionary)
 */ var OutWindow = /*#__PURE__*/ function() {
    "use strict";
    function OutWindow(sink) {
        _class_call_check(this, OutWindow);
        this.buffer = (0, _extractbaseiterator.allocBufferUnsafe)(0); // Replaced by create() before use
        this.windowSize = 0;
        this.pos = 0;
        this.sink = sink;
        this.streamPos = 0;
    }
    var _proto = OutWindow.prototype;
    _proto.create = function create(windowSize) {
        if (!this.buffer || this.windowSize !== windowSize) {
            this.buffer = (0, _extractbaseiterator.allocBufferUnsafe)(windowSize);
        }
        this.windowSize = windowSize;
        this.pos = 0;
        this.streamPos = 0;
    };
    _proto.init = function init(solid) {
        if (!solid) {
            this.pos = 0;
            this.streamPos = 0;
        }
    };
    _proto.putByte = function putByte(b) {
        this.buffer[this.pos++] = b;
        if (this.pos >= this.windowSize) {
            if (this.sink) {
                this.flush();
                this.pos = 0;
                this.streamPos = 0; // Reset streamPos after wrap to track new data from pos 0
            } else {
                this.pos = 0;
            }
        }
    };
    _proto.flush = function flush() {
        var size = this.pos - this.streamPos;
        if (size > 0 && this.sink) {
            // Use bufferFrom to create a COPY, not a view - the buffer is reused after wrapping
            var chunk = (0, _extractbaseiterator.bufferFrom)(this.buffer.slice(this.streamPos, this.streamPos + size));
            this.sink.write(chunk);
            this.streamPos = this.pos;
        }
    };
    _proto.getByte = function getByte(distance) {
        var pos = this.pos - distance - 1;
        if (pos < 0) {
            pos += this.windowSize;
        }
        return this.buffer[pos];
    };
    _proto.copyBlock = function copyBlock(distance, len) {
        var pos = this.pos - distance - 1;
        if (pos < 0) {
            pos += this.windowSize;
        }
        for(var i = 0; i < len; i++){
            if (pos >= this.windowSize) {
                pos = 0;
            }
            this.putByte(this.buffer[pos++]);
        }
    };
    /**
   * Copy decoded data to output buffer
   */ _proto.copyTo = function copyTo(output, outputOffset, count) {
        var srcPos = this.pos - count;
        if (srcPos < 0) {
            // Wrap around case - data spans end and beginning of buffer
            var firstPart = -srcPos;
            this.buffer.copy(output, outputOffset, this.windowSize + srcPos, this.windowSize);
            this.buffer.copy(output, outputOffset + firstPart, 0, count - firstPart);
        } else {
            this.buffer.copy(output, outputOffset, srcPos, srcPos + count);
        }
    };
    return OutWindow;
}();
var LzmaDecoder = /*#__PURE__*/ function() {
    "use strict";
    function LzmaDecoder(outputSink) {
        _class_call_check(this, LzmaDecoder);
        this.outWindow = new OutWindow(outputSink);
        this.rangeDecoder = new _RangeDecoderts.RangeDecoder();
        this.isMatchDecoders = (0, _typests.initBitModels)(null, _typests.kNumStates << _typests.kNumPosStatesBitsMax);
        this.isRepDecoders = (0, _typests.initBitModels)(null, _typests.kNumStates);
        this.isRepG0Decoders = (0, _typests.initBitModels)(null, _typests.kNumStates);
        this.isRepG1Decoders = (0, _typests.initBitModels)(null, _typests.kNumStates);
        this.isRepG2Decoders = (0, _typests.initBitModels)(null, _typests.kNumStates);
        this.isRep0LongDecoders = (0, _typests.initBitModels)(null, _typests.kNumStates << _typests.kNumPosStatesBitsMax);
        this.posSlotDecoder = [];
        this.posDecoders = (0, _typests.initBitModels)(null, _typests.kNumFullDistances - _typests.kEndPosModelIndex);
        this.posAlignDecoder = new _RangeDecoderts.BitTreeDecoder(_typests.kNumAlignBits);
        this.lenDecoder = new LenDecoder();
        this.repLenDecoder = new LenDecoder();
        this.literalDecoder = new LiteralDecoder();
        for(var i = 0; i < _typests.kNumLenToPosStates; i++){
            this.posSlotDecoder[i] = new _RangeDecoderts.BitTreeDecoder(_typests.kNumPosSlotBits);
        }
        this.dictionarySize = -1;
        this.dictionarySizeCheck = -1;
        this.posStateMask = 0;
        this.state = 0;
        this.rep0 = 0;
        this.rep1 = 0;
        this.rep2 = 0;
        this.rep3 = 0;
        this.prevByte = 0;
        this.totalPos = 0;
    }
    var _proto = LzmaDecoder.prototype;
    /**
   * Set dictionary size
   */ _proto.setDictionarySize = function setDictionarySize(dictionarySize) {
        if (dictionarySize < 0) return false;
        if (this.dictionarySize !== dictionarySize) {
            this.dictionarySize = dictionarySize;
            this.dictionarySizeCheck = Math.max(dictionarySize, 1);
            this.outWindow.create(Math.max(this.dictionarySizeCheck, 1 << 12));
        }
        return true;
    };
    /**
   * Set lc, lp, pb properties
   */ _proto.setLcLpPb = function setLcLpPb(lc, lp, pb) {
        if (lc > _typests.kNumLitContextBitsMax || lp > 4 || pb > _typests.kNumPosStatesBitsMax) {
            return false;
        }
        var numPosStates = 1 << pb;
        this.literalDecoder.create(lp, lc);
        this.lenDecoder.create(numPosStates);
        this.repLenDecoder.create(numPosStates);
        this.posStateMask = numPosStates - 1;
        return true;
    };
    /**
   * Set decoder properties from 5-byte buffer
   */ _proto.setDecoderProperties = function setDecoderProperties(properties) {
        var props = (0, _typests.parseProperties)(properties);
        if (!this.setLcLpPb(props.lc, props.lp, props.pb)) return false;
        return this.setDictionarySize(props.dictionarySize);
    };
    /**
   * Initialize probability tables
   */ _proto.initProbabilities = function initProbabilities() {
        (0, _typests.initBitModels)(this.isMatchDecoders);
        (0, _typests.initBitModels)(this.isRepDecoders);
        (0, _typests.initBitModels)(this.isRepG0Decoders);
        (0, _typests.initBitModels)(this.isRepG1Decoders);
        (0, _typests.initBitModels)(this.isRepG2Decoders);
        (0, _typests.initBitModels)(this.isRep0LongDecoders);
        (0, _typests.initBitModels)(this.posDecoders);
        this.literalDecoder.init();
        for(var i = _typests.kNumLenToPosStates - 1; i >= 0; i--){
            this.posSlotDecoder[i].init();
        }
        this.lenDecoder.init();
        this.repLenDecoder.init();
        this.posAlignDecoder.init();
    };
    /**
   * Reset probabilities only (for LZMA2 state reset)
   */ _proto.resetProbabilities = function resetProbabilities() {
        this.initProbabilities();
        this.state = 0;
        this.rep0 = 0;
        this.rep1 = 0;
        this.rep2 = 0;
        this.rep3 = 0;
    };
    /**
   * Reset dictionary position (for LZMA2 dictionary reset)
   */ _proto.resetDictionary = function resetDictionary() {
        this.outWindow.init(false);
        this.totalPos = 0;
    };
    /**
   * Feed uncompressed data into the dictionary (for LZMA2 uncompressed chunks)
   * This updates the sliding window so subsequent LZMA chunks can reference this data.
   */ _proto.feedUncompressed = function feedUncompressed(data) {
        for(var i = 0; i < data.length; i++){
            this.outWindow.putByte(data[i]);
        }
        this.totalPos += data.length;
        if (data.length > 0) {
            this.prevByte = data[data.length - 1];
        }
    };
    /**
   * Flush any remaining data in the OutWindow to the sink
   */ _proto.flushOutWindow = function flushOutWindow() {
        this.outWindow.flush();
    };
    /**
   * Decode LZMA data with streaming output (no buffer accumulation)
   * @param input - Compressed input buffer or BufferList
   * @param inputOffset - Offset into input buffer
   * @param outSize - Expected output size
   * @param solid - If true, preserve state from previous decode
   * @returns Number of bytes written to sink
   */ _proto.decodeWithSink = function decodeWithSink(input, inputOffset, outSize) {
        var solid = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : false;
        this.rangeDecoder.setInput(input, inputOffset);
        if (!solid) {
            this.outWindow.init(false);
            this.initProbabilities();
            this.state = 0;
            this.rep0 = 0;
            this.rep1 = 0;
            this.rep2 = 0;
            this.rep3 = 0;
            this.prevByte = 0;
            this.totalPos = 0;
        } else {
            this.outWindow.init(true);
        }
        var outPos = 0;
        var cumPos = this.totalPos;
        while(outPos < outSize){
            var posState = cumPos & this.posStateMask;
            if (this.rangeDecoder.decodeBit(this.isMatchDecoders, (this.state << _typests.kNumPosStatesBitsMax) + posState) === 0) {
                // Literal
                var decoder2 = this.literalDecoder.getDecoder(cumPos, this.prevByte);
                if (!(0, _typests.stateIsCharState)(this.state)) {
                    this.prevByte = decoder2.decodeWithMatchByte(this.rangeDecoder, this.outWindow.getByte(this.rep0));
                } else {
                    this.prevByte = decoder2.decodeNormal(this.rangeDecoder);
                }
                this.outWindow.putByte(this.prevByte);
                outPos++;
                this.state = (0, _typests.stateUpdateChar)(this.state);
                cumPos++;
            } else {
                // Match or rep
                var len = void 0;
                if (this.rangeDecoder.decodeBit(this.isRepDecoders, this.state) === 1) {
                    // Rep match
                    len = 0;
                    if (this.rangeDecoder.decodeBit(this.isRepG0Decoders, this.state) === 0) {
                        if (this.rangeDecoder.decodeBit(this.isRep0LongDecoders, (this.state << _typests.kNumPosStatesBitsMax) + posState) === 0) {
                            this.state = (0, _typests.stateUpdateShortRep)(this.state);
                            len = 1;
                        }
                    } else {
                        var distance = void 0;
                        if (this.rangeDecoder.decodeBit(this.isRepG1Decoders, this.state) === 0) {
                            distance = this.rep1;
                        } else {
                            if (this.rangeDecoder.decodeBit(this.isRepG2Decoders, this.state) === 0) {
                                distance = this.rep2;
                            } else {
                                distance = this.rep3;
                                this.rep3 = this.rep2;
                            }
                            this.rep2 = this.rep1;
                        }
                        this.rep1 = this.rep0;
                        this.rep0 = distance;
                    }
                    if (len === 0) {
                        len = _typests.kMatchMinLen + this.repLenDecoder.decode(this.rangeDecoder, posState);
                        this.state = (0, _typests.stateUpdateRep)(this.state);
                    }
                } else {
                    // Normal match
                    this.rep3 = this.rep2;
                    this.rep2 = this.rep1;
                    this.rep1 = this.rep0;
                    len = _typests.kMatchMinLen + this.lenDecoder.decode(this.rangeDecoder, posState);
                    this.state = (0, _typests.stateUpdateMatch)(this.state);
                    var posSlot = this.posSlotDecoder[(0, _typests.getLenToPosState)(len)].decode(this.rangeDecoder);
                    if (posSlot >= _typests.kStartPosModelIndex) {
                        var numDirectBits = (posSlot >> 1) - 1;
                        this.rep0 = (2 | posSlot & 1) << numDirectBits;
                        if (posSlot < _typests.kEndPosModelIndex) {
                            this.rep0 += (0, _RangeDecoderts.reverseDecodeFromArray)(this.posDecoders, this.rep0 - posSlot - 1, this.rangeDecoder, numDirectBits);
                        } else {
                            this.rep0 += this.rangeDecoder.decodeDirectBits(numDirectBits - _typests.kNumAlignBits) << _typests.kNumAlignBits;
                            this.rep0 += this.posAlignDecoder.reverseDecode(this.rangeDecoder);
                            if (this.rep0 < 0) {
                                if (this.rep0 === -1) break;
                                throw new Error('LZMA: Invalid distance');
                            }
                        }
                    } else {
                        this.rep0 = posSlot;
                    }
                }
                if (this.rep0 >= cumPos || this.rep0 >= this.dictionarySizeCheck) {
                    throw new Error('LZMA: Invalid distance');
                }
                // Copy match bytes
                for(var i = 0; i < len; i++){
                    var b = this.outWindow.getByte(this.rep0);
                    this.outWindow.putByte(b);
                    outPos++;
                }
                cumPos += len;
                this.prevByte = this.outWindow.getByte(0);
            }
        }
        this.totalPos = cumPos;
        return outPos;
    };
    /**
   * Decode LZMA data directly into caller's buffer (zero-copy)
   * @param input - Compressed input buffer or BufferList
   * @param inputOffset - Offset into input buffer
   * @param outSize - Expected output size
   * @param output - Pre-allocated output buffer to write to
   * @param outputOffset - Offset in output buffer to start writing
   * @param solid - If true, preserve state from previous decode
   * @returns Number of bytes written
   */ _proto.decodeToBuffer = function decodeToBuffer(input, inputOffset, outSize, output, outputOffset) {
        var solid = arguments.length > 5 && arguments[5] !== void 0 ? arguments[5] : false;
        this.rangeDecoder.setInput(input, inputOffset);
        if (!solid) {
            this.outWindow.init(false);
            this.initProbabilities();
            this.state = 0;
            this.rep0 = 0;
            this.rep1 = 0;
            this.rep2 = 0;
            this.rep3 = 0;
            this.prevByte = 0;
            this.totalPos = 0;
        } else {
            // Solid mode: preserve dictionary state but reinitialize range decoder
            this.outWindow.init(true);
        }
        var outPos = outputOffset;
        var outEnd = outputOffset + outSize;
        var cumPos = this.totalPos;
        while(outPos < outEnd){
            var posState = cumPos & this.posStateMask;
            if (this.rangeDecoder.decodeBit(this.isMatchDecoders, (this.state << _typests.kNumPosStatesBitsMax) + posState) === 0) {
                // Literal
                var decoder2 = this.literalDecoder.getDecoder(cumPos, this.prevByte);
                if (!(0, _typests.stateIsCharState)(this.state)) {
                    this.prevByte = decoder2.decodeWithMatchByte(this.rangeDecoder, this.outWindow.getByte(this.rep0));
                } else {
                    this.prevByte = decoder2.decodeNormal(this.rangeDecoder);
                }
                this.outWindow.putByte(this.prevByte);
                output[outPos++] = this.prevByte;
                this.state = (0, _typests.stateUpdateChar)(this.state);
                cumPos++;
            } else {
                // Match or rep
                var len = void 0;
                if (this.rangeDecoder.decodeBit(this.isRepDecoders, this.state) === 1) {
                    // Rep match
                    len = 0;
                    if (this.rangeDecoder.decodeBit(this.isRepG0Decoders, this.state) === 0) {
                        if (this.rangeDecoder.decodeBit(this.isRep0LongDecoders, (this.state << _typests.kNumPosStatesBitsMax) + posState) === 0) {
                            this.state = (0, _typests.stateUpdateShortRep)(this.state);
                            len = 1;
                        }
                    } else {
                        var distance = void 0;
                        if (this.rangeDecoder.decodeBit(this.isRepG1Decoders, this.state) === 0) {
                            distance = this.rep1;
                        } else {
                            if (this.rangeDecoder.decodeBit(this.isRepG2Decoders, this.state) === 0) {
                                distance = this.rep2;
                            } else {
                                distance = this.rep3;
                                this.rep3 = this.rep2;
                            }
                            this.rep2 = this.rep1;
                        }
                        this.rep1 = this.rep0;
                        this.rep0 = distance;
                    }
                    if (len === 0) {
                        len = _typests.kMatchMinLen + this.repLenDecoder.decode(this.rangeDecoder, posState);
                        this.state = (0, _typests.stateUpdateRep)(this.state);
                    }
                } else {
                    // Normal match
                    this.rep3 = this.rep2;
                    this.rep2 = this.rep1;
                    this.rep1 = this.rep0;
                    len = _typests.kMatchMinLen + this.lenDecoder.decode(this.rangeDecoder, posState);
                    this.state = (0, _typests.stateUpdateMatch)(this.state);
                    var posSlot = this.posSlotDecoder[(0, _typests.getLenToPosState)(len)].decode(this.rangeDecoder);
                    if (posSlot >= _typests.kStartPosModelIndex) {
                        var numDirectBits = (posSlot >> 1) - 1;
                        this.rep0 = (2 | posSlot & 1) << numDirectBits;
                        if (posSlot < _typests.kEndPosModelIndex) {
                            this.rep0 += (0, _RangeDecoderts.reverseDecodeFromArray)(this.posDecoders, this.rep0 - posSlot - 1, this.rangeDecoder, numDirectBits);
                        } else {
                            this.rep0 += this.rangeDecoder.decodeDirectBits(numDirectBits - _typests.kNumAlignBits) << _typests.kNumAlignBits;
                            this.rep0 += this.posAlignDecoder.reverseDecode(this.rangeDecoder);
                            if (this.rep0 < 0) {
                                if (this.rep0 === -1) break; // End marker
                                throw new Error('LZMA: Invalid distance');
                            }
                        }
                    } else {
                        this.rep0 = posSlot;
                    }
                }
                if (this.rep0 >= cumPos || this.rep0 >= this.dictionarySizeCheck) {
                    throw new Error('LZMA: Invalid distance');
                }
                // Copy match bytes
                for(var i = 0; i < len; i++){
                    var b = this.outWindow.getByte(this.rep0);
                    this.outWindow.putByte(b);
                    output[outPos++] = b;
                }
                cumPos += len;
                this.prevByte = this.outWindow.getByte(0);
            }
        }
        this.totalPos = cumPos;
        return outPos - outputOffset;
    };
    /**
   * Decode LZMA data
   * @param input - Compressed input buffer or BufferList
   * @param inputOffset - Offset into input buffer
   * @param outSize - Expected output size
   * @param solid - If true, preserve state from previous decode
   * @returns Decompressed data
   */ _proto.decode = function decode(input, inputOffset, outSize) {
        var solid = arguments.length > 3 && arguments[3] !== void 0 ? arguments[3] : false;
        var output = (0, _extractbaseiterator.allocBufferUnsafe)(outSize);
        this.decodeToBuffer(input, inputOffset, outSize, output, 0, solid);
        return output;
    };
    return LzmaDecoder;
}();
function decodeLzma(input, properties, outSize, outputSink) {
    var decoder = new LzmaDecoder(outputSink);
    decoder.setDecoderProperties(properties);
    if (outputSink) {
        // Zero-copy mode: write to sink during decode
        var bytesWritten = decoder.decodeWithSink(input, 0, outSize, false);
        decoder.flushOutWindow();
        return bytesWritten;
    }
    // Buffering mode: pre-allocated buffer, direct writes (zero-copy)
    return decoder.decode(input, 0, outSize, false);
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }