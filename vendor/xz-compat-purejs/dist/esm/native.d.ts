export interface NativeDecoderMethods {
  decompress(input: Buffer): Promise<Buffer>;
}
export type RawDecoder = (input: Buffer, properties: Buffer, unpackSize?: number) => Promise<Buffer>;
export interface NativeModule {
  xz?: NativeDecoderMethods;
  lzma?: RawDecoder;
  lzma2?: RawDecoder;
}
/** RecordDrive security fork: always returns null. */
export declare function tryLoadNative(): NativeModule | null;
/** RecordDrive security fork: always returns false. */
export declare function isNativeAvailable(): boolean;
