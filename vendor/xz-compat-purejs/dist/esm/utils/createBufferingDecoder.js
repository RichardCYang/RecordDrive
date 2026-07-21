import { bufferFrom, Transform } from 'extract-base-iterator';
/**
 * Helper to create a Transform stream from a synchronous decoder
 *
 * This buffers all input and applies the decoder when the stream ends.
 * This is suitable for codecs that don't support true streaming.
 */ export default function createBufferingDecoder(decodeFn, properties, unpackSize) {
    const chunks = [];
    let _totalSize = 0;
    return new Transform({
        transform: (chunk, _encoding, callback)=>{
            chunks.push(chunk);
            _totalSize += chunk.length;
            callback();
        },
        flush: function(callback) {
            try {
                // Concatenate all chunks
                const input = bufferFrom(Buffer.concat(chunks));
                // Decode using the synchronous decoder
                const output = decodeFn(input, properties, unpackSize);
                // Push the result
                this.push(output);
                callback();
            } catch (err) {
                callback(err);
            }
        }
    });
}
