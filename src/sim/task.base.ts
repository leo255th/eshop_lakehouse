import { Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * 循环任务基类：setTimeout 链式调度，天然规避异步 tick 重叠；
 * 支持 start / pause / resume / stop，以及动态调整 tick 间隔（供下单速率档位使用）。
 */
export abstract class LoopedTask implements OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  private timer?: NodeJS.Timeout;
  private loopDelayMs = 1000;
  private paused = false;
  private stopped = true;
  private running = false;

  start(delayMs?: number): void {
    if (delayMs !== undefined) this.loopDelayMs = delayMs;
    this.paused = false;
    this.stopped = false;
    this.scheduleNext();
  }

  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.scheduleNext();
  }

  stop(): void {
    this.paused = true;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  setDelay(ms: number): void {
    this.loopDelayMs = Math.max(10, ms);
  }

  onModuleDestroy(): void {
    this.stop();
  }

  private scheduleNext(): void {
    if (this.paused || this.stopped) return;
    this.timer = setTimeout(() => void this.runTick(), this.loopDelayMs);
  }

  private async runTick(): Promise<void> {
    this.timer = undefined;
    if (this.paused || this.stopped) return;
    if (this.running) {
      // 上一次 tick 未结束：跳过本次，避免任务堆积
      this.scheduleNext();
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } catch (e) {
      this.logger.error(`tick error: ${(e as Error).message}`);
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  protected abstract tick(): Promise<void>;
}
