/**
 * T-31 — Claude 账号池健康度 + 熔断。
 *
 * 规约(见 01-SPEC F-6.3/F-6.5/F-6.6,02-ARCH §5.1):
 *   - onSuccess:清连续失败计数器 + success_count++ + health += 10 (cap 100)
 *                + last_used_at = NOW() + last_error = NULL
 *   - onFailure:连续失败计数器 INCR + fail_count++ + health -= 20 (floor 0)
 *                + last_error = msg + last_used_at = NOW()(表示"最后一次尝试使用
 *                的时间",包括失败)。**连续** 3 次失败(状态从 active 切换时)
 *                → status=cooldown + cooldown_until = now + 10min
 *   - halfOpen:周期性扫 cooldown_until < NOW() 的账号 → status=active + health=50
 *   - manualDisable / manualEnable:超管手工干预
 *
 * Redis 缓存语义(05-ARCH §3):
 *   - `acct:health:<id>` TTL 60s —— 热点账号绕过 DB 读 health_score
 *   - `acct:fail:<id>` TTL 600s(= 默认 cooldown 周期)—— 连续失败计数器,
 *     onSuccess / halfOpen / manualDisable 都会清,熔断触发后也清,
 *     这样下一轮 half-open 后从 0 重新开始累积
 *
 * 错误边界:
 *   - accountId 不存在 → 所有写入类 API 返 null(不抛)+ 清 Redis 计数器防脏数据
 *   - health 变化失败(DB 错)→ 透传给调用方(hot-path 通常由 scheduler 捕获)
 *
 * 与 T-30/T-32 的边界:
 *   - 本模块**不管** OAuth token、解密、调度选择;只管 health/status 变更
 *   - status='disabled'/'banned' 下,onSuccess/onFailure 仍会更新计数 + health,
 *     但**不会**改 status(只有 manualEnable 能救回 disabled;banned 永久)
 */

import type { QueryResultRow } from "pg";
import { query } from "../db/queries.js";
import type { AccountStatus } from "./store.js";

/** 连续失败多少次后熔断。规约值 3,可测试覆盖。 */
export const DEFAULT_FAIL_THRESHOLD = 3;
/** 熔断持续时长 —— 10 分钟。 */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
/** Redis health 缓存 TTL —— 60s。 */
export const DEFAULT_HEALTH_TTL_SEC = 60;
/** Redis 连续失败计数器 TTL —— 与 cooldown 一致 10min。 */
export const DEFAULT_FAIL_WINDOW_SEC = 10 * 60;

export interface AccountHealth {
  id: bigint;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
}

/**
 * Redis 抽象 —— 只用到 get/set/incr/expire/del 5 个命令。
 * 生产注入 ioredis,测试用 InMemoryHealthRedis。
 */
export interface HealthRedis {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, opts?: { exSec?: number }): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, sec: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface HealthDeps {
  redis: HealthRedis;
  now?: () => Date;
  /** 熔断阈值(连续失败次数),默认 3 */
  failThreshold?: number;
  /** 熔断时长(ms),默认 10min */
  cooldownMs?: number;
  /** Redis health 缓存 TTL(秒),默认 60 */
  healthTtlSec?: number;
  /** 连续失败计数器 TTL(秒),默认 600 */
  failWindowSec?: number;
}

export function healthKey(accountId: bigint | string): string {
  return `acct:health:${String(accountId)}`;
}
export function failKey(accountId: bigint | string): string {
  return `acct:fail:${String(accountId)}`;
}

interface RawHealthRow extends QueryResultRow {
  id: string;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
}

function parseHealth(row: RawHealthRow): AccountHealth {
  return {
    id: BigInt(row.id),
    status: row.status,
    health_score: row.health_score,
    cooldown_until: row.cooldown_until,
  };
}

export class AccountHealthTracker {
  private readonly redis: HealthRedis;
  private readonly now: () => Date;
  private readonly failThreshold: number;
  private readonly cooldownMs: number;
  private readonly healthTtlSec: number;
  private readonly failWindowSec: number;

  constructor(deps: HealthDeps) {
    this.redis = deps.redis;
    this.now = deps.now ?? ((): Date => new Date());
    this.failThreshold = deps.failThreshold ?? DEFAULT_FAIL_THRESHOLD;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.healthTtlSec = deps.healthTtlSec ?? DEFAULT_HEALTH_TTL_SEC;
    this.failWindowSec = deps.failWindowSec ?? DEFAULT_FAIL_WINDOW_SEC;
  }

  /**
   * 成功回调:清连续失败计数 + 积分恢复。
   *
   * @returns 账号当前 health;不存在返 null
   */
  async onSuccess(accountId: bigint | string): Promise<AccountHealth | null> {
    const id = String(accountId);
    // 先清连续失败计数,避免"成功后仍残留 2 次失败,再一次失败就熔断"
    await this.redis.del(failKey(id));
    const res = await query<RawHealthRow>(
      `UPDATE claude_accounts
       SET success_count = success_count + 1,
           health_score = LEAST(100, health_score + 10),
           last_used_at = NOW(),
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id, status, health_score, cooldown_until`,
      [id],
    );
    if (res.rowCount === 0) {
      await this.redis.del(healthKey(id));
      return null;
    }
    const h = parseHealth(res.rows[0]);
    await this.redis.set(healthKey(id), String(h.health_score), { exSec: this.healthTtlSec });
    return h;
  }

  /**
   * 失败回调:记录错误 + 失败计数 +(必要时)熔断。
   *
   * 熔断条件 = 连续失败计数 ≥ threshold **且** 当前 status='active'。
   * 熔断后清连续失败计数器,下一轮 halfOpen 恢复后从 0 重新累积。
   *
   * @param errorMsg 可选的错误信息,会写 last_error 列;不想覆盖则传 null
   */
  async onFailure(
    accountId: bigint | string,
    errorMsg: string | null = null,
  ): Promise<AccountHealth | null> {
    const id = String(accountId);
    const failCount = await this.redis.incr(failKey(id));
    if (failCount === 1) {
      // 第一次失败才设 TTL,避免每次失败都续期"永远过期不了"
      await this.redis.expire(failKey(id), this.failWindowSec);
    }

    const res = await query<RawHealthRow>(
      `UPDATE claude_accounts
       SET fail_count = fail_count + 1,
           health_score = GREATEST(0, health_score - 20),
           last_error = COALESCE($2, last_error),
           last_used_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id, status, health_score, cooldown_until`,
      [id, errorMsg],
    );
    if (res.rowCount === 0) {
      await this.redis.del(failKey(id));
      await this.redis.del(healthKey(id));
      return null;
    }
    let row = res.rows[0];

    if (failCount >= this.failThreshold && row.status === "active") {
      const cooldownUntil = new Date(this.now().getTime() + this.cooldownMs);
      const r2 = await query<RawHealthRow>(
        `UPDATE claude_accounts
         SET status = 'cooldown',
             cooldown_until = $2,
             updated_at = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING id::text AS id, status, health_score, cooldown_until`,
        [id, cooldownUntil],
      );
      if ((r2.rowCount ?? 0) > 0) {
        row = r2.rows[0];
      }
      // 熔断触发后清计数,下一轮 half-open 恢复从 0 开始
      await this.redis.del(failKey(id));
    }

    const h = parseHealth(row);
    await this.redis.set(healthKey(id), String(h.health_score), { exSec: this.healthTtlSec });
    return h;
  }

  /**
   * 半开恢复:所有 cooldown_until < NOW() 的 cooldown 账号 → active + health=50。
   *
   * @returns 恢复的账号列表(可能为空)
   */
  async halfOpen(): Promise<AccountHealth[]> {
    const res = await query<RawHealthRow>(
      `UPDATE claude_accounts
       SET status = 'active',
           health_score = 50,
           cooldown_until = NULL,
           updated_at = NOW()
       WHERE status = 'cooldown'
         AND cooldown_until IS NOT NULL
         AND cooldown_until < NOW()
       RETURNING id::text AS id, status, health_score, cooldown_until`,
    );
    const recovered = res.rows.map(parseHealth);
    for (const h of recovered) {
      await this.redis.set(healthKey(h.id.toString()), String(h.health_score), {
        exSec: this.healthTtlSec,
      });
      await this.redis.del(failKey(h.id.toString()));
    }
    return recovered;
  }

  /**
   * 超管手工禁用账号(status='disabled',保留 health 以便 UI 展示历史)。
   * 清 Redis 计数 + 缓存。
   */
  async manualDisable(
    accountId: bigint | string,
    reason: string | null = null,
  ): Promise<AccountHealth | null> {
    const id = String(accountId);
    const res = await query<RawHealthRow>(
      `UPDATE claude_accounts
       SET status = 'disabled',
           last_error = COALESCE($2, last_error),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id, status, health_score, cooldown_until`,
      [id, reason],
    );
    if (res.rowCount === 0) return null;
    await this.redis.del(healthKey(id));
    await this.redis.del(failKey(id));
    return parseHealth(res.rows[0]);
  }

  /**
   * 超管手工启用账号(status='active' + health=100 + 清 cooldown_until + 清 last_error)。
   */
  async manualEnable(accountId: bigint | string): Promise<AccountHealth | null> {
    const id = String(accountId);
    const res = await query<RawHealthRow>(
      `UPDATE claude_accounts
       SET status = 'active',
           health_score = 100,
           cooldown_until = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id::text AS id, status, health_score, cooldown_until`,
      [id],
    );
    if (res.rowCount === 0) return null;
    await this.redis.set(healthKey(id), "100", { exSec: this.healthTtlSec });
    await this.redis.del(failKey(id));
    return parseHealth(res.rows[0]);
  }

  /**
   * 读账号 health_score —— 先 Redis,miss 回 DB 并回填。
   * 不存在返 null。
   */
  async getHealthScore(accountId: bigint | string): Promise<number | null> {
    const id = String(accountId);
    const cached = await this.redis.get(healthKey(id));
    if (cached !== null) {
      const n = Number(cached);
      if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
    }
    const res = await query<{ health_score: number }>(
      `SELECT health_score FROM claude_accounts WHERE id = $1`,
      [id],
    );
    if (res.rowCount === 0) return null;
    const score = res.rows[0].health_score;
    await this.redis.set(healthKey(id), String(score), { exSec: this.healthTtlSec });
    return score;
  }

  /** 测试/调试辅助:读 Redis 里当前的连续失败计数。 */
  async peekFailCount(accountId: bigint | string): Promise<number> {
    const raw = await this.redis.get(failKey(String(accountId)));
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
}

/**
 * 内存版 HealthRedis —— 仅用于测试。带 TTL 支持,过期后 get 返 null。
 *
 * 不是完整 Redis 语义(比如 LRU、pipelining),但对 health 场景够用。
 */
export class InMemoryHealthRedis implements HealthRedis {
  private readonly store = new Map<string, { val: string; expAt: number | null }>();

  private cleanIfExpired(key: string): void {
    const e = this.store.get(key);
    if (!e) return;
    if (e.expAt !== null && e.expAt <= Date.now()) this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.cleanIfExpired(key);
    return this.store.get(key)?.val ?? null;
  }

  async set(key: string, val: string, opts?: { exSec?: number }): Promise<void> {
    const expAt = opts?.exSec !== undefined ? Date.now() + opts.exSec * 1000 : null;
    this.store.set(key, { val, expAt });
  }

  async incr(key: string): Promise<number> {
    this.cleanIfExpired(key);
    const cur = this.store.get(key);
    const n = (cur ? Number(cur.val) : 0) + 1;
    this.store.set(key, { val: String(n), expAt: cur?.expAt ?? null });
    return n;
  }

  async expire(key: string, sec: number): Promise<void> {
    const cur = this.store.get(key);
    if (!cur) return;
    cur.expAt = Date.now() + sec * 1000;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** 测试辅助:看 key 的 TTL 毫秒(负数 = 不存在,null = 永不过期)。 */
  ttlMs(key: string): number | null {
    const e = this.store.get(key);
    if (!e) return -1;
    if (e.expAt === null) return null;
    return e.expAt - Date.now();
  }

  /** 测试辅助:全部 key,便于 snapshot。 */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.store.entries()) {
      if (v.expAt !== null && v.expAt <= Date.now()) continue;
      out[k] = v.val;
    }
    return out;
  }
}

/**
 * ioredis → HealthRedis 适配。ioredis 的 `set(k,v,'EX',sec)` 签名固定,
 * 不要和 ioredis 通用 Pipeline 搞混。
 */
export function wrapIoredisForHealth(r: {
  get: (k: string) => Promise<string | null>;
  set: (
    k: string,
    v: string,
    mode?: "EX",
    ex?: number,
  ) => Promise<"OK" | null>;
  incr: (k: string) => Promise<number>;
  expire: (k: string, sec: number) => Promise<number>;
  del: (k: string) => Promise<number>;
}): HealthRedis {
  return {
    async get(key) {
      return r.get(key);
    },
    async set(key, val, opts) {
      if (opts?.exSec !== undefined) {
        await r.set(key, val, "EX", opts.exSec);
      } else {
        await r.set(key, val);
      }
    },
    async incr(key) {
      return r.incr(key);
    },
    async expire(key, sec) {
      await r.expire(key, sec);
    },
    async del(key) {
      await r.del(key);
    },
  };
}
