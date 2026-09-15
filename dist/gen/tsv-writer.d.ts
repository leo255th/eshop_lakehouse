export declare const NULL_TOKEN = "\\N";
export declare function escapeField(v: unknown): string;
export declare function toTsvLine(fields: unknown[]): string;
export declare class TsvWriter {
    readonly path: string;
    private stream;
    private buffer;
    private bufferedBytes;
    private readonly flushAtBytes;
    private readonly drainThreshold;
    rowsWritten: number;
    bytesWritten: number;
    constructor(path: string, opts?: {
        flushBytes?: number;
    });
    write(fields: unknown[]): void;
    writeRaw(line: string): void;
    private flushSync;
    private pendingDrain;
    close(): Promise<void>;
    get needsDrain(): boolean;
    drain(): Promise<void>;
}
export declare function shardFileName(tmpDir: string, table: string, shard: number, sizeKey: string): string;
