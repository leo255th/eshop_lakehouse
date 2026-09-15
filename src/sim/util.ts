/** 随机与金额小工具 */

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 按权重随机：weights 数组，返回索引 */
export function weightedIndex(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 无放回抽取 n 个（n >= arr.length 时返回洗牌后的全部） */
export function pickN<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

export function chance(p: number): boolean {
  return Math.random() < p;
}

/** 金额工具：一律以「分」为整数运算，避免浮点误差 */
export const toCents = (s: string | number): number =>
  Math.round(Number(s) * 100);
export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

/** 生成随机手机号（11 位，1[3-9] 开头） */
export function randomPhone(): string {
  const head = pick(['13', '15', '17', '18', '19']);
  let tail = '';
  for (let i = 0; i < 9; i++) tail += randInt(0, 9);
  return head + tail;
}
