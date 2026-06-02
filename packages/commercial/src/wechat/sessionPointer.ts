/**
 * v3 commercial WeChat broker — wechat_session_pointer 数据访问 + 孤儿 reconcile。
 *
 * 详见 docs/v3/wechat-broker-design.md §4.5 / §4.8。
 *
 * 跨 DB 一致性:本模块负责 PG `wechat_session_pointer`(broker 单写权威);master SQLite
 * `client_sessions` 由 @openclaude/storage 的 `upsertMasterClientSession` /
 * `softDeleteMasterSession` 操作。两边 sessionId 同名通过 `wsess-[0-9a-f]{16}`
 * 命名空间约定关联,不加 FK(跨 DB 无法约束)。
 *
 * 孤儿 reconcile 走 in-memory diff,不在 SQL 用 `NOT IN ()`:
 *   - SQLite 限 999 bind params,大用户 wsess 数随 session 数线性增长可能溢出
 *   - `NOT IN ()` 空集是合法 SQL 但语义陷阱(整张表全选);TS 端 Set.has() 兼容空集
 *
 * Grace 期(默认 10 分钟):覆盖 Step 2a(master sqlite 写)与 Step 2b(PG pointer 写)
 * 之间窗口 + reconcile 周期裕量。Codex R5 PASS 确认 10 min 合理。
 */

import { randomBytes } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import type { BindingId, WechatSessionId } from "./types.js"

/** 默认 grace 期:10 min(reconcile 周期 30s,20 轮裕量)。 */
export const RECONCILE_GRACE_MS_DEFAULT = 10 * 60 * 1000

/** PG 查询执行器:支持 Pool 或事务内的 PoolClient,签名兼容 */
export interface PgRunner {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[]; rowCount: number | null }>
}

export type PgConn = Pool | PoolClient | PgRunner

export interface RunningWechatSession {
  sessionId: WechatSessionId
  runId: string
  agentId?: string
}

export interface WechatSessionPointer {
  sessionId: WechatSessionId
  agentId?: string
}

/**
 * 生成新的 wsess sessionId。rand 默认 16 hex(8 字节 randomBytes)。
 *
 * 测试可注入固定 rand 拿到确定输出。entropy = 64 bits(2^64 ≈ 1.8e19),
 * 生日攻击下 n 条 session 碰撞期望 ≈ n² / (2·2^64):
 *   - P1 boss 个人用,n ≤ 10^3,碰撞期望 ≈ 2.7e-14 — 可忽略
 *   - 千万级商用(P3 之后,n=10^7)碰撞期望 ≈ 2.7e-6 — 仍然 OK
 *   - 十亿级 wsess 才会触及百分位风险(本系统不会达到此量级)
 */
export function newWechatSessionId(rand: () => string = defaultRand16Hex): WechatSessionId {
  const r = rand()
  if (!/^[0-9a-f]{16}$/.test(r)) {
    throw new Error(`newWechatSessionId: rand must return 16 lowercase hex chars, got ${JSON.stringify(r)}`)
  }
  return `wsess-${r}`
}

function defaultRand16Hex(): string {
  return randomBytes(8).toString("hex")
}

/**
 * 读取 binding 当前指向的 sessionId。不存在(从未入站过)→ null。
 *
 * 调用方负责再用 master SQLite `getClientSession` 验证 row 还存在 + 未 soft-delete。
 * 本函数不做存在性校验:reconcile 才是清孤儿的责任主体。
 */
export async function getCurrentSessionId(
  conn: PgConn,
  bindingUserId: BindingId,
): Promise<WechatSessionId | null> {
  // cast PgConn (Pool|PoolClient|PgRunner) → PgRunner:pg.Pool/PoolClient 各有 14 个 query
  // 重载,TS 联合类型 narrow 时取交集为空 → TS2349。运行时三者都满足 PgRunner 单签名结构。
  const res = await (conn as PgRunner).query<{ current_session_id: string }>(
    "SELECT current_session_id FROM wechat_session_pointer WHERE binding_user_id = $1 LIMIT 1",
    [bindingUserId],
  )
  if (res.rowCount === 0) return null
  return res.rows[0]!.current_session_id
}

export async function getCurrentSessionPointer(
  conn: PgConn,
  bindingUserId: BindingId,
): Promise<WechatSessionPointer | null> {
  const res = await (conn as PgRunner).query<{ current_session_id: string; current_agent_id: string | null }>(
    "SELECT current_session_id, current_agent_id FROM wechat_session_pointer WHERE binding_user_id = $1 LIMIT 1",
    [bindingUserId],
  )
  if (res.rowCount === 0) return null
  const row = res.rows[0]!
  return {
    sessionId: row.current_session_id as WechatSessionId,
    ...(row.current_agent_id ? { agentId: row.current_agent_id } : {}),
  }
}

/**
 * Upsert binding → sessionId 指针;每次入站 / switch / new 都打点 updated_at。
 *
 * 调用顺序(对齐 RFC §7 #7 反序 + Codex slice 4 plan review):
 *   Step 1  allocate sessionId
 *   Step 2  POST 容器 /internal/v3/wechat-inbound(handler 内 upsert 容器 sqlite + dispatchInbound)
 *           → 200 才继续
 *   Step 3a master sqlite INSERT client_sessions row(originChannel='wechat')
 *   Step 3b 调本函数写 PG pointer  ← 本函数在此被调
 *           3a 或 3b 任一失败 → broker 调容器 delete-orphan compensation(P1.7 容器侧实现)
 *
 * 旧版"先 SQLite/pointer 后 POST 容器"已废弃 — POST 失败留 master 孤儿,
 * 而 master orphan 只能由 reconcile 慢清,容器永远不知道这条 session 不该存在。
 *
 * **回退保护**(Codex slice 2 review BLOCKER):`WHERE wechat_session_pointer.updated_at
 * <= EXCLUDED.updated_at` 防止"较老 ts 的 setCurrentSessionId 晚到把较新 ts 覆盖回旧 session"。
 * P1 broker 单进程同 binding 串行不会真触发,但跨进程 broker(P3)或调用方误用会;一行
 * SQL guard 把"调用方串行约束"降级为"数据层单调",根治一类回退/孤儿误删风险。
 *
 * 返回 true = 写入实际生效;false = stale skip(本次 ts 严格 < 现有 ts,被 WHERE 过滤)。
 * 注意 `<=` 等号档仍然走 UPDATE 路径(rowCount=1)并返回 true:同 ms 的两次写按 PG ON CONFLICT
 * 串行 commit 顺序 last-writer-wins(`Date.now()` 是 ms 精度,P1 不区分微秒)。Slice 4 若需要更强
 * 因果序应在 dispatcher 层注入单调计数器,不在这里加锁。
 *
 * P1 调用方可忽略 false(turn 已 allocate 新 sessionId 走 Step 4,孤儿 row 由 reconcile 兜底);
 * 后续若 dispatcher 需要 "stale 时立即 abort 本路 Step 4" 语义,可读返回值分流。
 */
export async function setCurrentSessionId(
  conn: PgConn,
  bindingUserId: BindingId,
  sessionId: WechatSessionId,
  now: number,
  agentId?: string,
): Promise<boolean> {
  const res = await (conn as PgRunner).query(
    `INSERT INTO wechat_session_pointer (binding_user_id, current_session_id, updated_at, current_agent_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (binding_user_id) DO UPDATE SET
       current_session_id = EXCLUDED.current_session_id,
       updated_at         = EXCLUDED.updated_at,
       current_agent_id   = EXCLUDED.current_agent_id
     WHERE wechat_session_pointer.updated_at <= EXCLUDED.updated_at`,
    [bindingUserId, sessionId, now, agentId ?? null],
  )
  return (res.rowCount ?? 0) > 0
}

export async function markRunningSession(
  conn: PgConn,
  bindingUserId: BindingId,
  sessionId: WechatSessionId,
  runId: string,
  agentId: string | undefined,
  now: number,
): Promise<void> {
  await (conn as PgRunner).query(
    `INSERT INTO wechat_running_sessions (binding_user_id, session_id, run_id, agent_id, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (binding_user_id, session_id, run_id) DO UPDATE SET
       agent_id   = EXCLUDED.agent_id,
       updated_at = EXCLUDED.updated_at`,
    [bindingUserId, sessionId, runId, agentId ?? null, now],
  )
}

export async function listRunningSessions(
  conn: PgConn,
  bindingUserId: BindingId,
  limit?: number,
): Promise<RunningWechatSession[]> {
  const params: unknown[] = [bindingUserId]
  let sql = `SELECT session_id, run_id, agent_id
       FROM wechat_running_sessions
      WHERE binding_user_id = $1
      ORDER BY started_at DESC`
  if (Number.isInteger(limit) && limit! > 0) {
    sql += "\n      LIMIT $2"
    params.push(limit)
  }
  const res = await (conn as PgRunner).query<{ session_id: string; run_id: string; agent_id: string | null }>(
    sql,
    params,
  )
  return res.rows.map((row) => ({
    sessionId: row.session_id as WechatSessionId,
    runId: row.run_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
  }))
}

export async function clearRunningSession(
  conn: PgConn,
  bindingUserId: BindingId,
  sessionId: WechatSessionId,
  runId: string,
): Promise<boolean> {
  const res = await (conn as PgRunner).query(
    "DELETE FROM wechat_running_sessions WHERE binding_user_id = $1 AND session_id = $2 AND run_id = $3",
    [bindingUserId, sessionId, runId],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * 删除 binding 指针(binding 取消绑定 / reconcile 发现 orphan)。
 * 返回是否实际删了行(false = 本就没有)。
 */
export async function deletePointer(
  conn: PgConn,
  bindingUserId: BindingId,
): Promise<boolean> {
  const res = await (conn as PgRunner).query(
    "DELETE FROM wechat_session_pointer WHERE binding_user_id = $1",
    [bindingUserId],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * 从 PG 拉所有 binding 当前指向的 sessionId,组成 Set。
 * 用于 reconcile orphan diff。
 *
 * 不分页:即使 100 万 binding 也就 ~80MB 字符串(64B/id),单次拉无压力;
 * binding 数远低于 session 数。
 */
export async function activeWsessIdsFromPg(conn: PgConn): Promise<Set<WechatSessionId>> {
  const res = await (conn as PgRunner).query<{ current_session_id: string }>(
    "SELECT current_session_id FROM wechat_session_pointer",
  )
  const out = new Set<WechatSessionId>()
  for (const row of res.rows) out.add(row.current_session_id)
  return out
}

export interface OrphanReconcileDeps {
  /** Master SQLite 全部 wsess 行,带 createdAt(epoch ms)。 */
  allWsess: () => Promise<Array<{ id: WechatSessionId; createdAt: number }>>
  /** PG `wechat_session_pointer.current_session_id` 全集。 */
  activeFromPg: () => Promise<Set<WechatSessionId>>
  /** 注入式 now,测试覆盖 grace 边界。默认 Date.now()。 */
  now?: () => number
  /** Grace 期 ms;默认 RECONCILE_GRACE_MS_DEFAULT。 */
  graceMs?: number
}

/**
 * 列出"应被 soft-delete 的孤儿 wsess sessionId":
 *
 *   1. 不在 PG active set 中(binding 已失活 / 用户切到新 session 但旧的没清)
 *   2. createdAt < now - graceMs(避免误删 Step 2→Step 3 窗口内的合法新行)
 *
 * **严格 `<` 边界**:createdAt === cutoff 不算 orphan(单元测试覆盖)。
 *
 * 返回 sessionId 列表;实际 soft-delete 由调用方(broker.reconcile 循环)负责,
 * 这里只暴露纯函数语义便于测试。
 */
export async function listOrphanWechatSessions(deps: OrphanReconcileDeps): Promise<WechatSessionId[]> {
  const [all, active] = await Promise.all([deps.allWsess(), deps.activeFromPg()])
  const nowMs = (deps.now ?? Date.now)()
  const cutoff = nowMs - (deps.graceMs ?? RECONCILE_GRACE_MS_DEFAULT)
  const out: WechatSessionId[] = []
  for (const row of all) {
    if (active.has(row.id)) continue
    if (row.createdAt < cutoff) out.push(row.id)
  }
  return out
}
