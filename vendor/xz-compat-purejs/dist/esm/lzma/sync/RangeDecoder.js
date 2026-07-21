/**
 * Synchronous Range Decoder for LZMA
 *
 * Decodes arithmetic-coded bits from a buffer.
 * All operations are synchronous - for streaming use the async version.
 */ /**
 * Range decoder for synchronous buffer-based LZMA decoding
 */ export class RangeDecoder {
    /**
   * Set input buffer and initialize decoder state
   */ setInput(input, offset = 0) {
        this.pos = offset;
        // One-time binding for byte access (avoids repeated Buffer.isBuffer checks)
        this.getByte = Buffer.isBuffer(input) ? (o)=>input[o] : (o)=>input.readByte(o);
        this.init();
    }
    /**
   * Initialize range decoder (reads first 5 bytes)
   */ init() {
        this.code = 0;
        this.range = -1; // 0xFFFFFFFF as signed int
        // First byte is ignored (should be 0)
        this.pos++;
        // Read 4 bytes into code
        for(let i = 0; i < 4; i++){
            this.code = this.code << 8 | this.getByte(this.pos++);
        }
    }
    /**
   * Get current position in input buffer
   */ getPosition() {
        return this.pos;
    }
    /**
   * Normalize range if needed (read more bytes)
   */ normalize() {
        if ((this.range & 0xff000000) === 0) {
            this.code = this.code << 8 | this.getByte(this.pos++);
            this.range <<= 8;
        }
    }
    /**
   * Decode a single bit using probability model
   * @param probs - Probability array
   * @param index - Index into probability array
   * @returns Decoded bit (0 or 1)
   */ decodeBit(probs, index) {
        const prob = probs[index];
        const newBound = (this.range >>> 11) * prob;
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
    }
    /**
   * Decode direct bits (not probability-based)
   * @param numTotalBits - Number of bits to decode
   * @returns Decoded value
   */ decodeDirectBits(numTotalBits) {
        let result = 0;
        for(let i = numTotalBits; i > 0; i--){
            this.range >>>= 1;
            const t = this.code - this.range >>> 31;
            this.code -= this.range & t - 1;
            result = result << 1 | 1 - t;
            this.normalize();
        }
        return result;
    }
    constructor(){
        this.pos = 0;
        this.code = 0;
        this.range = 0;
        this.getByte = ()=>0;
    }
}
/**
 * Bit tree decoder for multi-bit symbols
 */ export class BitTreeDecoder {
    /**
   * Initialize probability models
   */ init() {
        for(let i = 0; i < this.models.length; i++){
            this.models[i] = 1024; // kProbInitValue
        }
    }
    /**
   * Decode a symbol (forward bit order)
   */ decode(rangeDecoder) {
        let m = 1;
        for(let i = this.numBitLevels; i > 0; i--){
            m = m << 1 | rangeDecoder.decodeBit(this.models, m);
        }
        return m - (1 << this.numBitLevels);
    }
    /**
   * Decode a symbol (reverse bit order)
   */ reverseDecode(rangeDecoder) {
        let m = 1;
        let symbol = 0;
        for(let i = 0; i < this.numBitLevels; i++){
            const bit = rangeDecoder.decodeBit(this.models, m);
            m = m << 1 | bit;
            symbol |= bit << i;
        }
        return symbol;
    }
    constructor(numBitLevels){
        this.numBitLevels = numBitLevels;
        this.models = new Uint16Array(1 << numBitLevels);
        this.init();
    }
}
/**
 * Static reverse decode from external probability array
 */ export function reverseDecodeFromArray(models, startIndex, rangeDecoder, numBitLevels) {
    let m = 1;
    let symbol = 0;
    for(let i = 0; i < numBitLevels; i++){
        const bit = rangeDecoder.decodeBit(models, startIndex + m);
        m = m << 1 | bit;
        symbol |= bit << i;
    }
    return symbol;
}
