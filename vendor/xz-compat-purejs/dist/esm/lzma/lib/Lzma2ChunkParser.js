/**
 * LZMA2 Chunk Parser
 *
 * Shared parsing logic for LZMA2 chunk headers.
 * Used by both synchronous and streaming decoders.
 *
 * LZMA2 control byte ranges:
 * 0x00         = End of stream
 * 0x01         = Uncompressed chunk, dictionary reset
 * 0x02         = Uncompressed chunk, no dictionary reset
 * 0x80-0x9F    = LZMA chunk, no reset (solid mode)
 * 0xA0-0xBF    = LZMA chunk, reset state (probabilities)
 * 0xC0-0xDF    = LZMA chunk, reset state + new properties
 * 0xE0-0xFF    = LZMA chunk, reset dictionary + state + new properties
 */ /**
 * Read a byte from BufferLike at offset
 */ function readByte(input, offset) {
    return Buffer.isBuffer(input) ? input[offset] : input.readByte(offset);
}
/**
 * Get length of BufferLike
 */ function getLength(input) {
    return Buffer.isBuffer(input) ? input.length : input.length;
}
/**
 * Parse an LZMA2 chunk header
 *
 * @param input - Input buffer or BufferList
 * @param offset - Offset to start parsing
 * @returns Parsed chunk info or number of bytes needed
 */ export function parseLzma2ChunkHeader(input, offset) {
    const len = getLength(input);
    if (offset >= len) {
        return {
            success: false,
            needBytes: 1
        };
    }
    const control = readByte(input, offset);
    // End of stream
    if (control === 0x00) {
        return {
            success: true,
            chunk: {
                type: 'end',
                headerSize: 1,
                dictReset: false,
                stateReset: false,
                newProps: null,
                uncompSize: 0,
                compSize: 0
            }
        };
    }
    // Uncompressed chunk
    if (control === 0x01 || control === 0x02) {
        // Need 3 bytes: control + 2 size bytes
        if (offset + 3 > len) {
            return {
                success: false,
                needBytes: 3 - (len - offset)
            };
        }
        const uncompSize = (readByte(input, offset + 1) << 8 | readByte(input, offset + 2)) + 1;
        return {
            success: true,
            chunk: {
                type: 'uncompressed',
                headerSize: 3,
                dictReset: control === 0x01,
                stateReset: false,
                newProps: null,
                uncompSize,
                compSize: 0
            }
        };
    }
    // LZMA compressed chunk
    if (control >= 0x80) {
        const hasNewProps = control >= 0xc0;
        const minHeaderSize = hasNewProps ? 6 : 5; // control + 2 uncomp + 2 comp + (1 props)
        if (offset + minHeaderSize > len) {
            return {
                success: false,
                needBytes: minHeaderSize - (len - offset)
            };
        }
        // Parse sizes
        const uncompHigh = control & 0x1f;
        const uncompSize = (uncompHigh << 16 | readByte(input, offset + 1) << 8 | readByte(input, offset + 2)) + 1;
        const compSize = (readByte(input, offset + 3) << 8 | readByte(input, offset + 4)) + 1;
        // Parse properties if present
        let newProps = null;
        if (hasNewProps) {
            const propsByte = readByte(input, offset + 5);
            const lc = propsByte % 9;
            const remainder = ~~(propsByte / 9);
            const lp = remainder % 5;
            const pb = ~~(remainder / 5);
            newProps = {
                lc,
                lp,
                pb
            };
        }
        return {
            success: true,
            chunk: {
                type: 'lzma',
                headerSize: minHeaderSize,
                dictReset: control >= 0xe0,
                stateReset: control >= 0xa0,
                newProps,
                uncompSize,
                compSize
            }
        };
    }
    // Invalid control byte
    throw new Error(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
}
/**
 * Check if we have enough data for the complete chunk (header + data)
 */ export function hasCompleteChunk(input, offset) {
    const result = parseLzma2ChunkHeader(input, offset);
    if (result.success === false) {
        return {
            success: false,
            needBytes: result.needBytes
        };
    }
    const { chunk } = result;
    const dataSize = chunk.type === 'uncompressed' ? chunk.uncompSize : chunk.compSize;
    const totalSize = chunk.headerSize + dataSize;
    const len = getLength(input);
    if (offset + totalSize > len) {
        return {
            success: false,
            needBytes: totalSize - (len - offset)
        };
    }
    return {
        success: true,
        chunk,
        totalSize
    };
}
