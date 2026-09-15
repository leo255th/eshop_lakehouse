"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoopedTask = void 0;
const common_1 = require("@nestjs/common");
class LoopedTask {
    logger = new common_1.Logger(this.constructor.name);
    timer;
    loopDelayMs = 1000;
    paused = false;
    stopped = true;
    running = false;
    start(delayMs) {
        if (delayMs !== undefined)
            this.loopDelayMs = delayMs;
        this.paused = false;
        this.stopped = false;
        this.scheduleNext();
    }
    pause() {
        this.paused = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    resume() {
        if (!this.paused)
            return;
        this.paused = false;
        this.scheduleNext();
    }
    stop() {
        this.paused = true;
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
    setDelay(ms) {
        this.loopDelayMs = Math.max(10, ms);
    }
    onModuleDestroy() {
        this.stop();
    }
    scheduleNext() {
        if (this.paused || this.stopped)
            return;
        this.timer = setTimeout(() => void this.runTick(), this.loopDelayMs);
    }
    async runTick() {
        this.timer = undefined;
        if (this.paused || this.stopped)
            return;
        if (this.running) {
            this.scheduleNext();
            return;
        }
        this.running = true;
        try {
            await this.tick();
        }
        catch (e) {
            this.logger.error(`tick error: ${e.message}`);
        }
        finally {
            this.running = false;
            this.scheduleNext();
        }
    }
}
exports.LoopedTask = LoopedTask;
//# sourceMappingURL=task.base.js.map