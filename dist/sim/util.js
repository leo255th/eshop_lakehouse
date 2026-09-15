"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fromCents = exports.toCents = void 0;
exports.randInt = randInt;
exports.weightedIndex = weightedIndex;
exports.pick = pick;
exports.pickN = pickN;
exports.chance = chance;
exports.randomPhone = randomPhone;
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function weightedIndex(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0)
            return i;
    }
    return weights.length - 1;
}
function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
function pickN(arr, n) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(n, copy.length));
}
function chance(p) {
    return Math.random() < p;
}
const toCents = (s) => Math.round(Number(s) * 100);
exports.toCents = toCents;
const fromCents = (cents) => (cents / 100).toFixed(2);
exports.fromCents = fromCents;
function randomPhone() {
    const head = pick(['13', '15', '17', '18', '19']);
    let tail = '';
    for (let i = 0; i < 9; i++)
        tail += randInt(0, 9);
    return head + tail;
}
//# sourceMappingURL=util.js.map