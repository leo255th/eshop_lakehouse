"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_RANGE = void 0;
exports.parseRange = parseRange;
exports.isEmpty = isEmpty;
exports.inRange = inRange;
exports.rangeSize = rangeSize;
exports.buildSqlCondition = buildSqlCondition;
exports.describe = describe;
exports.randomInRange = randomInRange;
exports.EMPTY_RANGE = { ranges: [], raw: '' };
function parseRange(expr) {
    if (!expr || expr.trim() === '')
        return exports.EMPTY_RANGE;
    const ranges = [];
    for (const partRaw of expr.split(',')) {
        const part = partRaw.trim();
        if (part === '')
            continue;
        if (part.includes('-')) {
            const dashAt = part.indexOf('-');
            const loStr = part.slice(0, dashAt).trim();
            const hiStr = part.slice(dashAt + 1).trim();
            const lo = loStr === '' ? 1 : Number(loStr);
            const hi = hiStr === '' ? Number.MAX_SAFE_INTEGER : Number(hiStr);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
                throw new Error(`范围表达式非法："${part}"（应为 100-200 / 100- / -200）`);
            }
            if (lo > hi) {
                throw new Error(`范围表达式非法："${part}"（下界 ${lo} 大于上界 ${hi}）`);
            }
            ranges.push({ min: lo, max: hi });
        }
        else {
            const id = Number(part);
            if (!Number.isInteger(id) || id < 1) {
                throw new Error(`范围表达式非法："${part}"（应为正整数 ID）`);
            }
            ranges.push({ min: id, max: id });
        }
    }
    if (ranges.length === 0)
        return exports.EMPTY_RANGE;
    ranges.sort((a, b) => a.min - b.min);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const cur = ranges[i];
        if (cur.min <= last.max + 1) {
            last.max = Math.max(last.max, cur.max);
        }
        else {
            merged.push({ ...cur });
        }
    }
    return { ranges: merged, raw: expr };
}
function isEmpty(f) {
    return !f || f.ranges.length === 0;
}
function inRange(f, id) {
    if (isEmpty(f))
        return true;
    for (const r of f.ranges) {
        if (id >= r.min && id <= r.max)
            return true;
    }
    return false;
}
function rangeSize(f) {
    if (isEmpty(f))
        return 0;
    let n = 0;
    for (const r of f.ranges) {
        n += r.max - r.min + 1;
        if (n > Number.MAX_SAFE_INTEGER / 2)
            return Number.MAX_SAFE_INTEGER;
    }
    return n;
}
function buildSqlCondition(f, column, params) {
    if (isEmpty(f))
        return '';
    const parts = [];
    for (const r of f.ranges) {
        if (r.min === r.max) {
            parts.push(`${column} = ?`);
            params.push(r.min);
        }
        else if (r.max === Number.MAX_SAFE_INTEGER) {
            parts.push(`${column} >= ?`);
            params.push(r.min);
        }
        else {
            parts.push(`${column} BETWEEN ? AND ?`);
            params.push(r.min, r.max);
        }
    }
    return ` AND (${parts.join(' OR ')})`;
}
function describe(f) {
    if (isEmpty(f))
        return '(未限定)';
    return f.ranges
        .map((r) => r.max === Number.MAX_SAFE_INTEGER
        ? `${r.min}+`
        : r.min === r.max
            ? `${r.min}`
            : `${r.min}-${r.max}`)
        .join(',');
}
function randomInRange(f, fallbackMax, rng) {
    if (isEmpty(f))
        return rng.int(1, Math.max(1, fallbackMax));
    const rs = f.ranges;
    const pickIdx = rng.int(0, rs.length - 1);
    const r = rs[pickIdx];
    const hi = Math.min(r.max, Number.MAX_SAFE_INTEGER === r.max ? fallbackMax : r.max);
    const lo = Math.min(r.min, hi);
    return rng.int(lo, hi);
}
//# sourceMappingURL=range-filter.js.map