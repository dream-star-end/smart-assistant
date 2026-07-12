// clientSessionsPlan — master 会话写路径的**引擎中立决策层**(RFC D6b)。
//
// 为什么单独一个文件:热尾巴/归档(spill)与 server-authored append 的"搬哪些、切几个
// chunk、水位推到哪、行是否超限"这类**业务决策**,SQLite 与 PG 两个 backend 必须字节等价。
// 若各自在自己的执行代码里手写一遍,双 backend 迟早漂移(一边改了阈值/切分/幂等语义另一边
// 没跟上,产出不一致的归档结构 → 增量游标错乱)。这里把决策抽成**无 DB 依赖的纯函数**,两个
// backend 都:取锁 → 读行 → 调本文件的 plan → 按变更集执行各自方言的 SQL。业务语义单一权威。
//
// 边界(哪些留在执行层,不进 plan):
//   - **archivedDelta / archivedCount / messageCount**:依赖 INSERT OR IGNORE 的实际结果
//     (重放同批已归档 chunk 时 PK 冲突 → 该 chunk 不计)。plan 只产出 chunksToInsert;执行层
//     据 `cr.changes>0` 累加真正新插入的条数。故 plan **不**输出这三个值 —— 它们不是纯决策,
//     是执行观测。
//   - **DB 读**(会话行 SELECT、archived_ids 命中查、_filterOutArchivedIncoming):按引擎方言,
//     留在各 backend。plan 只吃"已读好的当前行快照 + 增量参数"。
//
// 与 sessionsDb.ts 的关系是**运行时环**(intentional runtime-only cycle):本文件在函数体内
// 调用 sessionsDb 的纯 helper(appendServerAuthoredPure / merge / normalize)与常量;sessionsDb
// 在 _spillOverflowCore / _appendServerAuthoredCore 的函数体内调用本文件的 plan。两向引用都在
// 函数体内(运行时),模块顶层不互相解引用 → ES module 环安全(function 声明实例化即就绪,
// 常量在首次 API 调用时早已初始化)。

import type { MessageUsageDelegate } from '@openclaude/protocol/teamCards'
import {
  appendServerAuthoredPure,
  ARCHIVE_CHUNK_MAX_BYTES,
  ARCHIVE_CHUNK_MAX_MSGS,
  MAX_SESSION_BYTES,
  type MessageLike,
  mergePreservingServerAuthored,
  normalizeAndAssignSeqs,
  SESSION_SOFT_TRIM_BYTES,
  SESSION_TAIL_MIN_MSGS,
  SESSION_TAIL_TARGET_BYTES,
} from './sessionsDb.js'

// ── spill 变更集 ─────────────────────────────────────────────────────────────

/** 一个待 INSERT 的归档 chunk(执行层按 INSERT OR IGNORE 落库,PK=(session_id, first_seq))。 */
export interface SpillChunkPlan {
  /** chunk 内 _seq 最小值(= PK 的一半;chunk 之间 _seq 池 disjoint,故唯一)。 */
  firstSeq: number
  /** chunk 内 _seq 最大值(idx_csa_chunks_last 的分页锚点)。 */
  lastSeq: number
  /** chunk 内消息条数(= messages.length)。 */
  messageCount: number
  /** chunk 冻结的消息数组(执行层 JSON.stringify 后整存)。 */
  messages: MessageLike[]
}

/** {@link planSpillOverflow} 的输出(纯决策;archivedDelta 交执行层据 cr.changes 计)。 */
export interface SpillOverflowPlan {
  /** 保留在 client_sessions.messages 行里的热尾巴。未触发 spill 时 === 入参 msgs(同引用,
   *  执行层据此维持"阈值内零副作用、tail 原样返回"的快路径语义)。 */
  tail: MessageLike[]
  /** 待 INSERT 的归档 chunk(空 = 无 spill)。 */
  chunksToInsert: SpillChunkPlan[]
  /** 待 INSERT 的 archived_ids 消息 id(spill 段中带 string id 者,按数组序)。 */
  idsToInsert: string[]
  /** 归档水位 = max(既有水位, 本次 spill 段 _seq 最大值)。无 spill → 既有水位。单调不降。 */
  archivedThroughSeq: number
}

/**
 * **spill 决策**(纯) —— 由 {@link _spillOverflowCore} 的判定部分抽出。给定当前 messages
 * 与既有归档水位,决定:是否 spill、搬哪些(spilled)/留哪些(tail)、spill 段如何切 chunk、
 * 新水位。**不触碰 DB**;归档 INSERT 与 archivedDelta 计数由执行层按变更集完成。
 *
 * 语义要点(与旧 _spillOverflowCore 逐字节对齐,勿动):
 *   - **软阈值触发**:序列化字节 ≤ SESSION_SOFT_TRIM_BYTES → 零副作用(tail === msgs 同引用)。
 *   - **缺 _seq 防御**:任一消息缺数字 _seq → 不 spill 原样返回(安全 no-op,非错误)。
 *   - **尾巴下限**:总条数 ≤ SESSION_TAIL_MIN_MSGS → 不搬(保住兜底注入窗口)。
 *   - **搬不删,_seq 冻结**:归档与保留尾巴 _seq 不变不重排(增量协议依赖单调 _seq)。
 *   - **chunk 切分**:数组序贪心切(每 chunk ≤ARCHIVE_CHUNK_MAX_MSGS 条且 ≤ARCHIVE_CHUNK_MAX_BYTES,
 *     先到者为界;单条 >上限也独立成 chunk 不空转)。
 */
export function planSpillOverflow(
  msgs: MessageLike[],
  currentArchivedThroughSeq: number,
): SpillOverflowPlan {
  const currentWatermark = currentArchivedThroughSeq > 0 ? currentArchivedThroughSeq : 0
  const noop = (): SpillOverflowPlan => ({
    tail: msgs,
    chunksToInsert: [],
    idsToInsert: [],
    archivedThroughSeq: currentWatermark,
  })

  // Fast path:行仍在软阈值内 → 什么都不搬(此处 JSON.stringify 是精确字节度量)。
  if (Buffer.byteLength(JSON.stringify(msgs), 'utf8') <= SESSION_SOFT_TRIM_BYTES) {
    return noop()
  }

  // 防御:spill 要求全员有数字 _seq(归档/增量游标)。缺 _seq → 拒绝 spill,原样返回。
  for (const m of msgs) {
    if (!m || typeof m._seq !== 'number' || !Number.isFinite(m._seq)) {
      return noop()
    }
  }

  // 尾巴不能低于下限:即便超软阈值,若总条数 ≤ MIN_MSGS 也不搬。
  if (msgs.length <= SESSION_TAIL_MIN_MSGS) {
    return noop()
  }

  // 逐条序列化字节(数组序)+ 1 字节分隔符估算。
  const SEP = 1
  const perBytes = new Array<number>(msgs.length)
  let totalBytes = 2 // 外层 [ ]
  for (let i = 0; i < msgs.length; i++) {
    const b = Buffer.byteLength(JSON.stringify(msgs[i]), 'utf8') + SEP
    perBytes[i] = b
    totalBytes += b
  }

  // 从数组头(最老)向后搬,直到剩余尾巴 ≤ TAIL_TARGET;但绝不搬到尾巴 < MIN_MSGS。
  const maxSpill = msgs.length - SESSION_TAIL_MIN_MSGS
  let spillCount = 0
  let tailBytes = totalBytes
  while (spillCount < maxSpill && tailBytes > SESSION_TAIL_TARGET_BYTES) {
    tailBytes -= perBytes[spillCount]
    spillCount++
  }
  if (spillCount <= 0) {
    // 溢出全集中在最新的 MIN_MSGS 条里 → 搬无可搬(硬闸 MAX_SESSION_BYTES 兜底)。
    return noop()
  }

  const spilled = msgs.slice(0, spillCount)
  const tail = msgs.slice(spillCount)

  const chunksToInsert: SpillChunkPlan[] = []
  const idsToInsert: string[] = []
  let watermark = currentWatermark
  let i = 0
  while (i < spilled.length) {
    // 贪心切 chunk:≤ARCHIVE_CHUNK_MAX_MSGS 条且 ≤ARCHIVE_CHUNK_MAX_BYTES,先到者为界。
    let j = i
    let bytes = 2 // chunk 自身的 [ ]
    while (j < spilled.length && (j - i) < ARCHIVE_CHUNK_MAX_MSGS) {
      // perBytes 以原 msgs 位置索引;spilled = msgs[0..spillCount],故 spilled[j] === msgs[j]。
      const b = perBytes[j]
      // 每 chunk 至少收 1 条:单条 >上限的巨型消息也独立成 chunk,不空转。
      if (j > i && bytes + b > ARCHIVE_CHUNK_MAX_BYTES) break
      bytes += b
      j++
    }
    const chunkMsgs = spilled.slice(i, j)
    // first_seq/last_seq = chunk 内 _seq 的 min/max(chunk 之间 _seq 池 disjoint,min 唯一)。
    let minSeq = Number.POSITIVE_INFINITY
    let maxSeq = 0
    for (const m of chunkMsgs) {
      const s = m._seq as number
      if (s < minSeq) minSeq = s
      if (s > maxSeq) maxSeq = s
    }
    chunksToInsert.push({
      firstSeq: minSeq,
      lastSeq: maxSeq,
      messageCount: chunkMsgs.length,
      messages: chunkMsgs,
    })
    // 仅对有 id 的消息记 archived_id(无 id 消息无从 PUT 复活 / append)。
    for (const m of chunkMsgs) {
      if (typeof m.id === 'string') idsToInsert.push(m.id)
    }
    // 水位无条件推进(不管 chunk 是否真被插入 —— 与旧 _spillOverflowCore 同,幂等重放下
    // 水位也应稳定在 max(既有, 段内最大 _seq))。
    if (maxSeq > watermark) watermark = maxSeq
    i = j
  }

  return { tail, chunksToInsert, idsToInsert, archivedThroughSeq: watermark }
}

// ── server-authored append 变更集 ────────────────────────────────────────────

/** {@link planAppendServerAuthored} 的输出。终态(already_exists/oversized)不带变更集。 */
export type AppendServerAuthoredPlan =
  | { kind: 'already_exists' }
  | { kind: 'oversized' }
  | {
      kind: 'write'
      /** 写回行的热尾巴。 */
      tail: MessageLike[]
      /** JSON.stringify(tail) —— plan 已算好,执行层复用避免再序列化一次。 */
      finalJson: string
      /** 写回 next_seq。 */
      nextSeq: number
      /** 写回 archived_through_seq。 */
      archivedThroughSeq: number
      /** spill 变更集(交执行层落库 + 据 cr.changes 计 archivedDelta → archivedCount)。 */
      chunksToInsert: SpillChunkPlan[]
      idsToInsert: string[]
    }

/**
 * **server-authored append 决策**(纯) —— 由 {@link _appendServerAuthoredCore} 的判定部分抽出
 * (append 叠加 → 幻影去重自合并 → _seq 规范化 → spill 决策 → 超限判定)。**不触碰 DB**。
 *
 * 调用方(执行层)负责:读行、archived_ids 命中查(→ already_exists)、JSON.parse(→ malformed)、
 * 落 spill 变更集 + UPDATE。本函数只吃已解析好的 existingMsgs + 增量,产出变更集或终态。
 *
 * 语义与旧核心逐字节对齐:
 *   - appendServerAuthoredPure 幂等(命中同 id 的 server 行 → already_exists)。
 *   - mergePreservingServerAuthored(self, self) 复用 PUT 路径的幻影去重(assistant/thinking/tool)。
 *   - normalizeAndAssignSeqs 分配新 _seq + 回填 legacy 行(同一事务)。
 *   - size guard 作用于 spill 后 tail(理论不可达,最后防线)。
 */
export function planAppendServerAuthored(
  existingMsgs: MessageLike[],
  message: MessageLike & { id: string },
  currentNextSeq: number,
  currentArchivedThroughSeq: number,
): AppendServerAuthoredPlan {
  const result = appendServerAuthoredPure(existingMsgs, message)
  // appendServerAuthoredPure 的唯一 applied:false 原因就是 already_exists。
  if (!result.applied) return { kind: 'already_exists' }

  // 幻影去重(与 PUT 路径对称):把 server-authored 行与客户端流式残行折叠。传同一数组安全:
  // 每个 id 都在 clientIds 里,merge 不新增重复,只跑幻影去重那一遍。
  const dedupedMessages = mergePreservingServerAuthored(
    result.messages,
    result.messages,
  ) as MessageLike[]

  // normalize:新 server 行拿新 _seq;legacy 行在同一事务回填。
  const { messages: finalMessages, nextSeq } = normalizeAndAssignSeqs(
    existingMsgs,
    dedupedMessages,
    currentNextSeq,
  )

  // 热尾巴 + 归档:normalize 后把最老的消息搬进归档,行只留热尾巴。
  const spill = planSpillOverflow(finalMessages, currentArchivedThroughSeq)
  const tail = spill.tail

  // Size guard —— spill 后作用于 tail(理论不可达,保留作最后防线)。
  const finalJson = JSON.stringify(tail)
  if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) {
    return { kind: 'oversized' }
  }

  return {
    kind: 'write',
    tail,
    finalJson,
    nextSeq,
    archivedThroughSeq: spill.archivedThroughSeq,
    chunksToInsert: spill.chunksToInsert,
    idsToInsert: spill.idsToInsert,
  }
}

// ── cost-only patch 变更集(RFC D6b;appendCostCredits 的 map-hit 分支决策)───────

/**
 * {@link planCostPatch} 的输出。'not_found'/'noop' 是终态(不带变更集):
 *   - not_found:目标 (msgId, _source==='server') 不在热尾巴 —— **执行层**据此查 archived_ids
 *     判定 noop(已归档)/ park pending(被删/编辑 out-of-band),plan 不查 DB。
 *   - noop:幂等重放(prevCost===costCredits,不 bump _seq)或 spill 后 tail 仍超限(理论不可达)。
 */
export type CostPatchPlan =
  | { kind: 'not_found' }
  | { kind: 'noop' }
  | {
      kind: 'patch'
      /** 写回行的热尾巴。 */
      tail: MessageLike[]
      /** JSON.stringify(tail) —— plan 已算好,执行层复用。 */
      finalJson: string
      /** 写回 archived_through_seq。 */
      archivedThroughSeq: number
      chunksToInsert: SpillChunkPlan[]
      idsToInsert: string[]
    }

/**
 * **cost-only patch 决策**(纯) —— 由 appendCostCredits 的 map-hit 分支抽出(定位目标 server 行
 * → 幂等判定 → in-place patch usage.costCredits + bump _seq → spill 决策 → 超限判定)。**不触碰 DB**。
 *
 * 执行层负责:取锁、读会话行、(not_found 时)查 archived_ids、落 spill 变更集 + 主行 UPDATE
 * (next_seq = next_seq + 1)。双 backend(SQLite / PG)复用本决策,不各养一份(RFC D6b 防漂移)。
 *
 * @param messages 会话热尾巴消息快照(已解析);@param msgId server_authored_request_map 定位的目标
 *   消息 id;@param costCredits 要写入的绝对成本值(非增量);@param currentNextSeq patch 消息拿的
 *   新 _seq(执行层从 next_seq 读、`>0 ? : 1` 归一后传入);@param currentArchivedThroughSeq 既有归档水位。
 */
export function planCostPatch(
  messages: MessageLike[],
  msgId: string,
  costCredits: string,
  currentNextSeq: number,
  currentArchivedThroughSeq: number,
): CostPatchPlan {
  const idx = messages.findIndex((m) => m && m.id === msgId && m._source === 'server')
  if (idx < 0) return { kind: 'not_found' }

  const existing = messages[idx] as MessageLike & { usage?: Record<string, unknown> }
  const prevCost = existing.usage?.costCredits
  // 幂等重放:成本未变 → noop,**不** bump _seq(防重试膨胀 seq 空间触发无谓尾巴重载)。
  if (typeof prevCost === 'string' && prevCost === costCredits) return { kind: 'noop' }

  const patched: MessageLike = {
    ...existing,
    _seq: currentNextSeq,
    usage: { ...(existing.usage ?? {}), costCredits },
  }
  const next: MessageLike[] = [...messages]
  next[idx] = patched

  // 热尾巴 + 归档:patch bump _seq/加 usage 键后行可能微涨,越软阈值则 spill。
  const spill = planSpillOverflow(next, currentArchivedThroughSeq)
  const tail = spill.tail
  const finalJson = JSON.stringify(tail)
  // Size guard(spill 后作用于 tail;理论不可达)。命中 → noop:成本这处展示丢,计费权威在
  // PG ledger 不影响钱;**不** fall through 到 pending(map 已精确定位,pending 是"还没找到目标")。
  if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) return { kind: 'noop' }

  return {
    kind: 'patch',
    tail,
    finalJson,
    archivedThroughSeq: spill.archivedThroughSeq,
    chunksToInsert: spill.chunksToInsert,
    idsToInsert: spill.idsToInsert,
  }
}

// ── delegate 成本按父客户端会话归并 变更集(RFC D6b;drainDelegateCost 决策)────────

/** planDelegateCostMerge 的一批 pending 输入(执行层从 pending_usage_patches 读好后传入)。 */
export interface DelegatePendingRow {
  costCredits: string
  delegateAgentId: string | null
}

/**
 * {@link planDelegateCostMerge} 的输出。三个终态由执行层落不同 SQL 效果:
 *   - no_positive_cost:Σ委派成本 ≤0(无归并价值)—— 执行层清本批 pending、不写库、不 bump _seq,
 *     返回 merged='0'、drained=本批行数。
 *   - target_not_ready:会话缺位 / 找不到队长 server 行 / spill 后超限 —— 执行层**保留** pending
 *     (下一 turn 再试),返回 merged='0'、drained=0。
 *   - merge:正常归并 —— 执行层落 spill + 主行 UPDATE(next_seq+1)+ 清本批 pending。
 */
export type DelegateCostMergePlan =
  | { kind: 'no_positive_cost' }
  | { kind: 'target_not_ready' }
  | {
      kind: 'merge'
      tail: MessageLike[]
      finalJson: string
      archivedThroughSeq: number
      chunksToInsert: SpillChunkPlan[]
      idsToInsert: string[]
      /** 本次归并的 delegate 成本总和(十进制字符串)。 */
      merged: string
      /** 归并后队长助手行 usage.delegates[] 快照(按 agentId 排序;含历史 + 本次)。 */
      delegates: MessageUsageDelegate[]
    }

/**
 * **委派成本按父客户端会话归并决策**(纯) —— 由 drainDelegateCostForClientSession 抽出
 * (Σ委派成本 + per-agent 分组 → 累加进队长行 usage.costCredits/delegates[] → spill → 超限判定)。
 * **不触碰 DB**。双 backend 复用本决策(RFC D6b 防漂移)。
 *
 * @param messages 队长客户端会话热尾巴消息(已解析);会话缺位时传 null(→ target_not_ready)。
 * @param msgId 队长助手 server 行的消息 id。@param pendings 本批已读的委派 pending。
 * @param currentNextSeq 队长行 patch 拿的新 _seq(会话缺位时传任意,不使用)。
 * @param currentArchivedThroughSeq 既有归档水位。
 *
 * 语义要点(与旧核心逐字节对齐):累加不替换(base+Σ)、delegates 累加合并(读历史 → 叠加本次 →
 * 排序)、Σ≤0 先判(即便会话缺位也清 pending)、缺位/找不到/超限保守保留 pending。
 */
export function planDelegateCostMerge(
  messages: MessageLike[] | null,
  msgId: string,
  pendings: DelegatePendingRow[],
  currentNextSeq: number,
  currentArchivedThroughSeq: number,
): DelegateCostMergePlan {
  // Σ + per-agent 分组(仅正成本计入;缺 agentId 的成本仍进 Σ,不进 delegates[] 明细)。
  let sum = 0n
  const perAgent = new Map<string, bigint>()
  for (const p of pendings) {
    let v: bigint
    try {
      v = BigInt(p.costCredits)
    } catch {
      continue // skip malformed
    }
    if (v <= 0n) continue
    sum += v
    const aid = p.delegateAgentId
    if (aid) perAgent.set(aid, (perAgent.get(aid) ?? 0n) + v)
  }
  // Σ≤0:无归并价值 → 执行层清 pending(即便会话缺位也清)。先于会话/队长行判定。
  if (sum <= 0n) return { kind: 'no_positive_cost' }

  // 会话缺位(尚未 sink / 已删)→ 保守保留 pending。
  if (messages === null) return { kind: 'target_not_ready' }
  const idx = messages.findIndex((m) => m && m.id === msgId && m._source === 'server')
  // 找不到队长助手行(未落库 / 被删)→ 保守保留 pending。
  if (idx < 0) return { kind: 'target_not_ready' }

  const existing = messages[idx] as MessageLike & { usage?: Record<string, unknown> }
  let base = 0n
  try {
    base = BigInt((existing.usage?.costCredits as string) ?? '0')
  } catch {
    base = 0n
  }
  const nextCost = (base + sum).toString()

  // delegates[] 累加合并(读历史已归并明细 → 叠加本次 perAgent → 确定性排序)。
  const mergedAgent = new Map<string, bigint>()
  const prevDelegates = existing.usage?.delegates
  if (Array.isArray(prevDelegates)) {
    for (const d of prevDelegates as unknown[]) {
      if (!d || typeof d !== 'object') continue
      const aid = (d as { agentId?: unknown }).agentId
      const cc = (d as { costCredits?: unknown }).costCredits
      if (typeof aid !== 'string' || !aid) continue
      try {
        mergedAgent.set(aid, (mergedAgent.get(aid) ?? 0n) + BigInt(String(cc ?? '0')))
      } catch {
        /* skip */
      }
    }
  }
  for (const [aid, v] of perAgent) mergedAgent.set(aid, (mergedAgent.get(aid) ?? 0n) + v)
  const delegates: MessageUsageDelegate[] = [...mergedAgent.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([agentId, v]) => ({ agentId, costCredits: v.toString() }))

  const patched: MessageLike = {
    ...existing,
    _seq: currentNextSeq,
    usage: {
      ...(existing.usage ?? {}),
      costCredits: nextCost,
      ...(delegates.length > 0 ? { delegates } : {}),
    },
  }
  const next: MessageLike[] = [...messages]
  next[idx] = patched

  const spill = planSpillOverflow(next, currentArchivedThroughSeq)
  const tail = spill.tail
  const finalJson = JSON.stringify(tail)
  // 超限拒绝(理论不可达):保留 pending,不写库(下一轮 / 修 blob 后仍可归并)。
  if (Buffer.byteLength(finalJson, 'utf8') > MAX_SESSION_BYTES) return { kind: 'target_not_ready' }

  return {
    kind: 'merge',
    tail,
    finalJson,
    archivedThroughSeq: spill.archivedThroughSeq,
    chunksToInsert: spill.chunksToInsert,
    idsToInsert: spill.idsToInsert,
    merged: sum.toString(),
    delegates,
  }
}
