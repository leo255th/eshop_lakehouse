"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromCents = exports.toCents = exports.Rng = void 0;
exports.createRng = createRng;
exports.sampleDiurnalOffset = sampleDiurnalOffset;
exports.sampleEventTime = sampleEventTime;
exports.randomPhone = randomPhone;
exports.splitRanges = splitRanges;
exports.mapLimit = mapLimit;
exports.humanBytes = humanBytes;
exports.humanDuration = humanDuration;
function createRng(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
class Rng {
    next;
    constructor(seed) {
        this.next = createRng(seed);
    }
    float() {
        return this.next();
    }
    int(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }
    range(min, max) {
        return min + this.next() * (max - min);
    }
    bool(p = 0.5) {
        return this.next() < p;
    }
    weightedIndex(weights) {
        const total = weights.reduce((a, b) => a + b, 0);
        let r = this.next() * total;
        for (let i = 0; i < weights.length; i++) {
            r -= weights[i];
            if (r < 0)
                return i;
        }
        return weights.length - 1;
    }
    pick(arr) {
        return arr[Math.floor(this.next() * arr.length)];
    }
    logNormal(sigma = 0.8) {
        const u1 = Math.max(this.next(), 1e-12);
        const u2 = this.next();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.exp(z * sigma);
    }
    shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(this.next() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
}
exports.Rng = Rng;
const toCents = (v) => Math.round(Number(v) * 100);
exports.toCents = toCents;
const fromCents = (cents) => (cents / 100).toFixed(2);
exports.fromCents = fromCents;
const DIURNAL_WEIGHTS = [
    2, 1, 1, 1, 1, 2, 5, 10, 20, 35, 55, 80,
    75, 60, 55, 60, 70, 85, 100, 110, 95, 70, 35, 12,
];
const DIURNAL_TOTAL = DIURNAL_WEIGHTS.reduce((a, b) => a + b, 0);
const DIURNAL_CDF = (() => {
    const cdf = [];
    let acc = 0;
    for (const w of DIURNAL_WEIGHTS) {
        acc += w / DIURNAL_TOTAL;
        cdf.push(acc);
    }
    return cdf;
})();
function sampleDiurnalOffset(rng, pattern) {
    let hourFloat;
    if (pattern === 'uniform') {
        hourFloat = rng.float() * 24;
    }
    else {
        const r = rng.float();
        let hour = 23;
        for (let i = 0; i < DIURNAL_CDF.length; i++) {
            if (r < DIURNAL_CDF[i]) {
                hour = i;
                break;
            }
        }
        hourFloat = hour + rng.float();
    }
    if (pattern === 'flashsale' && rng.bool(0.12)) {
        hourFloat = 20 + rng.float();
    }
    return Math.floor(hourFloat * 3_600_000);
}
function sampleEventTime(rng, startMs, endMs, pattern, recencyBias = 0) {
    const span = endMs - startMs;
    if (span <= 0)
        return startMs;
    let dayFrac;
    if (recencyBias > 0) {
        dayFrac = Math.pow(rng.float(), 1 + recencyBias);
    }
    else {
        dayFrac = rng.float();
    }
    const base = startMs + dayFrac * span;
    const dayStart = Math.floor(base / 86_400_000) * 86_400_000;
    const offset = sampleDiurnalOffset(rng, pattern);
    const t = dayStart + offset;
    if (t < startMs)
        return startMs + Math.floor(rng.float() * Math.min(span, 86_400_000));
    if (t >= endMs)
        return endMs - 1;
    return t;
}
const PHONE_HEADS = ['13', '15', '17', '18', '19'];
function randomPhone(rng) {
    let tail = '';
    for (let i = 0; i < 9; i++)
        tail += rng.int(0, 9);
    return rng.pick(PHONE_HEADS) + tail;
}
function splitRanges(total, shards) {
    const out = [];
    const per = Math.ceil(total / shards);
    for (let s = 0; s < shards; s++) {
        const start = s * per;
        if (start >= total)
            break;
        out.push([start, Math.min(start + per, total)]);
    }
    return out;
}
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
function humanBytes(n) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(1)}${units[i]}`;
}
function humanDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m${s % 60}s`;
    return `${Math.floor(m / 60)}h${m % 60}m`;
}
//# sourceMappingURL=rng.js.map