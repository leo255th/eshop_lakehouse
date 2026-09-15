"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Clock = void 0;
exports.parseOffsetMinutes = parseOffsetMinutes;
exports.initClock = initClock;
exports.getClock = getClock;
class Clock {
    epochMs;
    startedAtReal;
    scale;
    isVirtual;
    constructor(opts = {}) {
        const raw = opts.epoch;
        if (raw === null || raw === undefined || raw === '') {
            this.epochMs = Date.now();
            this.isVirtual = false;
        }
        else {
            const ms = typeof raw === 'number' ? raw : Date.parse(raw);
            if (!Number.isFinite(ms)) {
                throw new Error(`SIM_EPOCH 无法解析："${raw}"。示例：2025-11-01T00:00:00+08:00`);
            }
            this.epochMs = ms;
            this.isVirtual = true;
        }
        this.startedAtReal = Date.now();
        this.scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
    }
    now() {
        return new Date(this.nowMs());
    }
    nowMs() {
        if (!this.isVirtual)
            return Date.now();
        return this.epochMs + (Date.now() - this.startedAtReal) * this.scale;
    }
    get currentScale() {
        return this.scale;
    }
    setScale(next) {
        if (!Number.isFinite(next) || next <= 0)
            return;
        const frozenEpoch = this.nowMs();
        this.epochMs = frozenEpoch;
        this.startedAtReal = Date.now();
        this.scale = next;
    }
    get epoch() {
        return new Date(this.epochMs);
    }
    static format(d, tzOffset = '+08:00') {
        const shifted = new Date(d.getTime() + parseOffsetMinutes(tzOffset) * 60_000);
        const p = (n, w = 2) => String(n).padStart(w, '0');
        return (`${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
            `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}.` +
            `${p(shifted.getUTCMilliseconds(), 3)}`);
    }
    toSql(d, tzOffset = '+08:00') {
        return Clock.format(d ?? this.now(), tzOffset);
    }
    static formatMs(ms, tzOffset = '+08:00') {
        return Clock.format(new Date(ms), tzOffset);
    }
    dayIndex(ms) {
        const t = ms ?? this.nowMs();
        return Math.floor((t - this.epochMs) / 86_400_000);
    }
}
exports.Clock = Clock;
function parseOffsetMinutes(tz) {
    const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(tz.trim());
    if (!m)
        return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] ?? '0', 10));
}
let globalClock = null;
function initClock(epoch, scale) {
    globalClock = new Clock({ epoch: epoch ?? null, scale });
    return globalClock;
}
function getClock() {
    if (!globalClock) {
        const { config } = require('../config');
        globalClock = new Clock({
            epoch: config.clock.epoch || null,
            scale: config.clock.scale,
        });
    }
    return globalClock;
}
//# sourceMappingURL=clock.service.js.map