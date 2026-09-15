/**
 * TSV 分片写入器
 *
 * 为什么用 TSV 文件 + LOAD DATA 而不是多值 INSERT：
 *   计划 4.2 节：「批量写入用多值 INSERT 比逐条 INSERT 快 10 倍以上；
 *   如果你愿意生成 TSV，LOAD DATA LOCAL INFILE 还能再快 3~5 倍」
 *
 * 1 亿订单 = 1 亿行主表 + 1.7 亿行明细。用 INSERT 需要几个小时，
 * 用 LOAD DATA 可以压到几十分钟。这是三档规模能在合理时间内产出的前提。
 *
 * 格式约定：
 *   - 字段分隔符：\t
 *   - 行分隔符：\n
 *   - NULL：\N（MySQL LOAD DATA 的标准 NULL 表示）
 *   - 字符串字段中的 \t \n \\ 需要转义（本数据源的文本字段已保证不含这些字符，
 *     但仍做防御性转义）
 */

import { createWriteStream, WriteStream } from 'fs';
import { once } from 'events';

export const NULL_TOKEN = '\\N';

/** 转义单字段：TSV 不允许裸 tab/newline/反斜杠 */
export function escapeField(v: unknown): string {
  if (v === null || v === undefined) return NULL_TOKEN;
  const s = typeof v === 'string' ? v : String(v);
  if (s === '') return ''; // 空字符串与 NULL 不同：LOAD DATA 会把 \N 当 NULL
  if (s.includes('\t') || s.includes('\n') || s.includes('\r') || s.includes('\\')) {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }
  return s;
}

/** 把一行（数组）拼成 TSV 行 */
export function toTsvLine(fields: unknown[]): string {
  let line = escapeField(fields[0]);
  for (let i = 1; i < fields.length; i++) {
    line += '\t' + escapeField(fields[i]);
  }
  return line + '\n';
}

/**
 * 批量 TSV 写入器：内部累积到一定行数再落盘，减少 write 调用。
 */
export class TsvWriter {
  private stream: WriteStream;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private readonly flushAtBytes: number;
  private readonly drainThreshold = 4 * 1024 * 1024;

  rowsWritten = 0;
  bytesWritten = 0;

  constructor(
    readonly path: string,
    opts: { flushBytes?: number } = {},
  ) {
    this.flushAtBytes = opts.flushBytes ?? 1 * 1024 * 1024;
    this.stream = createWriteStream(path, { flags: 'w', highWaterMark: 1 << 20 });
  }

  /** 追加一行 */
  write(fields: unknown[]): void {
    const line = toTsvLine(fields);
    this.buffer.push(line);
    this.bufferedBytes += line.length;
    this.rowsWritten++;
    if (this.bufferedBytes >= this.flushAtBytes) {
      this.flushSync();
    }
  }

  /** 追加原始已格式化好的行（高频路径，避免重复拼装） */
  writeRaw(line: string): void {
    this.buffer.push(line);
    this.bufferedBytes += line.length;
    this.rowsWritten++;
    if (this.bufferedBytes >= this.flushAtBytes) {
      this.flushSync();
    }
  }

  /** 同步写缓冲到流（不等待 drain） */
  private flushSync(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    this.bytesWritten += Buffer.byteLength(chunk);
    this.bufferedBytes = 0;
    const ok = this.stream.write(chunk);
    if (!ok) {
      // 背压：流内部会缓冲，这里不阻塞（生成速率远低于磁盘写速时不会触发）
      // 若触发频繁，说明写盘已成瓶颈 —— 由调用方的进度日志体现
      this.pendingDrain = true;
    }
  }

  private pendingDrain = false;

  /** 关闭文件，等待全部落盘 */
  async close(): Promise<void> {
    this.flushSync();
    this.stream.end();
    await once(this.stream, 'finish');
  }

  /** 是否需要等待背压缓解（生成器可周期性调用） */
  get needsDrain(): boolean {
    return this.pendingDrain;
  }

  /** 等待背压缓解 */
  async drain(): Promise<void> {
    if (!this.pendingDrain) return;
    this.pendingDrain = false;
    if (this.stream.writableNeedDrain) {
      await once(this.stream, 'drain');
    }
  }
}

/**
 * 小文件合并辅助：把一个 shard 的多个 part 文件路径汇总，
 * 供 LOAD DATA 顺序导入（单个 LOAD DATA 语句只能读一个文件）。
 */
export function shardFileName(
  tmpDir: string,
  table: string,
  shard: number,
  sizeKey: string,
): string {
  return `${tmpDir}/${table}_${sizeKey}_s${String(shard).padStart(3, '0')}.tsv`;
}
