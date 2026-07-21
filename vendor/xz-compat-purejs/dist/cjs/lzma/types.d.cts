/**
 * LZMA Types and Constants
 *
 * Shared types, constants, and state transition functions for LZMA decoding.
 * Based on the LZMA SDK specification.
 */
export declare const kNumRepDistances = 4;
export declare const kNumStates = 12;
export declare const kNumPosSlotBits = 6;
export declare const kDicLogSizeMin = 0;
export declare const kNumLenToPosStatesBits = 2;
export declare const kNumLenToPosStates: number;
export declare const kMatchMinLen = 2;
export declare const kNumLowLenBits = 3;
export declare const kNumMidLenBits = 3;
export declare const kNumHighLenBits = 8;
export declare const kNumLowLenSymbols: number;
export declare const kNumMidLenSymbols: number;
export declare const kNumLenSymbols: number;
export declare const kMatchMaxLen: number;
export declare const kNumAlignBits = 4;
export declare const kAlignTableSize: number;
export declare const kAlignMask: number;
export declare const kStartPosModelIndex = 4;
export declare const kEndPosModelIndex = 14;
export declare const kNumPosModels: number;
export declare const kNumFullDistances: number;
export declare const kNumLitPosStatesBitsEncodingMax = 4;
export declare const kNumLitContextBitsMax = 8;
export declare const kNumPosStatesBitsMax = 4;
export declare const kNumPosStatesMax: number;
export declare const kNumPosStatesBitsEncodingMax = 4;
export declare const kNumPosStatesEncodingMax: number;
export declare const kNumBitModelTotalBits = 11;
export declare const kBitModelTotal: number;
export declare const kNumMoveBits = 5;
export declare const kProbInitValue: number;
/**
 * State transition: after literal byte
 */
export declare function stateUpdateChar(state: number): number;
/**
 * State transition: after match
 */
export declare function stateUpdateMatch(state: number): number;
/**
 * State transition: after rep (repeated match)
 */
export declare function stateUpdateRep(state: number): number;
/**
 * State transition: after short rep
 */
export declare function stateUpdateShortRep(state: number): number;
/**
 * Check if state indicates previous symbol was a character (literal)
 */
export declare function stateIsCharState(state: number): boolean;
/**
 * Get length-to-position state index
 */
export declare function getLenToPosState(len: number): number;
/**
 * Initialize probability array with default values
 * @param probs - Array to initialize (or null to create new)
 * @param count - Number of probabilities
 * @returns Initialized probability array
 */
export declare function initBitModels(probs: Uint16Array | null, count?: number): Uint16Array;
/**
 * LZMA properties parsed from the 5-byte header
 */
export interface LzmaProperties {
    /** Literal context bits (0-8) */
    lc: number;
    /** Literal pos bits (0-4) */
    lp: number;
    /** Pos bits (0-4) */
    pb: number;
    /** Dictionary size in bytes */
    dictionarySize: number;
}
/**
 * Parse LZMA properties from a 5-byte buffer
 */
export declare function parseProperties(properties: Buffer | Uint8Array): LzmaProperties;
/**
 * LZMA2 control byte meanings
 */
export declare const LZMA2_CONTROL: {
    readonly END: 0;
    readonly UNCOMPRESSED_RESET_DIC: 1;
    readonly UNCOMPRESSED: 2;
    readonly LZMA_RESET_STATE_NEW_PROP: 224;
};
/**
 * Check if LZMA2 control byte indicates reset state (new properties)
 */
export declare function lzma2NeedsNewProps(control: number): boolean;
/**
 * Check if LZMA2 control byte indicates reset probabilities
 */
export declare function lzma2NeedsResetProbs(control: number): boolean;
/**
 * Check if LZMA2 control byte indicates uncompressed chunk
 */
export declare function lzma2IsUncompressed(control: number): boolean;
/**
 * Parse LZMA2 dictionary size from property byte
 */
export declare function parseLzma2DictionarySize(prop: number): number;
/**
 * Output sink interface for fast streaming decode
 * Can be a Buffer (with write method) or a stream with write() method
 */
export interface OutputSink {
    write(buffer: Buffer): void;
}
