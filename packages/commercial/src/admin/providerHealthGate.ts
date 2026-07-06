/**
 * provider 健康度 —— 生效降级集读缓存(动作层 gate,roadmap P3.2)。
 *
 * 消费者:
 *   - master:GET /api/models 给受影响模型注解 degraded:true(不过滤,只标注)。
 *   - egress:proxy 模型闸 —— OC_PROVIDER_HEALTH_ENFORCE=1 时 degraded provider 的模型 503。
 * 两者跑在不同进程,各持一份进程内 TTL 缓存(默认 15s)。provider_ops 极小(~6 行),
 * 读整表 + effectiveHealth 派生,单一权威 = effectiveHealth(不复述三态判定)。
 *
 * fail-soft 铁律(UX 红线:误拦好模型 > 漏拦坏模型):DB 抖动时返回上次缓存或空集 ——
 * 空集 = 视作全健康 = 不降级不拦截,绝不因读失败误判降级。
 */

import { query, type QueryRunner } from "../db/queries.js";
import { effectiveHealth, type ProviderHealthRow } from "./providerHealth.js";

const DEFAULT_TTL_MS = 15_000;

function ttlMs(): number {
  const raw = Number(process.env.OC_PROVIDER_HEALTH_GATE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

interface CacheEntry {
  set: Set<string>;
  at: number;
}
let cache: CacheEntry | null = null;

type Row = {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
  degraded_since: Date | null;
  degrade_reason: string | null;
};

/**
 * 当前「生效降级」的 provider id 集合(TTL 缓存)。
 * @param now  注入时钟(测试用)。
 * @param runner 注入 query runner(测试用)。
 */
export async function getDegradedProviders(
  now: number = Date.now(),
  runner?: QueryRunner,
): Promise<Set<string>> {
  if (cache && now - cache.at < ttlMs()) return cache.set;
  try {
    const r = await query<Row>(
      `SELECT provider_id, health_status, health_mode, degraded_since, degrade_reason FROM provider_ops`,
      [],
      runner,
    );
    const set = new Set<string>();
    for (const row of r.rows) {
      const eff = effectiveHealth({
        health_status: (row.health_status === "degraded" || row.health_status === "healthy"
          ? row.health_status
          : null),
        health_mode: (row.health_mode as ProviderHealthRow["health_mode"]) ?? "auto",
        degraded_since: row.degraded_since,
        degrade_reason: row.degrade_reason,
      });
      if (eff.degraded) set.add(row.provider_id);
    }
    cache = { set, at: now };
    return set;
  } catch {
    // fail-soft:绝不因读失败误判降级。
    return cache?.set ?? new Set<string>();
  }
}

/** admin 改 health_mode 后调用,让本进程下次读立即生效(不等 TTL)。 */
export function invalidateDegradedProvidersCache(): void {
  cache = null;
}

/** 测试:清缓存。 */
export function _resetGateForTest(): void {
  cache = null;
}
