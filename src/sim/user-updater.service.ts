import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { PROVINCES } from './seed-data';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
import { chance, pick, randInt, randomPhone, weightedIndex } from './util';

/**
 * 用户更新器（维表 update 来源）
 *
 * v2 修复：
 *  1. 虚拟时钟：显式写 update_time
 *  2. 主键范围采样替代 `ORDER BY RAND()`（v1 在百万级用户上是全表扫 + 排序）
 *  3. **注销改为软删标记**：v1 是 UPDATE status=0 然后被清理器物理删除，
 *     会让历史指标口径漂移。v2 保留 status=0 语义，物理删除由清理器按配置决定。
 */
@Injectable()
export class UserUpdaterService extends LoopedTask {
  protected readonly logger = new Logger(UserUpdaterService.name);
  private maxUserId = 0;
  private lastBoundsRefresh = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly stats: StatsService,
  ) {
    super();
  }

  private get clock() {
    return this.db.clock;
  }

  /** 主键范围采样 */
  private async sampleUsers(
    needed: number,
  ): Promise<{ user_id: string; email: string; user_level: string }[]> {
    if (this.maxUserId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
      const rows = await this.db.query<{ m: string }>(
        'SELECT IFNULL(MAX(user_id),0) AS m FROM dim_user',
      );
      this.maxUserId = Number(rows[0]?.m ?? 0);
      this.lastBoundsRefresh = Date.now();
    }
    if (this.maxUserId === 0) return [];

    const out: { user_id: string; email: string; user_level: string }[] = [];
    for (let i = 0; i < needed; i++) {
      const anchor = randInt(1, this.maxUserId);
      const rows = await this.db.query<{
        user_id: string;
        email: string;
        user_level: string;
      }>(
        `SELECT user_id, email, user_level FROM dim_user
         WHERE user_id >= ? AND is_deleted = 0
         ORDER BY user_id LIMIT 1`,
        [anchor],
      );
      if (rows[0]) out.push(rows[0]);
    }
    return out;
  }

  protected async tick(): Promise<void> {
    const batch = config.tasks.userUpdate.batch;
    const rows = await this.sampleUsers(batch);
    if (rows.length === 0) return;

    const nowSql = this.clock.toSql();
    let updated = 0;
    let deactivated = 0;

    for (const r of rows) {
      const uid = Number(r.user_id);

      // 正常用户小概率注销（v2：status=0，不物理删除）
      if (chance(0.02)) {
        const res = await this.db.execute(
          'UPDATE dim_user SET status = 0, update_time = ? WHERE user_id = ? AND status = 1',
          [nowSql, uid],
        );
        if (res.affectedRows === 1) {
          deactivated++;
          this.logger.log(`user ${uid} deactivated (注销)`);
        }
        continue;
      }

      const region = pick(PROVINCES);
      const newPhone = randomPhone();
      const newEmail = chance(0.5)
        ? `u${uid}_${randInt(1000, 9999)}@example.com`
        : r.email;
      const newCity = pick(region.cities);
      const newLevel = weightedIndex([60, 30, 10]) + 1;
      const res = await this.db.execute(
        `UPDATE dim_user SET phone = ?, email = ?, city = ?, user_level = ?, update_time = ?
         WHERE user_id = ? AND status = 1`,
        [newPhone, newEmail, newCity, newLevel, nowSql, uid],
      );
      if (res.affectedRows === 1) updated++;
    }

    if (updated > 0 || deactivated > 0) {
      this.stats.counters.usersUpdated += updated;
      this.stats.counters.usersDeactivated += deactivated;
      this.logger.log(
        `user update: +${updated} fields, +${deactivated} deactivated, ` +
          `total updated=${this.stats.counters.usersUpdated}`,
      );
    }
  }
}
