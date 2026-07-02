/**
 * codexLazyMigrate — codex 账号 disable 后,把容器 binding 重指向新 active
 * 账号的统一 helper(plan v3 feat/codex-disable-rebind)。
 *
 * **拆分动机**:
 *   - 同一段"selectForUpdate → 看 account_status → picker → write auth.json
 *     → UPDATE codex_account_id"语义被三条路径共用:
 *       1. `userChatBridge.codexBinding.acquire` (index.ts:~1419-1640) — 用户
 *          inbound 触发,tx 内做 select+pick+write+UPDATE 强一致(v1.0.72)
 *       2. `internalCodexTokenRefresh` M1 in-turn 自愈 — reverse-RPC 路径,
 *          必须 tx 外 IO(v1.0.115 教训:不能在 PG row 锁上压 60s remote PUT)
 *       3. `codexDisableFanout` M2 后台 actor — disable 事件 fanout,N=4 并发
 *          限流可接受 tx 内 IO,强一致
 *   - 三条路径对"持锁是否做 IO"语义有差异,所以**拆三个 helper** 让 caller
 *     自己拼装,而不是塞一个"all-in-one"出来掩盖差异。
 *
 * **职责切分**:
 *   - `acquireAndPickInTx(client, containerId, expectedUserId?, expectedCurrentAccountId?)`
 *      → tx 内 SELECT ... FOR UPDATE + 决策 → 返 `LazyMigrateOutcome`,**不做** UPDATE
 *   - `commitCodexRebindInTx(client, containerId, newAccountId)`
 *      → 仅 UPDATE codex_account_id
 *   - `fetchSnapshotAndWriteContainerAuth({...})`
 *      → 纯 IO(读 token + 写 auth.json/远端 PUT),caller 决定 tx 内调还是 tx 外调
 *
 * **一致性矩阵**见 `plan-codex-disable-rebind-v3.md` 失败矩阵章节。
 */

import type { PoolClient } from 'pg'
import { extractChatGptAccountId } from '../codex-auth/extractAccountId.js'
import { writeCodexContainerAuthFile } from '../codex-auth/codexAuthFile.js'
import { pickCodexAccountForBindingInTx } from './scheduler.js'
import { getRuntimeChannel } from '../runtimeChannel.js'
import {
  type AccountPlan,
  type CodexTokenSnapshot,
  getCodexTokenSnapshot,
  getCodexTokenSnapshotInTx,
} from './store.js'

/**
 * tx 内 helper 的判定输出。**不包含** `codex_account_id` UPDATE 副作用
 * —— caller 拿到 `rebound` 后自己调 `commitCodexRebindInTx` 在同 tx 内提交。
 *
 * 分支说明:
 * - `rebound` —— 当前账号非 active,picker 成功挑到新账号。caller 自决何时
 *   做 fetch+write(M1 tx 外,M2 tx 内强一致)
 * - `already_active` —— 并发 actor / 其他 acquire 已经把 binding 切走了,
 *   且新账号是 active。caller 应 fall through 走 happy refreshFn 路径
 * - `no_bound_account` —— `codex_account_id IS NULL`(legacy 绑定)。语义上
 *   等价 stale,caller 自决返 404 还是触发 docker 重 provision
 * - `vanished` —— `agent_containers.id` 不存在(被并发 stop/recycle 清掉)
 * - `state_inactive` —— `ac.state != 'active'`(vanished/error 中态),caller
 *   应返 409 CONTAINER_BINDING_CHANGED
 * - `user_mismatch` —— `ac.user_id != expectedUserId`(JWT uid 与 row owner
 *   不一致)。仅 M1 in-turn 会传 expectedUserId 才会触发
 * - `pool_empty` —— codex 池子里没 active 账号了。caller 自决:M1 返 422,
 *   M2 后台 actor 仅 log
 * - `target_changed` —— 仅 M2 fanout 使用:row.codex_account_id !=
 *   expectedCurrentAccountId,说明 row 已被并发路径 migrate 过,本次 fanout
 *   无需重复工作,直接 skip
 */
export type LazyMigrateOutcome =
  | {
      kind: 'rebound'
      newAccountId: bigint
      plan: AccountPlan
      hostUuidUnderLock: string | null
    }
  | {
      kind: 'already_active'
      currentAccountId: bigint
      hostUuidUnderLock: string | null
    }
  | { kind: 'no_bound_account' }
  | { kind: 'vanished' }
  | { kind: 'state_inactive' }
  | { kind: 'user_mismatch' }
  | { kind: 'pool_empty' }
  | { kind: 'target_changed' }

/**
 * tx 内调用 —— SELECT ... FOR UPDATE OF ac + 决策。
 *
 * **self-contains FOR UPDATE**(不依赖 caller 在 tx 外预锁,避免锁语义被
 * helper 边界破坏);重复锁同 row 在同 tx 内 no-op,所以 caller 之前已经
 * 锁过也安全(PG 文档保证)。
 *
 * @param expectedUserId
 *   - **M1 / acquire** 传 `BigInt(uid)`:JWT 上的 user_id 必须等于 row.user_id,
 *     否则返 `user_mismatch`(401 UNAUTHORIZED 语义)
 *   - **M2 fanout** 传 `null`:后台 actor 无用户上下文,跳过校验
 *
 * @param expectedCurrentAccountId
 *   - **M2 fanout** 传 fanout 触发时的 oldAccountId:如果 row 已经被并发
 *     migrate 走(row.codex_account_id != expectedCurrentAccountId)就返
 *     `target_changed`,跳过本次 fanout(否则 fanout 会把已经 active 的 row
 *     再 pick 一次,无害但浪费)
 *   - **M1 / acquire** 不传:在 inbound 上下文里 row 的当前 account_id 是
 *     什么不重要,只要它非 active 就该 migrate
 */
export async function acquireAndPickInTx(
  client: PoolClient,
  containerId: number,
  expectedUserId: bigint | null,
  expectedCurrentAccountId?: bigint,
): Promise<LazyMigrateOutcome> {
  const sel = await client.query<{
    account_id: string | null
    account_status: string | null
    state: string
    user_id: string
    host_uuid: string | null
  }>(
    `SELECT ac.codex_account_id::text AS account_id,
            ca.status AS account_status,
            ac.state AS state,
            ac.user_id::text AS user_id,
            ac.host_uuid AS host_uuid
     FROM agent_containers ac -- state selected above; caller returns stopped/vanished kinds
     LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
     WHERE ac.id = $1 AND ac.runtime_channel = $2
     FOR UPDATE OF ac`,
    // P1d 防御:lazy migrate 用户路径可达,按 channel 防跨 channel 锁/改(codex 下线见 P1f)。
    [containerId, getRuntimeChannel()],
  )
  if (sel.rows.length === 0) return { kind: 'vanished' }
  const row = sel.rows[0]!

  if (row.state !== 'active') return { kind: 'state_inactive' }

  if (expectedUserId !== null && BigInt(row.user_id) !== expectedUserId) {
    return { kind: 'user_mismatch' }
  }

  if (row.account_id === null) return { kind: 'no_bound_account' }

  const currentAccountId = BigInt(row.account_id)

  // M2 only:fanout 触发时 row 已被并发 migrate 走 → 本次 fanout skip。
  // 注意比较 BigInt 必须用 `!==`(JS BigInt 比较语义)。
  if (
    expectedCurrentAccountId !== undefined
    && currentAccountId !== expectedCurrentAccountId
  ) {
    return { kind: 'target_changed' }
  }

  if (row.account_status === 'active') {
    return {
      kind: 'already_active',
      currentAccountId,
      hostUuidUnderLock: row.host_uuid,
    }
  }

  // 当前账号非 active(disabled / cooldown / banned / 已被删) → 走 picker。
  // 用 containerId 做 sticky session key,rendezvous-hash 保证账号上下线时
  // 只迁移 O(1/N) 容器(prompt cache 稳定性,01-SPEC F-6.4)。
  const picked = await pickCodexAccountForBindingInTx(client, String(containerId))
  if (!picked) return { kind: 'pool_empty' }

  return {
    kind: 'rebound',
    newAccountId: picked.account_id,
    plan: picked.plan,
    hostUuidUnderLock: row.host_uuid,
  }
}

/**
 * tx 内调用 —— 单纯 UPDATE `codex_account_id`。
 *
 * 拆出来是为了 caller 显式表达"何时落盘 rebind 决策":M1 在 fetch+write 前
 * 提交(接受 write 失败 → 弱一致 self-heal);M2 在 fetch+write 成功后才提交
 * (强一致 ROLLBACK)。
 */
export async function commitCodexRebindInTx(
  client: PoolClient,
  containerId: number,
  newAccountId: bigint,
): Promise<void> {
  await client.query(
    `UPDATE agent_containers
     SET codex_account_id = $1, updated_at = NOW()
     WHERE id = $2 AND runtime_channel = $3`,
    [String(newAccountId), containerId, getRuntimeChannel()],
  )
}

export interface WriteAuthDeps {
  /** 当前 master 在多机拓扑里的 host_uuid;null = 单机 monolith,一律本地写。 */
  selfHostId: string | null
  /** 容器内 agent uid,默认 1000(V3_AGENT_UID)。 */
  containerUid: number
  containerGid: number
  /** per-container auth 根目录(本地与远端共用同一路径)。 */
  codexContainerDir: string
  /** 远端 host write 实现 —— `index.ts` 在 wired-up 阶段构造(getHostById +
   *  putRemoteCodexContainerAuth)。selfHostId 为 null 或 row.host_uuid 与
   *  selfHostId 一致时不会被调用,可不注入。 */
  putRemoteCodexAuth?: (
    hostUuid: string,
    containerId: string,
    accessToken: string,
    lastRefreshIso: string,
  ) => Promise<void>
  /** test 注入。tx 内 caller 传 client,helper 用 in-tx 版 snapshot;tx 外 caller
   *  不传,helper fallback 全局 pool。 */
  snapshotFn?: (id: bigint) => Promise<CodexTokenSnapshot | null>
  snapshotInTxFn?: (
    client: PoolClient,
    id: bigint,
  ) => Promise<CodexTokenSnapshot | null>
  /** test 注入。helper 不消费返回值,故签名只约束入参形状,允许 caller 适配
   *  `Promise<void>`(internalCodexTokenRefresh 的 fileWriter)或
   *  `Promise<WriteCodexContainerAuthFileResult>`(直接传 writeCodexContainerAuthFile)。 */
  writeLocalFn?: (args: {
    rootDir: string
    containerId: string
    containerUid: number
    containerGid: number
    auth: { accessToken: string; lastRefreshIso: string }
  }) => Promise<unknown>
}

export interface FetchAndWriteArgs {
  accountId: bigint
  containerId: number
  /** acquire/pick 阶段读到的 row.host_uuid。决定写本地 fs 还是远端 PUT;
   *  tx 内 caller 应在 SELECT FOR UPDATE 时一并读出来,避免 race。 */
  hostUuidUnderLock: string | null
  deps: WriteAuthDeps
  /** 给 M2 在 tx 内 IO 的路径用,把 PG client 传进来,helper 走 in-tx snapshot
   *  避免申请第二个 PG client(N=4 并发下最坏占用 8 个 client,接近 pool size)。
   *  M1 tx 外路径不传。 */
  client?: PoolClient
}

/**
 * 拉 token snapshot + 写 per-container auth.json。**纯 IO**,不碰 DB
 * 状态(`codex_account_id` UPDATE 是 caller 用 `commitCodexRebindInTx`
 * 自己做的)。
 *
 * 失败语义:任一步抛错。caller 决定如何回滚:
 *   - M1(tx 外)→ 当前 turn 返 500,row 已 commit 为 new,auth 仍 old;
 *     下次 OpenAI 401 → reverse-refresh 走 happy refreshFn 自愈
 *   - M2(tx 内)→ throw 出去触发 tx ROLLBACK,row 不变,等下次 acquire
 *     兜底
 *
 * Buffer 清零:token / refresh Buffer 都在 finally 显式 fill(0),与 refresh.ts
 * 的 token 处理规约对齐(codex round 2 BLOCKER#3 修复同型)。
 */
export async function fetchSnapshotAndWriteContainerAuth(
  args: FetchAndWriteArgs,
): Promise<{
  accessToken: string
  chatgptAccountId: string | null
  lastRefreshIso: string
}> {
  const { accountId, containerId, hostUuidUnderLock, deps, client } = args
  const snapshotFn = deps.snapshotFn ?? getCodexTokenSnapshot
  const snapshotInTxFn = deps.snapshotInTxFn ?? getCodexTokenSnapshotInTx
  const writeLocalFn = deps.writeLocalFn ?? writeCodexContainerAuthFile

  const snap = client
    ? await snapshotInTxFn(client, accountId)
    : await snapshotFn(accountId)
  if (!snap || !snap.token) {
    throw new Error(
      `codex token snapshot missing for account ${String(accountId)}`,
    )
  }
  try {
    const accessToken = snap.token.toString('utf8')
    const lastRefreshIso = new Date().toISOString()

    // host 路由(与 index.ts:1588-1623 acquire 路径完全同语义):
    //   - selfHostId 为 null(单机 monolith) → 一律本地
    //   - hostUuidUnderLock 为 null(legacy 行) → 本地
    //   - hostUuidUnderLock == selfHostId → 本地
    //   - 否则 → 远端 putRemoteCodexAuth(未注入则抛错)
    const isLocal =
      deps.selfHostId === null
      || hostUuidUnderLock === null
      || hostUuidUnderLock === deps.selfHostId

    if (isLocal) {
      await writeLocalFn({
        rootDir: deps.codexContainerDir,
        containerId: String(containerId),
        containerUid: deps.containerUid,
        containerGid: deps.containerGid,
        auth: { accessToken, lastRefreshIso },
      })
    } else {
      if (!deps.putRemoteCodexAuth) {
        throw new Error(
          `codexLazyMigrate: remote host ${hostUuidUnderLock} but putRemoteCodexAuth not wired`,
        )
      }
      await deps.putRemoteCodexAuth(
        hostUuidUnderLock,
        String(containerId),
        accessToken,
        lastRefreshIso,
      )
    }

    return {
      accessToken,
      chatgptAccountId: extractChatGptAccountId(accessToken),
      lastRefreshIso,
    }
  } finally {
    if (snap.token) snap.token.fill(0)
    if (snap.refresh) snap.refresh.fill(0)
  }
}
