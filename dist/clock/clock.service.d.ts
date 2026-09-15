export interface ClockOptions {
    epoch?: string | number | null;
    scale?: number;
}
export declare class Clock {
    private readonly epochMs;
    private readonly startedAtReal;
    private scale;
    readonly isVirtual: boolean;
    constructor(opts?: ClockOptions);
    now(): Date;
    nowMs(): number;
    get currentScale(): number;
    setScale(next: number): void;
    get epoch(): Date;
    static format(d: Date, tzOffset?: string): string;
    toSql(d?: Date, tzOffset?: string): string;
    static formatMs(ms: number, tzOffset?: string): string;
    dayIndex(ms?: number): number;
}
export declare function parseOffsetMinutes(tz: string): number;
export declare function initClock(epoch?: string | null, scale?: number): Clock;
export declare function getClock(): Clock;
