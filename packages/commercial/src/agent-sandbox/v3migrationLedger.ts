/**
 * V3 R6.11 agent_migrations ledger 模块 — Phase 2.A 基座
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §14.2.4 / §14.2.6 / §13.3 + 0071 migration。
 *
 * 本模块是 R6.11 ledger 的**唯一 API 入口**:
 *   - writer(future patch:§14.2.4 persistent migrate)→ createPlannedMigration + markPhase
 *   - reader(Phase 2.B:§13.3 ensureRunning 闸门)→ findOpenByUser
 *   - reconciler(Phase 2.C:§14.2.6 60s sweep)→ listStale + markRolledBack / markCommitted
 *
 * 设计原则:
 *   - 纯 query 包装,**无 docker 副作用** — docker 调用归 supervisor / reconciler
 *   - 所有 SQL 走 `query()` helper(参数化),禁止字符串拼接
 *   - phase 用 TS union 类型导出(Codex plan review 第 2 点),拼写错误编译期 catch
 *   - markCommitted / markRolledBack 同时写 updated_at;markCommitted 额外写 committed_at
 *     (Codex plan review 第 3 点)
 *   - committed_at 在 rolled_back 时保持 NULL — 终态语义清晰
 *
 * 不在本模块做:
 *   - phase 转移 CHECK / 触发器 — 应用层 markPhase 单点写
 *   - 自动 GC committed/rolled_back 行 — 留 Phase 5 audit cleanup
 *   - 跨表 join(reader 用 agent_containers join)— ledger 模块只管自己;
 *     join 形态在 findOpenByUser 内显式写
 */

import type { QueryRunner } from "../db/queries.js";
import { query } from "../db/queries.js";

// ───────────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────────

/** R6.9 8 phase 拓扑;CHECK 兜底,TS union 让 markPhase 编译期 catch 拼写错误 */
export type MigrationPhase =
  | "planned"
  | "created"
  | "detached"
  | "attached_pre"
  | "attached_route"
  | "started"
  | "committed"
  | "rolled_back";

/** 终态 — markCommitted / markRolledBack 写入后不可再 markPhase */
export const TERMINAL_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "committed",
  "rolled_back",
]);

export interface CreatePlannedMigrationInput {
  agentContainerId: bigint;
  oldHostId: string; // UUID
  oldContainerInternalId: string;
  newHostId: string; // UUID
}

export interface MigrationRow {
  id: bigint;
  agentContainerId: bigint;
  oldHostId: string;
  oldContainerInternalId: string;
  newHostId: string;
  newContainerInternalId: string | null;
  pausedAt: Date | null;
  phase: MigrationPhase;
  startedAt: Date;
  updatedAt: Date;
  committedAt: Date | null;
}

/** §13.3 ensureRunning 闸门返回 — reader 只需要这 3 个字段做 503 决策 */
export interface OpenMigrationSummary {
  id: bigint;
  phase: MigrationPhase;
  agentContainerId: bigint;
}

/** markPhase 可选副字段:某些 phase 转换需要同事务写 cid / paused_at */
export interface MarkPhasePatch {
  newContainerInternalId?: string;
  pausedAt?: Date;
}

// ───────────────────────────────────────────────────────────────────────
// row → typed object 映射
// ───────────────────────────────────────────────────────────────────────

interface MigrationRowSql {
  id: string;
  agent_container_id: string;
  old_host_id: string;
  old_container_internal_id: string;
  new_host_id: string;
  new_container_internal_id: string | null;
  paused_at: Date | null;
  phase: string;
  started_at: Date;
  updated_at: Date;
  committed_at: Date | null;
}

function mapMigrationRow(r: MigrationRowSql): MigrationRow {
  return {
    id: BigInt(r.id),
    agentContainerId: BigInt(r.agent_container_id),
    oldHostId: r.old_host_id,
    oldContainerInternalId: r.old_container_internal_id,
    newHostId: r.new_host_id,
    newContainerInternalId: r.new_container_internal_id,
    pausedAt: r.paused_at,
    phase: r.phase as MigrationPhase,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    committedAt: r.committed_at,
  };
}

// ───────────────────────────────────────────────────────────────────────
// writer API
// ───────────────────────────────────────────────────────────────────────

/**
 * §14.2.4 ①bis:INSERT phase='planned'。new_container_internal_id + paused_at 留 NULL
 * (R6.9 INSERT 前移到 ① pickHost 之后,planned 阶段尚未 docker create 也未 pause)。
 *
 * UNIQUE partial index `agent_migrations_one_open_by_container_idx` 保证:
 * 单 container 不能有 2 条 open(phase NOT IN closed)行,writer bug 会 23505 立刻可见。
 */
export async function createPlannedMigration(
  input: CreatePlannedMigrationInput,
  runner?: QueryRunner,
): Promise<{ migrationId: bigint }> {
  const r = await query<{ id: string }>(
    `INSERT INTO agent_migrations (
       agent_container_id, old_host_id, old_container_internal_id,
       new_host_id, phase
     ) VALUES ($1, $2, $3, $4, 'planned')
     RETURNING id`,
    [
      input.agentContainerId.toString(),
      input.oldHostId,
      input.oldContainerInternalId,
      input.newHostId,
    ],
    runner,
  );
  return { migrationId: BigInt(r.rows[0]!.id) };
}

/**
 * markPhase / markCommitted / markRolledBack 守卫违例。
 *
 * 触发条件(任一):
 *   - 目标行不存在(WHERE id=$1 rowCount=0)
 *   - 目标行 phase 已 IN ('committed','rolled_back') — terminal 不可再变更
 *
 * 调用方可 `err instanceof MigrationGuardError` 区分,但通常 writer 不该 retry
 * (已是终态或行被并发删了),直接 propagate 给上层让 reconciler/alert 介入。
 *
 * Codex Phase 2.A review v1 第 1/2 点(BLOCKER):TS Exclude 只编译期防误写,SQL
 * 层必须也加 `WHERE id=$1 AND phase NOT IN closed` 守卫 — 否则:
 *   - markPhase 可把 committed/rolled_back 行复活回 open phase(unique partial idx 也会失效)
 *   - markCommitted 后再 markRolledBack 会得到 `phase='rolled_back' AND committed_at IS NOT NULL`
 *     的自相矛盾终态,reconciler/审计会误判
 *
 * Codex Phase 2.A review v2 SUGGESTION:类名原叫 MigrationGuardError,但因
 * "不存在的 migrationId" 也走本错误,改名更准确。message 显式区分两种 root cause
 * 让排障无歧义。
 */
export class MigrationGuardError extends Error {
  constructor(public readonly migrationId: bigint) {
    super(
      `agent_migrations row ${migrationId} guard violated: row missing OR ` +
        `already in terminal phase (committed/rolled_back). ` +
        `This likely indicates a writer bug, duplicate finalize, or stale id.`,
    );
    this.name = "MigrationGuardError";
  }
}

/**
 * 入参非法 — markPhase 被传入终态 phase。
 *
 * Codex Phase 2.A review v2 BLOCKER:TS `Exclude<MigrationPhase, "committed"|"rolled_back">`
 * 只编译期防,运行时 `markPhase(id, 'committed' as any)` / 反序列化路径 / 重构遗漏
 * 都可绕过。后果:
 *   - phase='committed' AND committed_at IS NULL → 绕过 markCommitted 的原子时间戳写入
 *   - unique partial index 立即把该行视为 closed(同 container 下一条 INSERT 不再被拦)
 *   - reconciler 看 `committed phase + 无 committed_at` 困惑
 * 入口运行时检查 `TERMINAL_PHASES.has(nextPhase)` 兜底,即使被 `as any` 强转也拦。
 */
export class MigrationPhaseInputError extends Error {
  constructor(public readonly migrationId: bigint, public readonly badPhase: string) {
    super(
      `markPhase refuses terminal phase '${badPhase}' for migration ${migrationId}; ` +
        `use markCommitted / markRolledBack for terminal transitions ` +
        `(they write committed_at atomically and enforce single-direction terminal semantics).`,
    );
    this.name = "MigrationPhaseInputError";
  }
}

/**
 * §14.2.4 ⑤bis / ⑥a / ⑥c / ⑥e / ⑦ phase 推进。
 *
 * patch.newContainerInternalId 在 'created' phase 必填(⑤bis 同事务补 cid);
 * patch.pausedAt 在 ③ pause 同事务写入(供 reconciler 判断是否需要 unpause 旧容器)。
 *
 * 不允许把行推到 'committed' / 'rolled_back' — 走 markCommitted / markRolledBack
 * 终态接口,保证终态写入与 committed_at 写入是同语义。
 *
 * **双重 guard**:
 *   1. **入参 guard**(Codex Phase 2.A review v2 BLOCKER):入口 `TERMINAL_PHASES.has(nextPhase)`
 *      运行时检查 — 拦截 `as any` 强转、动态 call site、JSON 反序列化等绕过编译期 Exclude
 *      的场景;抛 MigrationPhaseInputError。
 *   2. **行态 guard**(Codex Phase 2.A review v1 BLOCKER):SQL 谓词 `phase NOT IN closed`
 *      兜底 — 防把已 terminal 行复活回 open phase / 让 unique partial idx 失效。WHERE 不匹配
 *      (行不存在 OR 已 terminal)时 rowCount=0 → 抛 MigrationGuardError。
 *
 * 不在 SQL 层校验 phase 转移合法性(planned→started 之类的非法跳转)— 应用层
 * §14.2.4 单点 writer 已经按线性顺序推进,SQL CHECK 会引入复杂度无明显收益。
 */
export async function markPhase(
  migrationId: bigint,
  nextPhase: Exclude<MigrationPhase, "committed" | "rolled_back">,
  patch: MarkPhasePatch = {},
  runner?: QueryRunner,
): Promise<void> {
  // 入参 guard:运行时拦 `as any` 等绕过 TS Exclude 的路径
  if (TERMINAL_PHASES.has(nextPhase as MigrationPhase)) {
    throw new MigrationPhaseInputError(migrationId, nextPhase);
  }

  const setClauses: string[] = ["phase = $2", "updated_at = now()"];
  const params: unknown[] = [migrationId.toString(), nextPhase];

  if (patch.newContainerInternalId !== undefined) {
    params.push(patch.newContainerInternalId);
    setClauses.push(`new_container_internal_id = $${params.length}`);
  }
  if (patch.pausedAt !== undefined) {
    params.push(patch.pausedAt);
    setClauses.push(`paused_at = $${params.length}`);
  }

  const r = await query(
    `UPDATE agent_migrations
        SET ${setClauses.join(", ")}
      WHERE id = $1
        AND phase NOT IN ('committed', 'rolled_back')`,
    params,
    runner,
  );
  if (r.rowCount === 0) throw new MigrationGuardError(migrationId);
}

/**
 * §14.2.4 ⑨:成功终态。committed_at 同事务写入,reconciler 见到 phase='committed'
 * + committed_at NOT NULL → 已完结,不再处理。
 *
 * **Terminal guard**(Codex Phase 2.A review 第 2 点):若行已 terminal(无论 committed
 * 还是 rolled_back)抛 MigrationGuardError,**不**幂等 — 重复 commit 是 writer
 * bug 信号,需上层介入,不应静默成功。
 */
export async function markCommitted(
  migrationId: bigint,
  runner?: QueryRunner,
): Promise<void> {
  const r = await query(
    `UPDATE agent_migrations
        SET phase = 'committed',
            committed_at = now(),
            updated_at = now()
      WHERE id = $1
        AND phase NOT IN ('committed', 'rolled_back')`,
    [migrationId.toString()],
    runner,
  );
  if (r.rowCount === 0) throw new MigrationGuardError(migrationId);
}

/**
 * §14.2.4 失败回滚 / §14.2.6 reconciler 兜底终态。
 * committed_at 保持 NULL(Codex plan review 第 3 点)— 终态语义:
 *   - committed:成功完结
 *   - rolled_back:失败回滚,from-state 未改 OR 已回滚到初态
 *
 * **Terminal guard**(Codex Phase 2.A review 第 2 点):若行已 terminal 抛
 * MigrationGuardError。同 markCommitted 不幂等 — 防 `committed → rolled_back`
 * 反向覆盖造 `phase='rolled_back' AND committed_at IS NOT NULL` 自相矛盾终态。
 */
export async function markRolledBack(
  migrationId: bigint,
  runner?: QueryRunner,
): Promise<void> {
  const r = await query(
    `UPDATE agent_migrations
        SET phase = 'rolled_back',
            updated_at = now()
      WHERE id = $1
        AND phase NOT IN ('committed', 'rolled_back')`,
    [migrationId.toString()],
    runner,
  );
  if (r.rowCount === 0) throw new MigrationGuardError(migrationId);
}

// ───────────────────────────────────────────────────────────────────────
// reader API
// ───────────────────────────────────────────────────────────────────────

/**
 * §13.3 ensureRunning 闸门:按 user 维度找其 open migration。
 *
 * SQL 形态 = agent_containers JOIN agent_migrations:
 *   - WHERE c.user_id = $1 锁用户身份
 *   - state IN ('active','pending_apply') 排除 vanished / warm / draining
 *     (draining 行 by R6.11 也属"路由可见但 reader 不直接 reuse",但走的是 ensureRunning
 *      之外的路径;本闸门关心的是 reuse 候选行的 open migration 状态)
 *   - phase NOT IN closed 复用 `agent_migrations_one_open_by_container_idx` 部分索引,
 *     99% 0 行场景 sub-ms
 *   - ORDER BY m.updated_at DESC / m.id DESC(Codex plan review 第 1 点)— UNIQUE
 *     partial index 保证单 container 单 open,但用户维度未来若 active+pending_apply
 *     多行场景,返"最新 open"对 reader 决策更稳
 *   - LIMIT 1 — reader 只关心"有没有 open",不需要列表
 */
export async function findOpenByUser(
  userId: bigint,
  runner?: QueryRunner,
): Promise<OpenMigrationSummary | null> {
  const r = await query<{ id: string; phase: string; agent_container_id: string }>(
    `SELECT m.id, m.phase, c.id AS agent_container_id
       FROM agent_containers c
       JOIN agent_migrations m ON m.agent_container_id = c.id
      WHERE c.user_id = $1
        AND c.state IN ('active', 'pending_apply')
        AND m.phase NOT IN ('committed', 'rolled_back')
      ORDER BY m.updated_at DESC, m.id DESC
      LIMIT 1`,
    [userId.toString()],
    runner,
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0]!;
  return {
    id: BigInt(row.id),
    phase: row.phase as MigrationPhase,
    agentContainerId: BigInt(row.agent_container_id),
  };
}

/**
 * 按 container 维度找 open migration — writer / reconciler 内部用。
 * 与 findOpenByUser 区别:reader 是按 uid 维度做闸门;内部协调按 container.id 做精确定位。
 */
export async function findOpenByContainer(
  agentContainerId: bigint,
  runner?: QueryRunner,
): Promise<MigrationRow | null> {
  const r = await query<MigrationRowSql>(
    `SELECT id, agent_container_id, old_host_id, old_container_internal_id,
            new_host_id, new_container_internal_id, paused_at, phase,
            started_at, updated_at, committed_at
       FROM agent_migrations
      WHERE agent_container_id = $1
        AND phase NOT IN ('committed', 'rolled_back')
      LIMIT 1`,
    [agentContainerId.toString()],
    runner,
  );
  if (r.rows.length === 0) return null;
  return mapMigrationRow(r.rows[0]!);
}

/**
 * §14.2.6 reconciler 60s 周期 — 拿 stale 行(phase 未结束 + 长时间未推进)。
 * 用 `agent_migrations_pending_idx (phase, updated_at) WHERE phase NOT IN closed`。
 *
 * @param thresholdSec 阈值秒数。dev plan §13.3 默认 `supervisor_stale_migrate_threshold_sec`=600,
 *   reconciler 调用方负责从 system_settings 读
 */
export async function listStale(
  thresholdSec: number,
  runner?: QueryRunner,
): Promise<MigrationRow[]> {
  if (!Number.isInteger(thresholdSec) || thresholdSec < 0) {
    throw new Error(`listStale: thresholdSec must be non-negative integer, got ${thresholdSec}`);
  }
  const r = await query<MigrationRowSql>(
    `SELECT id, agent_container_id, old_host_id, old_container_internal_id,
            new_host_id, new_container_internal_id, paused_at, phase,
            started_at, updated_at, committed_at
       FROM agent_migrations
      WHERE phase NOT IN ('committed', 'rolled_back')
        AND updated_at < now() - ($1 * interval '1 second')
      ORDER BY updated_at ASC`,
    [thresholdSec],
    runner,
  );
  return r.rows.map(mapMigrationRow);
}
