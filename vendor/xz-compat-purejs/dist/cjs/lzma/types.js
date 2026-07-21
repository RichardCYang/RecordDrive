/**
 * LZMA Types and Constants
 *
 * Shared types, constants, and state transition functions for LZMA decoding.
 * Based on the LZMA SDK specification.
 */ // LZMA State Machine Constants
"use strict";
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
    get LZMA2_CONTROL () {
        return LZMA2_CONTROL;
    },
    get getLenToPosState () {
        return getLenToPosState;
    },
    get initBitModels () {
        return initBitModels;
    },
    get kAlignMask () {
        return kAlignMask;
    },
    get kAlignTableSize () {
        return kAlignTableSize;
    },
    get kBitModelTotal () {
        return kBitModelTotal;
    },
    get kDicLogSizeMin () {
        return kDicLogSizeMin;
    },
    get kEndPosModelIndex () {
        return kEndPosModelIndex;
    },
    get kMatchMaxLen () {
        return kMatchMaxLen;
    },
    get kMatchMinLen () {
        return kMatchMinLen;
    },
    get kNumAlignBits () {
        return kNumAlignBits;
    },
    get kNumBitModelTotalBits () {
        return kNumBitModelTotalBits;
    },
    get kNumFullDistances () {
        return kNumFullDistances;
    },
    get kNumHighLenBits () {
        return kNumHighLenBits;
    },
    get kNumLenSymbols () {
        return kNumLenSymbols;
    },
    get kNumLenToPosStates () {
        return kNumLenToPosStates;
    },
    get kNumLenToPosStatesBits () {
        return kNumLenToPosStatesBits;
    },
    get kNumLitContextBitsMax () {
        return kNumLitContextBitsMax;
    },
    get kNumLitPosStatesBitsEncodingMax () {
        return kNumLitPosStatesBitsEncodingMax;
    },
    get kNumLowLenBits () {
        return kNumLowLenBits;
    },
    get kNumLowLenSymbols () {
        return kNumLowLenSymbols;
    },
    get kNumMidLenBits () {
        return kNumMidLenBits;
    },
    get kNumMidLenSymbols () {
        return kNumMidLenSymbols;
    },
    get kNumMoveBits () {
        return kNumMoveBits;
    },
    get kNumPosModels () {
        return kNumPosModels;
    },
    get kNumPosSlotBits () {
        return kNumPosSlotBits;
    },
    get kNumPosStatesBitsEncodingMax () {
        return kNumPosStatesBitsEncodingMax;
    },
    get kNumPosStatesBitsMax () {
        return kNumPosStatesBitsMax;
    },
    get kNumPosStatesEncodingMax () {
        return kNumPosStatesEncodingMax;
    },
    get kNumPosStatesMax () {
        return kNumPosStatesMax;
    },
    get kNumRepDistances () {
        return kNumRepDistances;
    },
    get kNumStates () {
        return kNumStates;
    },
    get kProbInitValue () {
        return kProbInitValue;
    },
    get kStartPosModelIndex () {
        return kStartPosModelIndex;
    },
    get lzma2IsUncompressed () {
        return lzma2IsUncompressed;
    },
    get lzma2NeedsNewProps () {
        return lzma2NeedsNewProps;
    },
    get lzma2NeedsResetProbs () {
        return lzma2NeedsResetProbs;
    },
    get parseLzma2DictionarySize () {
        return parseLzma2DictionarySize;
    },
    get parseProperties () {
        return parseProperties;
    },
    get stateIsCharState () {
        return stateIsCharState;
    },
    get stateUpdateChar () {
        return stateUpdateChar;
    },
    get stateUpdateMatch () {
        return stateUpdateMatch;
    },
    get stateUpdateRep () {
        return stateUpdateRep;
    },
    get stateUpdateShortRep () {
        return stateUpdateShortRep;
    }
});
var kNumRepDistances = 4;
var kNumStates = 12;
var kNumPosSlotBits = 6;
var kDicLogSizeMin = 0;
var kNumLenToPosStatesBits = 2;
var kNumLenToPosStates = 1 << kNumLenToPosStatesBits; // 4
var kMatchMinLen = 2;
var kNumLowLenBits = 3;
var kNumMidLenBits = 3;
var kNumHighLenBits = 8;
var kNumLowLenSymbols = 1 << kNumLowLenBits; // 8
var kNumMidLenSymbols = 1 << kNumMidLenBits; // 8
var kNumLenSymbols = kNumLowLenSymbols + kNumMidLenSymbols + (1 << kNumHighLenBits); // 272
var kMatchMaxLen = kMatchMinLen + kNumLenSymbols - 1; // 273
var kNumAlignBits = 4;
var kAlignTableSize = 1 << kNumAlignBits; // 16
var kAlignMask = kAlignTableSize - 1; // 15
var kStartPosModelIndex = 4;
var kEndPosModelIndex = 14;
var kNumPosModels = kEndPosModelIndex - kStartPosModelIndex; // 10
var kNumFullDistances = 1 << (kEndPosModelIndex >>> 1); // 128
var kNumLitPosStatesBitsEncodingMax = 4;
var kNumLitContextBitsMax = 8;
var kNumPosStatesBitsMax = 4;
var kNumPosStatesMax = 1 << kNumPosStatesBitsMax; // 16
var kNumPosStatesBitsEncodingMax = 4;
var kNumPosStatesEncodingMax = 1 << kNumPosStatesBitsEncodingMax; // 16
var kNumBitModelTotalBits = 11;
var kBitModelTotal = 1 << kNumBitModelTotalBits; // 2048
var kNumMoveBits = 5;
var kProbInitValue = kBitModelTotal >>> 1; // 1024
function stateUpdateChar(state) {
    if (state < 4) return 0;
    if (state < 10) return state - 3;
    return state - 6;
}
function stateUpdateMatch(state) {
    return state < 7 ? 7 : 10;
}
function stateUpdateRep(state) {
    return state < 7 ? 8 : 11;
}
function stateUpdateShortRep(state) {
    return state < 7 ? 9 : 11;
}
function stateIsCharState(state) {
    return state < 7;
}
function getLenToPosState(len) {
    len -= kMatchMinLen;
    return len < kNumLenToPosStates ? len : kNumLenToPosStates - 1;
}
function initBitModels(probs, count) {
    if (probs === null) {
        if (count === undefined) {
            throw new Error('count required when probs is null');
        }
        probs = new Uint16Array(count);
    }
    for(var i = 0; i < probs.length; i++){
        probs[i] = kProbInitValue;
    }
    return probs;
}
function parseProperties(properties) {
    if (properties.length < 5) {
        throw new Error('LZMA properties must be at least 5 bytes');
    }
    var d = properties[0] & 0xff;
    var lc = d % 9;
    var remainder = ~~(d / 9);
    var lp = remainder % 5;
    var pb = ~~(remainder / 5);
    if (lc > kNumLitContextBitsMax || lp > 4 || pb > kNumPosStatesBitsMax) {
        throw new Error('Invalid LZMA properties');
    }
    var dictionarySize = 0;
    for(var i = 0; i < 4; i++){
        dictionarySize |= (properties[1 + i] & 0xff) << i * 8;
    }
    return {
        lc: lc,
        lp: lp,
        pb: pb,
        dictionarySize: dictionarySize
    };
}
var LZMA2_CONTROL = {
    END: 0x00,
    UNCOMPRESSED_RESET_DIC: 0x01,
    UNCOMPRESSED: 0x02,
    LZMA_RESET_STATE_NEW_PROP: 0xe0
};
function lzma2NeedsNewProps(control) {
    return control >= 0xe0;
}
function lzma2NeedsResetProbs(control) {
    return control >= 0xa0;
}
function lzma2IsUncompressed(control) {
    return control < 0x80;
}
function parseLzma2DictionarySize(prop) {
    if (prop > 40) {
        throw new Error('Invalid LZMA2 dictionary size property');
    }
    if (prop === 40) {
        return 0xffffffff;
    }
    var base = 2 | prop & 1;
    var exp = (prop >>> 1) + 11;
    return base << exp;
}
/* CJS INTEROP */ if (exports.__esModule && exports.default) { try { Object.defineProperty(exports.default, '__esModule', { value: true }); for (var key in exports) { exports.default[key] = exports[key]; } } catch (_) {}; module.exports = exports.default; }