/**
 * codexAccountActor — commercial 单进程 codex token refresh actor。
 *
 * **职责**(plan G2 / 决策 M / M2):
 *   1. setInterval 60s 扫描 `claude_accounts WHERE provider='codex' AND status='active'
 *      AND oauth_expires_at < now() + interval '15 minutes'`
 *   2. 对每个待刷新账号调 `refreshCodexAccountToken(acc.id)`(refresh.ts G3 实现)
 *   3. 成功 → 枚举 `agent_containers WHERE codex_account_id=$id AND state='active'`,
 *      为每个容器**持锁**重写 per-container `auth.json`(决策 M2 协议):
 *        BEGIN; SELECT codex_account_id, state FROM agent_containers WHERE id=$cid FOR UPDATE;
 *        校验仍 = 本次刷新的 account_id + state='active'
 *        writeCodexContainerAuthFile(<containerDir>/<cid>/auth.json) — atomic rename
 *        COMMIT (rename 成功后 commit) — ROLLBACK (任意失败)
 *
 * **Invariants**(plan 决策 M / Codex review v2 BLOCKER 3):
 *   - **永不写 master 文件**(那是 legacy `config.auth.codexOAuth` 路径的领地)
 *   - **永不写 `<codexContainerDir>/auth.json` 共享根目录**(legacy 共享 dir,服务 NULL 容器)
 *   - **持锁直到 atomic rename 完成,COMMIT 之前**:与 lazy migrate 串行(决策 M2)
 *   - 校验失败(漂移到别的 account_id 或非 active)→ COMMIT 不写文件(skip 该容器,
 *     不抛错,继续下一个;漂移由 lazy migrate / 重新 provision 路径自行写)
 *   - 写文件失败 → 删 tmp + ROLLBACK,记录 warn(下次 tick 再试)
 *   - 单进程独占:与 commercial 单进程 invariant 一致(决策 V),无分布式锁
 *
 * **Refresh failure 处理**:`refreshCodexAccountToken` 内部已:
 *   - safeRecordRefreshEvent + disableOnFailure(http_error/bad_response/persist_error)
 *   - network_transient 不禁(避免代理抖动烧池)
 *   actor 这一层只:catch + warn 不抛,继续下一个账号
 *
 * **优雅停止**:`stopCodexRefreshActor()` clearInterval + 设置 stopped flag,正在跑的
 * tick 完成当前账号循环后退出(不强中断写文件;atomic rename 单步内不可中断)
 */

import type { PoolClient } from 'pg'

import { tx } from '../db/queries.js'
import { writeCodexContainerAuthFile } from '../codex-auth/codexAuthFile.js'
import { query } from '../db/queries.js'
import { refreshCodexAccountToken, type RefreshCodexDeps } from './refresh.js'

/** 默认 actor tick 间隔。 */
export const DEFAULT_CODEX_ACTOR_INTERVAL_MS = 60 * 1000

/** 默认 refresh lead time(token 过期前多少 ms 触发刷新)。 */
export const DEFAULT_CODEX_REFRESH_LEAD_MS = 15 * 60 * 1000

export interface CodexRefreshActorDeps {
  /** 容器内 auth.json 的 host 根目录(默认从 v3supervisor `DEFAULT_V3_CODEX_CONTAINER_DIR`)。 */
  codexContainerDir: string
  /** 容器内 agent UID(决策 M2:writeCodexContainerAuthFile 需要 chown)。 */
  containerUid: number
  /** 容器内 agent GID。 */
  containerGid: number
  /** Refresh 注入(测试用 mock http;生产留空走默认 fetch)。 */
  refreshDeps?: RefreshCodexDeps
  /** Tick 间隔 ms(默认 60s)。 */
  intervalMs?: number
  /** Refresh lead time ms(默认 15min)。 */
  refreshLeadMs?: number
  /** 测试用:首次启动立即跑一次(默认 false,等第一次 tick)。 */
  runOnStart?: boolean
  /** 错误日志注入(默认 console.warn)。 */
  onError?: (msg: string, err: unknown) => void
  /** 测试用:覆盖 query helper(无 DB 单测)。 */
  queryFn?: typeof query
  /** 测试用:覆盖 tx helper(无 DB 单测)。 */
  txFn?: typeof tx
  /** 测试用:覆盖 refreshCodexAccountToken(无网络单测)。 */
  refreshFn?: typeof refreshCodexAccountToken
  /** 测试用:覆盖 writeCodexContainerAuthFile(无 fs 单测)。 */
  writeFn?: typeof writeCodexContainerAuthFile
  /**
   * v1.0.72 — 本机在 compute_hosts 表的 host_id(UUID)。
   * 与 `writeRemoteFn` 一起注入用于"row.host_uuid !== selfHostId → 远端写"判定。
   * 不注入(单机 monolith / 测试)→ 所有行都当本地写,与 v1.0.71 行为一致。
   */
  selfHostId?: string | null
  /**
   * v1.0.72 — 远端 host 的 per-container auth.json 写入回调。签名与 index.ts
   * 内 `putRemoteCodexAuth` helper 一致(getHostById → hostRowToTarget →
   * putRemoteCodexContainerAuth → finally psk.fill(0))。
   *
   * 不注入 → 远端容器一律 skip filesFailed 计数,actor 走"本地写"路径;
   * 配合 selfHostId 注入才生效。详见 writeForOneContainer。
   */
  writeRemoteFn?: (
    hostUuid: string,
    containerId: string,
    accessToken: string,
    lastRefreshIso: string,
  ) => Promise<void>
}

export interface CodexRefreshActorHandle {
  /** 优雅停止:clearInterval + 设 stopped flag。 */
  stop(): void
  /** 测试用:立即跑一次 tick,返回 {refreshed, skipped, failed} 统计。 */
  runNow(): Promise<TickStats>
}

export interface TickStats {
  /** 本 tick 成功 refresh 的账号数。 */
  refreshed: number
  /** 本 tick refresh 失败的账号数。 */
  failed: number
  /** 本 tick 写文件成功的容器数(累加跨账号)。 */
  filesWritten: number
  /** 本 tick 因漂移 / 非 active 而 skip 的容器数。 */
  filesSkipped: number
  /** 本 tick 写文件失败的容器数。 */
  filesFailed: number
}

function defaultOnError(msg: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[codexAccountActor] ${msg}:`, err)
}

interface AccountRow {
  id: string
}

interface ContainerLockRow {
  codex_account_id: string | null
  state: string
  host_uuid: string | null
}

/**
 * 启动 codex refresh actor。返回 handle 可调 stop()。
 *
 * **副作用**:setInterval 句柄会被 .unref(),不阻止 process exit。
 */
export function startCodexRefreshActor(deps: CodexRefreshActorDeps): CodexRefreshActorHandle {
  const intervalMs = Math.max(1000, deps.intervalMs ?? DEFAULT_CODEX_ACTOR_INTERVAL_MS)
  const refreshLeadMs = Math.max(60_000, deps.refreshLeadMs ?? DEFAULT_CODEX_REFRESH_LEAD_MS)
  const onError = deps.onError ?? defaultOnError
  const queryFn = deps.queryFn ?? query
  const txFn = deps.txFn ?? tx
  const refreshFn = deps.refreshFn ?? refreshCodexAccountToken
  const writeFn = deps.writeFn ?? writeCodexContainerAuthFile
  const writeRemoteFn = deps.writeRemoteFn
  const selfHostId = deps.selfHostId ?? null

  let stopped = false

  /** 单个 codex 账号:refresh + 逐容器持锁写。 */
  async function processAccount(accountId: bigint, stats: TickStats): Promise<void> {
    let refreshed: Awaited<ReturnType<typeof refreshFn>>
    try {
      refreshed = await refreshFn(accountId, deps.refreshDeps ?? {})
    } catch (err) {
      // refreshCodexAccountToken 内部已经 recordRefreshEvent + disableOnFailure 过,
      // 这里只 warn,不抛(让其他账号继续被处理)。
      onError(`refresh failed for codex account ${String(accountId)}`, err)
      stats.failed += 1
      return
    }
    stats.refreshed += 1

    let accessTokenStr = ''
    try {
      accessTokenStr = refreshed.token.toString('utf8')

      // 枚举绑定容器(无锁查询,只为拿 cid 列表;FOR UPDATE 在每个 cid 的独立事务里取)
      const containerRes = await queryFn<{ id: string }>(
        `SELECT id::text AS id
         FROM agent_containers
         WHERE codex_account_id = $1 AND state = 'active'`,
        [String(accountId)],
      )
      if (containerRes.rows.length === 0) return

      for (const c of containerRes.rows) {
        if (stopped) return
        const cid = c.id
        try {
          await writeForOneContainer(cid, accountId, accessTokenStr, refreshed.expires_at, stats)
        } catch (err) {
          // 单点 filesFailed 计数(v1.0.72 Codex 反馈):writeForOneContainer 内部
          // 抛错只触发 tx ROLLBACK,不计 stats;所有失败统一在此 catch 计 + log,
          // 避免双计。涵盖:本地 fs 写失败 / 远端 RPC 失败 / FOR UPDATE tx 自身 / 连接断
          stats.filesFailed += 1
          onError(`write per-container auth.json failed for container ${cid}`, err)
        }
      }
    } finally {
      // refresh 返回的 token / refresh buffer **必须 fill(0)**(同 RefreshedTokens 契约)
      refreshed.token.fill(0)
      refreshed.refresh?.fill(0)
      // 字符串副本无法 zero,但作用域结束即不可达;尽力而为
      accessTokenStr = ''
    }
  }

  /** 单个容器:持 FOR UPDATE 锁直到 atomic rename / 远端 PUT 完成,然后 COMMIT。
   *
   * v1.0.72 host 路由(plan v3 §G2 跨 host 同步):
   *   row.host_uuid IS NULL || == selfHostId  →  本地 writeFn(fs)
   *   row.host_uuid != selfHostId             →  远端 writeRemoteFn(node-agent RPC)
   *
   * **filesFailed 单点计数**(Codex 反馈):内层抛错只重抛,不记 stats —— 由
   * processAccount 的外层 catch 兜底统一计数,避免双计。 */
  async function writeForOneContainer(
    containerId: string,
    expectedAccountId: bigint,
    accessToken: string,
    expiresAt: Date,
    stats: TickStats,
  ): Promise<void> {
    await txFn(async (client: PoolClient) => {
      // 锁定行,验证仍 = 本次 actor 锁定的 account_id + state='active'
      const lockRes = await client.query<ContainerLockRow>(
        `SELECT codex_account_id::text AS codex_account_id, state, host_uuid::text AS host_uuid
         FROM agent_containers
         WHERE id = $1
         FOR UPDATE`,
        [containerId],
      )
      if (lockRes.rows.length === 0) {
        // 容器在枚举与持锁之间被删了 — skip(rollback 自然回滚 SELECT)
        stats.filesSkipped += 1
        return
      }
      const row = lockRes.rows[0]
      if (row.state !== 'active' || row.codex_account_id !== String(expectedAccountId)) {
        // 漂移:lazy migrate 改了绑定,或容器被 stop。skip — 让漂移后的 writer
        // 自己同步,actor 不越权(决策 M2 / Codex BLOCKER 3)
        stats.filesSkipped += 1
        return
      }

      // host 路由:
      //   - host_uuid IS NULL(单机 monolith legacy 行)→ 本地
      //   - selfHostId 未注入(测试 / 单机退化)→ 一律本地(actor 没远端写能力)
      //   - host_uuid == selfHostId → 本地
      //   - host_uuid != selfHostId → 远端
      // 注意:selfHostId 未注入但 host_uuid 非空的行,actor 当本地写。
      // 行为权衡:相比"按真实 host 路由但 writeRemoteFn 缺失就 fail"更稳 ——
      // 单机退化场景写到 master fs 是无害(容器在远端看不到该文件),但不会触发
      // tx ROLLBACK 把行 stuck 在 NULL,符合 actor "永不阻塞 refresh" 的设计。
      const isLocal =
        selfHostId === null
        || row.host_uuid === null
        || row.host_uuid === selfHostId
      const lastRefreshIso = new Date().toISOString()

      // 持锁期间:本地 atomic write tmp → chown → 0o400 → rename;
      //          远端 PUT /files?path=...&owner_uid=...&owner_gid=... + chown by server
      // 任一失败 → 抛 → tx 自动 ROLLBACK 持锁(plan 决策 M2 ROLLBACK 路径)
      // 成功 → 函数返回 → tx COMMIT(本地 rename / 远端 server 端 atomic rename 已落盘)
      if (isLocal) {
        await writeFn({
          rootDir: deps.codexContainerDir,
          containerId,
          containerUid: deps.containerUid,
          containerGid: deps.containerGid,
          auth: { accessToken, lastRefreshIso },
        })
      } else {
        if (!writeRemoteFn) {
          // 远端容器但 actor 未注入 writeRemoteFn(monolith 误装多机行 / 测试场景)
          throw new Error(
            `codexAccountActor: container ${containerId} on remote host ${row.host_uuid} but writeRemoteFn not wired`,
          )
        }
        await writeRemoteFn(row.host_uuid as string, containerId, accessToken, lastRefreshIso)
      }
      stats.filesWritten += 1
      // 不消费 expiresAt(只为 last_refresh 戳 isoNow);保留参数以备未来扩展
      void expiresAt
    })
  }

  async function runOneTick(): Promise<TickStats> {
    const stats: TickStats = {
      refreshed: 0,
      failed: 0,
      filesWritten: 0,
      filesSkipped: 0,
      filesFailed: 0,
    }
    if (stopped) return stats

    // 找出待刷新的 codex 账号(过期临近窗口内)
    let res
    try {
      res = await queryFn<AccountRow>(
        `SELECT id::text AS id
         FROM claude_accounts
         WHERE provider = 'codex' AND status = 'active'
           AND oauth_expires_at IS NOT NULL
           AND oauth_expires_at < (NOW() + ($1::int * interval '1 millisecond'))`,
        [refreshLeadMs],
      )
    } catch (err) {
      onError('failed to enumerate codex accounts due for refresh', err)
      return stats
    }
    if (res.rows.length === 0) return stats

    for (const row of res.rows) {
      if (stopped) return stats
      try {
        await processAccount(BigInt(row.id), stats)
      } catch (err) {
        // processAccount 自身已 try/catch refresh & write,这里只兜未捕获异常
        onError(`unexpected error processing codex account ${row.id}`, err)
      }
    }
    return stats
  }

  const timer = setInterval(() => {
    if (stopped) return
    void runOneTick().catch((err) => onError('tick handler crashed', err))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  if (deps.runOnStart) {
    void runOneTick().catch((err) => onError('initial tick crashed', err))
  }

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: runOneTick,
  }
}
