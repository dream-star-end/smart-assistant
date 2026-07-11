/**
 * v5 自愈体系切片① — incident_policies 加载 + condition_key → policy 匹配。
 *
 * incident_policies 是"用户可感事件 → 用户向文案/影响面/自愈策略"的**单一声明权威**
 * (消灭文案双源:shell 只 upsert condition 当前值,文案由 master reconciler 从表
 * materialize)。本模块从表加载,内存缓存(TTL + 显式 reload)。
 *
 * 匹配裁决(RFC M-policy-match):
 *   - match_kind='exact' 精确命中优先;
 *   - 否则 longest-prefix(match_kind='prefix' 中 conditionKey.startsWith(match_key) 的最长者);
 *   - **同长度 prefix 冲突 → fail-fast 抛错**(数据异常,绝不静默取第一条);
 *   - 无命中 → null(=非用户可感,不进 incident)。
 */

import { query } from "../db/queries.js";

export type PolicyAudience = "all" | "surface_cohort" | "user_ids";
export type PolicyResolveMode = "probe" | "manual";
export type PolicySeverity = "info" | "warning" | "critical";

export interface IncidentPolicy {
  id: number;
  matchKind: "exact" | "prefix";
  matchKey: string;
  surface: string;
  audience: PolicyAudience;
  resolveMode: PolicyResolveMode;
  autoRepair: boolean;
  severityFloor: PolicySeverity;
  userTitle: string;
  userMessage: string;
  repairHint: string | null;
  enabled: boolean;
}

interface PolicyRow {
  id: string;
  match_kind: "exact" | "prefix";
  match_key: string;
  surface: string;
  audience: PolicyAudience;
  resolve_mode: PolicyResolveMode;
  auto_repair: boolean;
  severity_floor: PolicySeverity;
  user_title: string;
  user_message: string;
  repair_hint: string | null;
  enabled: boolean;
}

const DEFAULT_TTL_MS = 60_000;

interface CacheState {
  exact: Map<string, IncidentPolicy>;
  prefixes: IncidentPolicy[]; // 仅 enabled;matchKind='prefix'
  loadedAt: number;
}

let cache: CacheState | null = null;
let inflight: Promise<CacheState> | null = null;

function toPolicy(r: PolicyRow): IncidentPolicy {
  return {
    id: Number(r.id),
    matchKind: r.match_kind,
    matchKey: r.match_key,
    surface: r.surface,
    audience: r.audience,
    resolveMode: r.resolve_mode,
    autoRepair: r.auto_repair,
    severityFloor: r.severity_floor,
    userTitle: r.user_title,
    userMessage: r.user_message,
    repairHint: r.repair_hint,
    enabled: r.enabled,
  };
}

async function loadFromDb(): Promise<CacheState> {
  const r = await query<PolicyRow>(
    `SELECT id::text AS id, match_kind, match_key, surface, audience, resolve_mode,
            auto_repair, severity_floor, user_title, user_message, repair_hint, enabled
       FROM incident_policies
      WHERE enabled = TRUE`,
  );
  const exact = new Map<string, IncidentPolicy>();
  const prefixes: IncidentPolicy[] = [];
  for (const row of r.rows) {
    const p = toPolicy(row);
    if (p.matchKind === "exact") {
      // UNIQUE(match_kind, match_key) 保证不重;防御性覆盖。
      exact.set(p.matchKey, p);
    } else {
      prefixes.push(p);
    }
  }
  // 启动期结构校验:两条 prefix 若 match_key 完全相同(理论被 DB 唯一键挡),fail-fast。
  const seen = new Set<string>();
  for (const p of prefixes) {
    if (seen.has(p.matchKey)) {
      throw new Error(
        `[selfheal/policy] 重复 prefix match_key='${p.matchKey}' — incident_policies 数据异常`,
      );
    }
    seen.add(p.matchKey);
  }
  return { exact, prefixes, loadedAt: Date.now() };
}

/** 取(可能命中缓存的)policy 集合;过期或未加载则重载。并发调用共享同一 inflight。 */
async function ensureCache(ttlMs = DEFAULT_TTL_MS): Promise<CacheState> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < ttlMs) return cache;
  if (inflight) return inflight;
  inflight = loadFromDb()
    .then((c) => {
      cache = c;
      return c;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 强制重载(NOTIFY 刷新 / admin 改表后调用)。 */
export async function reloadPolicies(): Promise<void> {
  cache = await loadFromDb();
}

/** 测试用:清空缓存。 */
export function _resetPolicyCacheForTest(): void {
  cache = null;
  inflight = null;
}

/**
 * exact 优先,否则 longest-prefix。同长度 prefix 冲突 → 抛错。无命中 → null。
 * 纯函数(对已加载的 cache 求值),供 matchPolicy 与测试直接复用。
 */
export function matchPolicyIn(state: CacheState, conditionKey: string): IncidentPolicy | null {
  const exact = state.exact.get(conditionKey);
  if (exact) return exact;

  let best: IncidentPolicy | null = null;
  let ambiguousAtLen = -1;
  for (const p of state.prefixes) {
    if (!conditionKey.startsWith(p.matchKey)) continue;
    if (!best || p.matchKey.length > best.matchKey.length) {
      best = p;
      ambiguousAtLen = -1;
    } else if (p.matchKey.length === best.matchKey.length) {
      // 同长度且都命中 —— 数据异常(不同 key 不可能同为一个串的等长前缀,除非重复)。
      ambiguousAtLen = p.matchKey.length;
    }
  }
  if (best && ambiguousAtLen === best.matchKey.length) {
    throw new Error(
      `[selfheal/policy] conditionKey='${conditionKey}' 命中多条同长度(${ambiguousAtLen}) prefix policy — 无法裁决,fail-fast`,
    );
  }
  return best;
}

/** condition_key → policy(命中缓存);TTL 过期自动重载。 */
export async function matchPolicy(
  conditionKey: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<IncidentPolicy | null> {
  const state = await ensureCache(ttlMs);
  return matchPolicyIn(state, conditionKey);
}
