/**
 * 虚拟时钟（Virtual Clock）
 *
 * 解决的问题（对应 实时湖仓构建计划_优化.md 第 4.0 节）：
 *   v1 数据源里几乎所有"当前时间"都来自机器时钟：
 *     - order-generator.service.ts  const orderTime = new Date()
 *     - deletion-cleaner.service.ts WHERE update_time < NOW(3) - INTERVAL n MINUTE
 *     - status-flow.service.ts      SET pay_time = NOW(3)
 *     - schema.sql 的 ON UPDATE CURRENT_TIMESTAMP(3)
 *   这导致「时间旅行」方案直接失效：
 *     批量导入 2025-10 的历史数据后，NOW(3) 是 2026 年，
 *     清理器会把所有订单瞬间批量删除，且 pay_time 会落成 2026 年。
 *
 * 本模块把"业务时间"从"机器真实时间"彻底解耦：
 *   - 所有写入时间必须调用 clock.now()
 *   - scale 支持加速：3600 表示 1 个虚拟小时 / 真实秒
 *   - 提供 SQL 字面量格式化，避免依赖服务器时钟
 *
 * 硬性约束（Code Review 检查项）：src/ 下不允许出现
 *   grep -rn "NOW(\|CURRENT_TIMESTAMP" src/ --include=*.ts
 *   grep -rn "new Date()" src/ --include=*.ts
 *   grep -rn "ON UPDATE CURRENT_TIMESTAMP" sql/schema.sql
 */

export interface ClockOptions {
  /** 虚拟时间起点（ISO 字符串或毫秒）。为空则使用机器真实时间 */
  epoch?: string | number | null;
  /** 加速倍率：1 = 实时 */
  scale?: number;
}

export class Clock {
  private readonly epochMs: number;
  private readonly startedAtReal: number;
  private scale: number;
  /** 是否处于"虚拟时间"模式 */
  readonly isVirtual: boolean;

  constructor(opts: ClockOptions = {}) {
    const raw = opts.epoch;
    if (raw === null || raw === undefined || raw === '') {
      this.epochMs = Date.now();
      this.isVirtual = false;
    } else {
      const ms = typeof raw === 'number' ? raw : Date.parse(raw);
      if (!Number.isFinite(ms)) {
        throw new Error(
          `SIM_EPOCH 无法解析："${raw}"。示例：2025-11-01T00:00:00+08:00`,
        );
      }
      this.epochMs = ms;
      this.isVirtual = true;
    }
    this.startedAtReal = Date.now();
    this.scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
  }

  /** 虚拟当前时间 */
  now(): Date {
    return new Date(this.nowMs());
  }

  /** 虚拟当前时间的毫秒数 */
  nowMs(): number {
    if (!this.isVirtual) return Date.now();
    return this.epochMs + (Date.now() - this.startedAtReal) * this.scale;
  }

  get currentScale(): number {
    return this.scale;
  }

  /**
   * 调整加速倍率，并保证虚拟时间连续（不跳变、不倒流）。
   * 切换时把当前虚拟时刻固化为新的 epoch。
   */
  setScale(next: number): void {
    if (!Number.isFinite(next) || next <= 0) return;
    const frozenEpoch = this.nowMs();
    // epochMs 是 readonly，用内部字段绕过（切换 scale 是受控操作）
    (this as unknown as { epochMs: number }).epochMs = frozenEpoch;
    (this as unknown as { startedAtReal: number }).startedAtReal = Date.now();
    this.scale = next;
  }

  /** 虚拟时间起点（用于日志展示） */
  get epoch(): Date {
    return new Date(this.epochMs);
  }

  // ------------------------------------------------------------------
  // SQL 字面量格式化（统一时区，避免依赖 MySQL 服务器时钟）
  // ------------------------------------------------------------------

  /**
   * 格式化为 MySQL DATETIME(3) 字面量：'YYYY-MM-DD HH:mm:ss.SSS'
   * 按 DB_TZ（默认 +08:00）呈现，与 MySQL 的 default-time-zone 对齐。
   */
  static format(d: Date, tzOffset = '+08:00'): string {
    const shifted = new Date(d.getTime() + parseOffsetMinutes(tzOffset) * 60_000);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return (
      `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
      `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}.` +
      `${p(shifted.getUTCMilliseconds(), 3)}`
    );
  }

  /** 实例方法：按配置时区格式化 */
  toSql(d?: Date, tzOffset = '+08:00'): string {
    return Clock.format(d ?? this.now(), tzOffset);
  }

  /** 从虚拟毫秒时间戳格式化（批量生成器高频使用） */
  static formatMs(ms: number, tzOffset = '+08:00'): string {
    return Clock.format(new Date(ms), tzOffset);
  }

  /**
   * 把虚拟时间按"天"对齐到当天 00:00:00（用于生成日间曲线）。
   * 返回虚拟时间的"日序号"（相对 epoch 的天数，可为负 = 历史数据）。
   */
  dayIndex(ms?: number): number {
    const t = ms ?? this.nowMs();
    return Math.floor((t - this.epochMs) / 86_400_000);
  }
}

/** '+08:00' / '-05:30' → 分钟数 */
export function parseOffsetMinutes(tz: string): number {
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(tz.trim());
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] ?? '0', 10));
}

/** 全局单例（懒创建，便于 CLI 在解析参数后覆盖配置） */
let globalClock: Clock | null = null;

/** 用指定配置重建全局时钟（CLI 入口调用） */
export function initClock(epoch?: string | null, scale?: number): Clock {
  globalClock = new Clock({ epoch: epoch ?? null, scale });
  return globalClock;
}

/** 获取全局时钟 */
export function getClock(): Clock {
  if (!globalClock) {
    // 延迟读取配置，避免 config 与本模块的循环依赖问题
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('../config') as typeof import('../config');
    globalClock = new Clock({
      epoch: config.clock.epoch || null,
      scale: config.clock.scale,
    });
  }
  return globalClock;
}
