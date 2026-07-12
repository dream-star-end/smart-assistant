/**
 * P3 —— cohort 分批切流的 lane 评估(RFC-v5-dual-master-cohort §4 D1)。
 *
 * 职责(且仅此):给定用户 uid + PG `deploy_state` 单行状态,派生"该用户这次请求
 * 应路由到哪个 slot":
 *   - lane='active'    → 走当前主 slot(默认流量);cookieValue=null(下发点据此清 cookie)
 *   - lane='candidate' → 走灰度 candidate slot;cookieValue='g<generation>.<slot>'
 *
 * 单一权威:`laneHash` 的实现在 RFC 里被钉死(TS/SQL/脚本三处必须逐字节一致),
 * 任何改动都要同步三侧并跑穷举测试。cookie 值编码代次(generation)与 slot,Caddy
 * matcher 只认**当前 generation** 的 candidate 值;上一代 cookie 不命中任何 matcher →
 * 自动落 active(休眠浏览器旧 cookie 永不误路由,RFC B4)。
 *
 * fail-closed 语义:任何不确定(deploy_state 缺表/缺行/读失败、phase 非灰度、
 * percent=0 且不在 allowlist)→ **一律回 active**(当前稳定生产 slot,零 canary
 * 暴露)。基建版 seed(phase=stable, percent=0)下本模块恒 active、不下发 cookie =
 * 相对上线前零行为变化。
 *
 * ── 接线点(集成者在 index.ts / admin / healthz 处接,本文件不直接改 index.ts)──
 *   1. lane 指标观测:把 `getLaneMetricsSnapshot()` 挂到 admin/healthz 只读面
 *      (operator 由 lane_users distinct uid 判断 N% 已覆盖多少活跃评估者)。
 *   2. cookie 下发点(handlers.ts login/refresh/`/api/me`)调用 `evaluateLaneForUser(uid)`。
 */

import { createHash } from "node:crypto";
import { query, type QueryRunner } from "../db/queries.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "laneEvaluate" });

/** lane 决策结果。cookieValue=null → 下发点清 cookie(或在无 cookie 时零动作)。 */
export interface LaneDecision {
  lane: "active" | "candidate";
  cookieValue: string | null;
}

/**
 * `deploy_state` 单行里 lane 评估需要的字段子集(0135 迁移,Agent A 建表)。
 * generation/allowlist 走 BIGINT/BIGINT[] → node-pg 默认以 string 返回,全程按 string
 * 处理(避免 Number 精度风险;cookie 值本就是字符串)。
 */
export interface DeployStateLaneRow {
  generation: string;
  phase: "stable" | "canary" | "finalizing" | "aborting";
  active_slot: string; // 'A' | 'B'
  candidate_slot: string | null; // NULL = 无灰度
  cohort_percent: number; // SMALLINT 0..100
  cohort_salt: string;
  cohort_allowlist: string[]; // BIGINT[] → string[]
}

/**
 * lane_hash —— RFC 钉死的单一实现(§4 D1):
 *   sha256(salt + ':' + uid) 的前 8 hex 字符 → uint32 无符号 → mod 100。
 *
 * 前 8 hex = 4 字节 = 32 bit,parseInt(...,16) 天然落在 [0, 2^32-1](非负),`>>> 0`
 * 显式收敛为 uint32(语义标注,对合法 8-hex 输入是恒等)。返回 [0,99]。
 *
 * TS/SQL/脚本三侧共用同一定义,禁止各写一份 —— 穷举测试保证三处一致。
 */
export function laneHash(uid: string, salt: string): number {
  const hex = createHash("sha256").update(`${salt}:${uid}`).digest("hex");
  const u32 = Number.parseInt(hex.slice(0, 8), 16) >>> 0;
  return u32 % 100;
}

/**
 * 纯函数:给定 uid + deploy_state 行,派生 lane 决策。无副作用(指标记录在
 * `evaluateLaneForUser` 薄封装里做,保持本函数可穷举/可确定性测试)。
 *
 * 判定顺序(fail-closed 到 active):
 *   1. phase 非 canary/finalizing → active(stable/aborting 无灰度目标)
 *   2. candidate_slot 为空 → active(没有可路由的 candidate)
 *   3. allowlist ∪ (percent>0 ∧ laneHash(uid,salt) < percent) → candidate
 *   4. 否则(含 percent=0 且不在 allowlist)→ active
 */
export function evaluateLane(uid: string, row: DeployStateLaneRow | null): LaneDecision {
  if (row === null) return { lane: "active", cookieValue: null };
  if (row.phase !== "canary" && row.phase !== "finalizing") {
    return { lane: "active", cookieValue: null };
  }
  if (!row.candidate_slot) {
    return { lane: "active", cookieValue: null };
  }
  const inAllowlist = row.cohort_allowlist.includes(uid);
  const inPercent = row.cohort_percent > 0 && laneHash(uid, row.cohort_salt) < row.cohort_percent;
  if (inAllowlist || inPercent) {
    return { lane: "candidate", cookieValue: `g${row.generation}.${row.candidate_slot}` };
  }
  return { lane: "active", cookieValue: null };
}

// ── lane 指标(放量观测,RFC §4 D1 R2/R3)──────────────────────────────────
//
// 内存 Map 按 generation 滚动:观测到新 generation 即清空重开(只保留当前一代,
// 与"每次 rollout 换 salt/generation"语义一致)。暴露:
//   - lane_evaluations{lane,slot,count}:请求次计数(每次评估 +1)
//   - lane_users{lane,slot,users}:(generation,uid) 去重的 distinct uid 计数
// 两者都 per-generation。distinct uid Set 有软上限防病态内存膨胀(超过即停止新增、
// 打 capped 标记,count 仍单调 —— operator 看到 capped=true 即知已远超 N% 目标)。

const UNIQUE_USER_CAP = 200_000;

interface LaneBucket {
  evaluations: number;
  users: Set<string>;
  usersCapped: boolean;
}

let _metricsGeneration: string | null = null;
const _buckets = new Map<string, LaneBucket>(); // key = `${lane}:${slot}`

function bucketKey(lane: string, slot: string): string {
  return `${lane}:${slot}`;
}

/**
 * 记录一次 lane 评估到当前 generation 的指标桶。generation 变化即滚动清空。
 * slot:candidate 决策记 candidate_slot;active 决策记 active_slot(operator 由此
 * 看到流量在两 slot 的分布)。
 */
export function recordLaneMetrics(
  generation: string,
  lane: "active" | "candidate",
  slot: string,
  uid: string,
): void {
  if (_metricsGeneration !== generation) {
    _metricsGeneration = generation;
    _buckets.clear();
  }
  const key = bucketKey(lane, slot);
  let b = _buckets.get(key);
  if (!b) {
    b = { evaluations: 0, users: new Set(), usersCapped: false };
    _buckets.set(key, b);
  }
  b.evaluations += 1;
  if (!b.users.has(uid)) {
    if (b.users.size >= UNIQUE_USER_CAP) {
      b.usersCapped = true;
    } else {
      b.users.add(uid);
    }
  }
}

export interface LaneMetricsSnapshot {
  generation: string | null;
  buckets: Array<{
    lane: string;
    slot: string;
    evaluations: number;
    uniqueUsers: number;
    usersCapped: boolean;
  }>;
}

/** 给 admin/healthz 只读面用的快照(整型计数 + distinct uid 数,不外泄 uid 列表)。 */
export function getLaneMetricsSnapshot(): LaneMetricsSnapshot {
  const buckets: LaneMetricsSnapshot["buckets"] = [];
  for (const [key, b] of _buckets) {
    const sep = key.indexOf(":");
    buckets.push({
      lane: key.slice(0, sep),
      slot: key.slice(sep + 1),
      evaluations: b.evaluations,
      uniqueUsers: b.users.size,
      usersCapped: b.usersCapped,
    });
  }
  return { generation: _metricsGeneration, buckets };
}

/** 测试 hook:清空指标状态。 */
export function _resetLaneMetricsForTesting(): void {
  _metricsGeneration = null;
  _buckets.clear();
}

// ── deploy_state 读取薄封装(带短 TTL 缓存,避免 /api/me 热路径打爆 PG）────────

const DEPLOY_STATE_SQL = `
  SELECT generation::text        AS generation,
         phase,
         active_slot,
         candidate_slot,
         cohort_percent,
         cohort_salt,
         cohort_allowlist
    FROM deploy_state
   LIMIT 1`;

const CACHE_TTL_MS = 3_000;

interface LaneStateCache {
  row: DeployStateLaneRow | null;
  at: number;
}
let _cache: LaneStateCache | null = null;

/**
 * 读 deploy_state 单行(带 3s 缓存)。失败/缺表/缺行 → 返回 null(上层 fail-closed
 * 到 active);读失败不进缓存,下次重试。promote 生效粒度本就是"下一次 /api/me"级,
 * 3s 陈旧无害(RFC 明确 N% = 活跃评估者口径,非实时)。
 */
export async function loadDeployStateForLane(
  runner?: QueryRunner,
  now: () => number = Date.now,
): Promise<DeployStateLaneRow | null> {
  const t = now();
  if (_cache && t - _cache.at < CACHE_TTL_MS) return _cache.row;
  try {
    const r = await query<DeployStateLaneRow>(DEPLOY_STATE_SQL, [], runner);
    const row = r.rows[0] ?? null;
    // pg 对 BIGINT[] 空值可能给 null;归一化成空数组防判定处 NPE。
    if (row && !Array.isArray(row.cohort_allowlist)) {
      row.cohort_allowlist = [];
    }
    _cache = { row, at: t };
    return row;
  } catch (err) {
    // fail-closed:deploy_state 不可用绝不阻断 login/refresh/me —— 回 null=恒 active。
    log.warn("deploy_state_read_failed_defaulting_active", { err: (err as Error).message });
    return null;
  }
}

/** 测试 hook:清空 deploy_state 缓存。 */
export function _resetLaneStateCacheForTesting(): void {
  _cache = null;
}

export interface EvaluateLaneForUserOpts {
  /** 注入 QueryRunner(测试/事务);默认走 pool。 */
  runner?: QueryRunner;
  /** 直接注入 deploy_state 行(测试用),提供时不读 PG、不走缓存。 */
  row?: DeployStateLaneRow | null;
  now?: () => number;
}

/**
 * 下发点调用入口:读 deploy_state → evaluateLane → 记指标 → 返回决策。
 * 基建版(phase=stable)下恒返回 {lane:'active', cookieValue:null},下发点据此不动
 * cookie —— 零行为变化。
 */
export async function evaluateLaneForUser(
  uid: string,
  opts: EvaluateLaneForUserOpts = {},
): Promise<LaneDecision> {
  const row =
    opts.row !== undefined ? opts.row : await loadDeployStateForLane(opts.runner, opts.now);
  const decision = evaluateLane(uid, row);
  if (row !== null) {
    const slot = decision.lane === "candidate" ? row.candidate_slot ?? row.active_slot : row.active_slot;
    recordLaneMetrics(row.generation, decision.lane, slot, uid);
  }
  return decision;
}
