import { Logger, OnModuleDestroy } from '@nestjs/common';
export declare abstract class LoopedTask implements OnModuleDestroy {
    protected readonly logger: Logger;
    private timer?;
    private loopDelayMs;
    private paused;
    private stopped;
    private running;
    start(delayMs?: number): void;
    pause(): void;
    resume(): void;
    stop(): void;
    setDelay(ms: number): void;
    onModuleDestroy(): void;
    private scheduleNext;
    private runTick;
    protected abstract tick(): Promise<void>;
}
