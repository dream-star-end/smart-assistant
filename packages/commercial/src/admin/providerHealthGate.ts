/**
 * provider 健康度 —— 生效降级集读缓存(动作层 gate,roadmap P3.2)。
 *
 * 消费者:
 *   - master:GET /api/models 给受影响模型注解 degraded:true(不过滤,只标注)。
 *   - egress:proxy 模型闸 —— OC_PROVIDER_HEALTH_ENFORCE=1 时 degraded provider 的模型 503。
 * 两者跑在不同进程,各持一份进程内 TTL 缓存(默认 15s)。provider_ops 与精确配额
 * block 都是极小表;启发式健康仍由 effectiveHealth 单一派生,配额 block 独立叠加。
 *
 * fail-soft 铁律(UX 红线:误拦好模型 > 漏拦坏模型):DB 抖动时返回上次缓存或空集 ——
 * 空集 = 视作全健康 = 不降级不拦截,绝不因读失败误判降级。
 */

import { createHash } from "node:crypto";
import { query, type QueryRunner } from "../db/queries.js";
import { effectiveHealth, type ProviderHealthRow } from "./providerHealth.js";

const DEFAULT_TTL_MS = 15_000;

function ttlMs(): number {
  const raw = Number(process.env.OC_PROVIDER_HEALTH_GATE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

interface CacheEntry {
  healthDegraded: Set<string>;
  quotaBlocks: Map<string, ProviderQuotaBlock>;
  at: number;
}
let cache: CacheEntry | null = null;

export interface ProviderQuotaBlock {
  retryAt: number;
  probeLeaseUntil: number | null;
}

export interface ProviderRoutingAvailability {
  unavailableProviderIds: ReadonlySet<string>;
  revision: string;
}

type Row = {
  provider_id: string;
  health_status: string | null;
  health_mode: string;
  degraded_since: Date | null;
  degrade_reason: string | null;
  quota_retry_at: Date | null;
  quota_probe_lease_until: Date | null;
};

async function loadSnapshot(
  now: number,
  runner?: QueryRunner,
  forceRefresh = false,
): Promise<CacheEntry | null> {
  if (!forceRefresh && cache && now - cache.at < ttlMs()) return cache;
  try {
    const r = await query<Row>(
      `SELECT COALESCE(po.provider_id, qb.provider_id) AS provider_id,
              po.health_status, po.health_mode,
              po.degraded_since, po.degrade_reason,
              qb.retry_at AS quota_retry_at,
              qb.probe_lease_until AS quota_probe_lease_until
         FROM provider_ops po
         FULL OUTER JOIN provider_quota_blocks qb ON qb.provider_id=po.provider_id`,
      [],
      runner,
    );
    const healthDegraded = new Set<string>();
    const quotaBlocks = new Map<string, ProviderQuotaBlock>();
    for (const row of r.rows) {
      const eff = effectiveHealth({
        health_status: (row.health_status === "degraded" || row.health_status === "healthy"
          ? row.health_status
          : null),
        health_mode: (row.health_mode as ProviderHealthRow["health_mode"]) ?? "auto",
        degraded_since: row.degraded_since,
        degrade_reason: row.degrade_reason,
      });
      if (eff.degraded) healthDegraded.add(row.provider_id);
      if (row.quota_retry_at) {
        quotaBlocks.set(row.provider_id, {
          retryAt: row.quota_retry_at.getTime(),
          probeLeaseUntil: row.quota_probe_lease_until?.getTime() ?? null,
        });
      }
    }
    cache = { healthDegraded, quotaBlocks, at: now };
    return cache;
  } catch {
    // fail-soft:绝不因读失败误判降级。
    return cache;
  }
}

/**
 * 当前「生效降级」的 provider id 集合(TTL 缓存)。
 * @param now  注入时钟(测试用)。
 * @param runner 注入 query runner(测试用)。
 */
export async function getDegradedProviders(
  now: number = Date.now(),
  runner?: QueryRunner,
): Promise<Set<string>> {
  const snapshot = await loadSnapshot(now, runner);
  if (!snapshot) return new Set<string>();
  const set = new Set(snapshot.healthDegraded);
  for (const [providerId, block] of snapshot.quotaBlocks) {
    if (block.retryAt > now || (block.probeLeaseUntil ?? 0) > now) set.add(providerId);
  }
  return set;
}

/**
 * Team/local routing availability. Exact quota blocks always participate;
 * heuristic/forced health participates only when its egress enforcement flag
 * is on. The revision includes that flag, so toggling it invalidates container
 * routing views even though no database epoch changes.
 */
export async function getProviderRoutingAvailability(
  now: number = Date.now(),
  runner?: QueryRunner,
  enforceHealth: boolean = process.env.OC_PROVIDER_HEALTH_ENFORCE === "1",
  forceRefresh = false,
): Promise<ProviderRoutingAvailability> {
  const snapshot = await loadSnapshot(now, runner, forceRefresh);
  const quotaBlocked: string[] = [];
  for (const [providerId, block] of snapshot?.quotaBlocks ?? []) {
    if (block.retryAt > now || (block.probeLeaseUntil ?? 0) > now) {
      quotaBlocked.push(providerId);
    }
  }
  quotaBlocked.sort();
  const healthDegraded = enforceHealth
    ? [...(snapshot?.healthDegraded ?? [])].sort()
    : [];
  const unavailableProviderIds = new Set([...quotaBlocked, ...healthDegraded]);
  const revision = createHash("sha256")
    .update(JSON.stringify({
      v: 1,
      enforceHealth,
      quotaBlocked,
      healthDegraded,
    }))
    .digest("hex");
  return { unavailableProviderIds, revision };
}

/** Heuristic/forced health only; quota blocks have their own unconditional gate. */
export async function getHealthDegradedProviders(
  now: number = Date.now(),
  runner?: QueryRunner,
): Promise<Set<string>> {
  return new Set((await loadSnapshot(now, runner))?.healthDegraded ?? []);
}

/** Quota rows remain visible after retry_at so egress can atomically claim one probe. */
export async function getProviderQuotaBlock(
  providerId: string,
  now: number = Date.now(),
  runner?: QueryRunner,
): Promise<ProviderQuotaBlock | null> {
  return (await loadSnapshot(now, runner))?.quotaBlocks.get(providerId) ?? null;
}

/** admin 改 health_mode 后调用,让本进程下次读立即生效(不等 TTL)。 */
export function invalidateDegradedProvidersCache(): void {
  cache = null;
}

/** 测试:清缓存。 */
export function _resetGateForTest(): void {
  cache = null;
}
