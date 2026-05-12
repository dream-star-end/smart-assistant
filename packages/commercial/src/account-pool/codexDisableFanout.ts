/**
 * codexDisableFanout — codex 账号被 disable(admin 主动 / refresh.ts 401 自动)
 * 时,主动把所有绑定该账号的 active 容器 rebind 到新 active 账号,并把新 token
 * 写入容器 auth.json。
 *
 * **为什么需要**(plan v3 §核心一致性洞察):
 *   - acquire 路径(`userChatBridge.codexBinding.acquire`)和 M1
 *     (`internalCodexTokenRefresh` in-turn 自愈)都是**懒触发** —— 只有用户
 *     再次发消息 / codex CLI 主动 refresh 才会激活。
 *   - **admin 主动 disable 时,OpenAI 那边老 access token 仍然有效**:codex
 *     CLI 不会 401,reverse-refresh 不会触发,M1 自愈永远不激活,容器会
 *     继续用旧账号跑直到 token 自然过期(可能数小时)。这期间 master DB
 *     上账号已是 disabled,但实际计费 / 配额 / slot 仍走老账号 —— 三方
 *     一致性破坏。
 *   - 本 actor 在 disable 事件触发时**主动 fanout**,提前把绑定迁走、写新
 *     auth.json,堵这个语义漏洞。
 *
 * **与 M1 / acquire 的语义差异 —— 强一致**:
 *   - acquire / M1 在 reverse-RPC 路径上,**不能在 PG row 锁内做 60s remote PUT**
 *     (v1.0.115 教训:master event loop wedge)。所以 M1 接受弱一致:tx 内
 *     pick + UPDATE,tx 外 fetch + write;write 失败留下"row=new, auth=old"
 *     的不一致由下次 OpenAI 401 → reverse-refresh 自愈。
 *   - 本 actor 是**后台限流 N=4**,等同 codexAccountActor.writeForOneContainer
 *     的"持锁直到 atomic rename / 远端 PUT 完成 COMMIT 之前"语义,可接受持锁
 *     IO。所以走**强一致**路径:tx 内 pick + snapshot + write + UPDATE,任何
 *     步骤失败 ROLLBACK,row 保持 disabled binding,等下次 acquire / M1 兜底。
 *   - 强一致的代价是单容器持锁时间长(snapshot 解密 + fs 写 / 远端 PUT),N=4
 *     限流防止 PG pool 耗尽(最坏 8 个 client:tx client × 4 + snapshot 内部
 *     若再申请第二 client × 4;实际 `fetchSnapshotAndWriteContainerAuth` 在
 *     传 `client` 时走 in-tx snapshot,只占 4 个 client)。
 *
 * **去重**:同 accountId 已在 fanout 中再次 enqueue 静默丢弃 —— 不重新跑、
 * 不堆积队列。两次 disable 事件靠后台 acquire/M1 兜底,不靠 fanout 完美。
 */

import type { QueryRunner } from '../db/queries.js'
import { query as defaultQuery, tx as defaultTx } from '../db/queries.js'
import {
  type LazyMigrateOutcome,
  type WriteAuthDeps,
  acquireAndPickInTx,
  commitCodexRebindInTx,
  fetchSnapshotAndWriteContainerAuth,
} from './codexLazyMigrate.js'

export interface CodexDisableFanoutLogger {
  info?(msg: string, fields?: Record<string, unknown>): void
  warn?(msg: string, fields?: Record<string, unknown>): void
  error?(msg: string, fields?: Record<string, unknown>): void
}

export interface CodexDisableFanoutDeps {
  /** 透传给 `fetchSnapshotAndWriteContainerAuth` 的 selfHostId / containerUid /
   *  containerGid / codexContainerDir / putRemoteCodexAuth 等。 */
  writeAuth: WriteAuthDeps
  /** 限流。默认 4。N=4 与 codexAccountActor 同型限流,经验证不会撑满 pg pool。 */
  concurrency?: number
  logger?: CodexDisableFanoutLogger
  /** test 注入。 */
  queryFn?: typeof defaultQuery
  txFn?: typeof defaultTx
  // helper 注入(便于单测 mock,生产走默认 import)
  acquireAndPickInTxFn?: typeof acquireAndPickInTx
  commitCodexRebindInTxFn?: typeof commitCodexRebindInTx
  fetchAndWriteFn?: typeof fetchSnapshotAndWriteContainerAuth
}

/**
 * 进程内 in-flight 去重 Set。Key = accountId 字符串。
 *
 * 单进程语义足够:
 *   - 当前 v3 是单 gateway 部署,refresh.ts 的 refreshInflight 同型
 *   - 跨进程时同 accountId 并发 fanout 也只是重复工作,不会破坏一致性
 *     (acquireAndPickInTx 用 FOR UPDATE 串行化)
 */
const inflightFanout = new Set<string>()

/**
 * 异步触发一次账号 fanout。**不抛错** —— 调用方通常在 admin patchAccount /
 * refresh.ts disableOnFailure 后 fire-and-forget 调用,fanout 内部错误只 log。
 *
 * 同 accountId 已有 in-flight fanout 时静默丢弃。
 */
export function enqueueCodexDisableFanout(
  accountId: bigint | string,
  deps: CodexDisableFanoutDeps,
): void {
  const key = String(accountId)
  if (inflightFanout.has(key)) return
  inflightFanout.add(key)
  // 不 await:本函数 fire-and-forget。错误在 runFanout 内部自己吞 + log。
  void runFanout(BigInt(accountId), deps).finally(() => {
    inflightFanout.delete(key)
  })
}

/** test-only:重置 in-flight Set。 */
export function _resetInflightFanoutForTest(): void {
  inflightFanout.clear()
}

async function runFanout(
  accountId: bigint,
  deps: CodexDisableFanoutDeps,
): Promise<void> {
  const queryFn = deps.queryFn ?? defaultQuery
  const logger = deps.logger

  try {
    // 1) provider 二次确认(防止 caller 误把 claude 账号传进来 fanout)
    const provCheck = await queryFn<{ provider: string; status: string }>(
      `SELECT provider, status FROM claude_accounts WHERE id = $1`,
      [String(accountId)],
    )
    if (provCheck.rows.length === 0) {
      logger?.warn?.('codex_fanout_account_not_found', { accountId: String(accountId) })
      return
    }
    if (provCheck.rows[0]!.provider !== 'codex') {
      logger?.warn?.('codex_fanout_skip_non_codex', {
        accountId: String(accountId),
        provider: provCheck.rows[0]!.provider,
      })
      return
    }

    // 2) 列受影响容器。这里**不**用 SELECT ... FOR UPDATE —— 锁在 migrate
    //    tx 内每个容器自己拿,FOR UPDATE 范围必须最小,否则限流 N=4 也会撑大
    //    锁集。
    const rows = await queryFn<{ id: string }>(
      `SELECT id::text AS id
       FROM agent_containers
       WHERE codex_account_id = $1 AND state = 'active'`,
      [String(accountId)],
    )
    if (rows.rows.length === 0) {
      logger?.info?.('codex_fanout_no_containers', { accountId: String(accountId) })
      return
    }

    logger?.info?.('codex_fanout_start', {
      accountId: String(accountId),
      containerCount: rows.rows.length,
    })

    // 3) 限流并发跑 migrate
    const containerIds = rows.rows.map((r) => Number(r.id))
    const N = Math.max(1, deps.concurrency ?? 4)
    await runWithConcurrency(containerIds, N, async (cid) => {
      try {
        await migrateOneCodexContainer(cid, accountId, deps)
      } catch (err) {
        // 单 migrate 失败 → 不影响其他容器。row 通过 ROLLBACK 保持 disabled
        // binding,acquire / M1 路径下次兜底。
        logger?.warn?.('codex_fanout_migrate_one_failed', {
          containerId: cid,
          accountId: String(accountId),
          err: (err as Error)?.message ?? String(err),
        })
      }
    })

    logger?.info?.('codex_fanout_done', { accountId: String(accountId) })
  } catch (err) {
    logger?.error?.('codex_fanout_failed', {
      accountId: String(accountId),
      err: (err as Error)?.message ?? String(err),
    })
  }
}

async function migrateOneCodexContainer(
  containerId: number,
  oldAccountId: bigint,
  deps: CodexDisableFanoutDeps,
): Promise<void> {
  const txFn = deps.txFn ?? defaultTx
  const acquirePickFn = deps.acquireAndPickInTxFn ?? acquireAndPickInTx
  const commitFn = deps.commitCodexRebindInTxFn ?? commitCodexRebindInTx
  const fetchWriteFn = deps.fetchAndWriteFn ?? fetchSnapshotAndWriteContainerAuth
  const logger = deps.logger

  await txFn(async (client) => {
    // M2 不带 expectedUserId(后台 actor 无 user 上下文);带 expectedCurrentAccountId
    // = oldAccountId 检测 race:若 row 已经被并发 acquire/M1 migrate 走 → target_changed
    // 直接 skip(不二次重 migrate)。
    const outcome: LazyMigrateOutcome = await acquirePickFn(
      client,
      containerId,
      null,
      oldAccountId,
    )

    if (outcome.kind !== 'rebound') {
      logger?.info?.('codex_fanout_skip', {
        containerId,
        accountId: String(oldAccountId),
        outcome: outcome.kind,
      })
      return
    }

    // 强一致:tx 内做 fetch + write + UPDATE。write 失败抛错 → tx ROLLBACK
    // → row 不变,等下次 acquire/M1 兜底。
    await fetchWriteFn({
      accountId: outcome.newAccountId,
      containerId,
      hostUuidUnderLock: outcome.hostUuidUnderLock,
      deps: deps.writeAuth,
      client, // 让 helper 走 in-tx snapshot,避免多申请 PG client
    })
    await commitFn(client, containerId, outcome.newAccountId)

    logger?.info?.('codex_fanout_rebound', {
      containerId,
      oldAccountId: String(oldAccountId),
      newAccountId: String(outcome.newAccountId),
    })
  })
}

/**
 * 简易 N 并发限流(无外部依赖):worker 池消费同一 cursor。
 *
 * 选 worker-pool 实现而非"批量分片":分片在最后一片完成前其他 worker 闲置,
 * 长尾任务(如某个容器写远端 PUT 慢)会拖慢整体。worker-pool 自然负载均衡。
 *
 * 没引入 p-limit 等三方包是因为 commercial 包目前刻意控制 npm 依赖;这段
 * 8 行代码不值得额外 dep。
 */
export async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const N = Math.max(1, Math.min(concurrency, items.length))
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= items.length) return
      await fn(items[idx]!)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < N; i += 1) workers.push(worker())
  await Promise.all(workers)
}

/** test-only:断言 helper 类型不被意外漂移。 */
export type { QueryRunner }
