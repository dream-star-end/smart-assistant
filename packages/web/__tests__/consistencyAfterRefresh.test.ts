/**
 * Integration tests covering the user-visible bug regression:
 *   "发一句话后,token 行 + '已回复' 角标在刷新后消失"
 *
 * Scope (per docs/CONSISTENCY_FIELDIZATION_PLAN.md §5.4):
 *   T18 — bug 复现/回归(end-to-end 数据流)
 *   T19 — 历史 IDB 自愈条件化(round-trip 通过 dbPut/dbGetAll memory fallback)
 *   T21 — costCredits 早到 / 晚到 / 跨进程持久(setUsage 单调累加)
 *
 * 不在本文件覆盖范围(原 spec §5.4 中):
 *   T20(多 tab BroadcastChannel)— 已有 broadcastAuth.test.ts 模式;Bug 修复路径
 *     不依赖 BC,usage 跨进程通过 server-authored 持久化 + GET,无独立 BC 风险面。
 *   T22(增量 GET MutationObserver 断言)— 需要 jsdom infra(本仓未引入);DOM patch
 *     行为已通过 review 确认 updateMsgMetaEl 仅 mutate .msg-meta 元素,不 re-render
 *     .msg 气泡。
 *   T23(派生 status DOM 断言)— pureFunctions.test.ts T15 已覆盖派生函数全分支;
 *     DOM 角标渲染靠 messages.js _STATUS_LABEL 表查映射,无新逻辑。
 *   T24(client 伪造 server-authoritative 字段被拒)— packages/storage clientPutStrip.test.ts
 *     已在 server upsertClientSession 入口 strip 全部 6 个 server-authoritative 字段
 *     + 'replied' status,storage 端权威防御。
 *
 * 运行:
 *   npx tsx --test packages/web/__tests__/consistencyAfterRefresh.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUBLIC = resolve(import.meta.dirname, '..', 'public')
const modulesDir = resolve(PUBLIC, 'modules')

function readModule(name: string): string {
  return readFileSync(resolve(modulesDir, name), 'utf-8')
}

const SYNC_SRC = readModule('sync.js')
const MESSAGES_SRC = readModule('messages.js')
const WEBSOCKET_SRC = readModule('websocket.js')
const DB_SRC = readModule('db.js')

// ── 函数提取助手 ──
//
// 同 syncConflictMerge.test.ts 的 column-0 closing-brace 扫描法。
function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

// 提取 module-level const 块(_MSG_EPHEMERAL_KEYS / _MSG_SERVER_AUTHORITATIVE_KEYS)
function extractConstBlock(source: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[[\\s\\S]*?\\]`).exec(source)
  if (!m) throw new Error(`const ${name} not found`)
  return m[0]
}

// ── 编译纯函数 ──
//
// 把 sync/messages/websocket/db 里跟一致性强相关的纯函数都拉到一个闭包里,
// 直接互相调用,不需要 module 解析或浏览器全局。
const _ephemeralConst = extractConstBlock(SYNC_SRC, '_MSG_EPHEMERAL_KEYS')
const _serverAuthConst = extractConstBlock(SYNC_SRC, '_MSG_SERVER_AUTHORITATIVE_KEYS')
const _stripFn = extractTopLevelFn(SYNC_SRC, '_stripMessageEphemeral')
const _deriveFn = extractTopLevelFn(MESSAGES_SRC, '_deriveUserMsgStatus')
const _formatCreditsFn = extractTopLevelFn(WEBSOCKET_SRC, 'formatCreditsInline')
const _formatMetaFn = extractTopLevelFn(WEBSOCKET_SRC, 'formatMeta')
const _normalizeFn = extractTopLevelFn(DB_SRC, '_normalizeLoadedSession')

const _bundle = new Function(`
  ${_ephemeralConst};
  ${_serverAuthConst};
  ${_stripFn};
  ${_deriveFn};
  ${_formatCreditsFn};
  ${_formatMetaFn};
  ${_normalizeFn};
  return {
    _stripMessageEphemeral,
    _deriveUserMsgStatus,
    formatMeta,
    _normalizeLoadedSession,
  };
`)() as {
  _stripMessageEphemeral: (msgs: any[]) => any[]
  _deriveUserMsgStatus: (messages: any[], idx: number) => string | null
  formatMeta: (m: any) => string
  _normalizeLoadedSession: (s: any) => any
}

const { _stripMessageEphemeral, _deriveUserMsgStatus, formatMeta, _normalizeLoadedSession } =
  _bundle

// setUsage 不能整段提取(它依赖 state / _deps 引用),这里直接复刻其纯字段合并逻辑
// 即"浅 spread + key 覆盖"。本测试只关心字段合并语义,DOM 副作用单独走 T22 review。
function setUsage(msg: any, usagePartial: any): void {
  if (!msg) return
  if (!usagePartial || typeof usagePartial !== 'object') return
  msg.usage = { ...(msg.usage || {}), ...usagePartial }
}

// 最简版 mergePreservingServerAuthored — 与 storage/sessionsDb.ts 行为对齐,
// 用 _source:'server' 的 id 替换 client 同 id 项,server 独有项 push 到末尾。
// 真实 storage 版做了更多(同 turn 客户端 assistant 去重、ts 排序);本测试只验
// 字段层面替换/保留,storage 行为另在 sessionsDbMerge.test.ts 全分支测过。
function mergePreservingServerAuthored<T extends { id?: string; _source?: string }>(
  server: readonly T[],
  client: readonly T[],
): T[] {
  const auth = new Map<string, T>()
  for (const m of server) {
    if (m && m._source === 'server' && typeof m.id === 'string') auth.set(m.id, m)
  }
  if (auth.size === 0) return [...client]
  const ids = new Set<string>()
  for (const m of client) if (m?.id) ids.add(m.id)
  const out: T[] = client.map((m) =>
    m && typeof m.id === 'string' && auth.has(m.id) ? (auth.get(m.id) as T) : m,
  )
  for (const [, m] of auth) if (m.id && !ids.has(m.id)) out.push(m)
  return out
}

// ═══════════════════════════════════════════════════════════════════
// T18 — Bug 复现/回归
// ═══════════════════════════════════════════════════════════════════
//
// 用户报告:发一句话 → 后端开始流回 → cost_charged 帧到达 → token 行显示 →
// 强刷页面 → token 行 + "已回复" 角标都不见了。
//
// 根因:旧前端把 cost meta 写在 msg.metaText / _rawMeta(派生字段),user 消息
// 用粘性 status='replied' 标记。两者都不在 server-authoritative,刷新后从 IDB /
// server GET 拿到的 row 没有这两个字段 → UI 显示空。
//
// 新方案:msg.usage 由 server 持久化 + 派生 status 在 render 时算。本测试模拟从
// "user 发送" 到 "强刷重渲" 的完整数据流,断言每步字段流向正确。
describe('T18: 用户发一句话 → cost_charged → 409 server-wins → 刷新 — 整链一致', () => {
  it('刷新后 token 行 + "已回复" 仍显示', () => {
    // ── Step 1:user 发送,client 在内存里建 user + 占位 streaming assistant ──
    const userMsg: any = {
      id: 'u-1',
      role: 'user',
      ts: 1000,
      text: '帮我算 1+1',
      status: 'sending',
    }
    const streamingAssistant: any = {
      id: 'a-1', // 客户端临时 id,server 完成后会替换为 srv-${peerId}-tN
      role: 'assistant',
      ts: 1001,
      text: '',
      _partial: true,
    }
    let messages: any[] = [userMsg, streamingAssistant]

    // ── Step 2:server 推 cost_charged broadcast(通过 setUsage 合入 msg.usage) ──
    // 本步骤模拟 outbound.cost_charged 帧打到 streaming assistant 上;后端是分(BigInt 字符串)。
    setUsage(streamingAssistant, { costCredits: '850' })
    assert.equal(streamingAssistant.usage.costCredits, '850', 'cost broadcast 立即合入')

    // ── Step 3:isFinal 帧落地 server-authored usage(turn/tokens)──
    // setUsage 浅 merge,不会把 costCredits 覆盖掉。
    setUsage(streamingAssistant, {
      inputTokens: 13178,
      outputTokens: 142,
      cacheReadTokens: 4096,
      turn: 1,
    })
    assert.deepEqual(
      streamingAssistant.usage,
      { costCredits: '850', inputTokens: 13178, outputTokens: 142, cacheReadTokens: 4096, turn: 1 },
      'isFinal 字段并入,不覆盖 costCredits',
    )

    // ── Step 4:client 把 user 改成 'sent'(发送成功),streaming 结束 ──
    userMsg.status = 'sent'
    streamingAssistant._partial = false
    streamingAssistant._completed = true

    // ── Step 5:client PUT → 模拟 409 → 重新拉 GET(server-wins)──
    // server 端 messages 含 server-authored assistant(_source/_seq/usage 都齐),
    // **不**含 user.status='replied'(派生字段 storage 已 strip)。
    const serverAssistant: any = {
      id: 'srv-pX-t1', // server 自己的 id
      role: 'assistant',
      ts: 1002,
      text: '答案是 2',
      _source: 'server',
      _seq: 7,
      status: 'completed',
      usage: {
        costCredits: '850',
        inputTokens: 13178,
        outputTokens: 142,
        cacheReadTokens: 4096,
        turn: 1,
      },
    }
    const serverUser: any = {
      id: 'u-1',
      role: 'user',
      ts: 1000,
      text: '帮我算 1+1',
      // 注意 server 这一边没写 status — server 端 strip 把客户端 sent/sending 都吞了 —
      // user 状态由 client 自己维持。
    }
    const serverMsgs = [serverUser, serverAssistant]

    // server-wins 替换:client 同 id 项被 server 版替换;client 独有的临时 streaming
    // assistant(id='a-1')在 storage 层已经被 mergePreservingServerAuthored 同 turn
    // 客户端 assistant 去重规则吞掉,这里直接以 server 视图为准。
    messages = mergePreservingServerAuthored(serverMsgs, [userMsg])
    // 期望:user(client)+ server-authored assistant
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].id, 'u-1')
    assert.equal(messages[0].status, 'sent', 'client 维持 user.status=sent,server 不写')
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1]._source, 'server')
    assert.deepEqual(messages[1].usage, serverAssistant.usage)
    assert.equal(messages[1].status, 'completed')

    // ── Step 6:render 派生 user.status —— 应该是 'replied' ──
    const userIdx = messages.findIndex((m) => m.id === 'u-1')
    const derived = _deriveUserMsgStatus(messages, userIdx)
    assert.equal(derived, 'replied', '后续有 server-authored completed assistant → 派生 replied')

    // ── Step 7:render meta 行 —— formatMeta(assistant) ──
    const meta = formatMeta(messages[1])
    assert.ok(meta.includes('¥8.50'), `meta 行应含 ¥8.50:${meta}`)
    assert.ok(meta.includes('in 13178'), meta)
    assert.ok(meta.includes('out 142'), meta)
    assert.ok(meta.includes('cache-r 4096'), meta)
    assert.ok(meta.includes('T1'), meta)

    // ── Step 8:模拟 PUT 前 strip(_stripMessageEphemeral)──
    // client 送出去的不许带 server-authoritative 字段或 'replied' status。
    const cleaned = _stripMessageEphemeral(messages)
    for (const k of [
      '_seq',
      '_source',
      'usage',
      '_truncated',
      '_errorCode',
      '_errorDetail',
      '_partial',
      '_completed',
      '_rawMeta',
      'metaText',
      'output',
      'error',
      'bashTail',
      'inputJson',
      'inputPreview',
      // partialJson — gateway-streamed input_json_delta accumulator,
      // strictly ephemeral, must not survive a PUT body.
      'partialJson',
    ]) {
      for (const m of cleaned) {
        assert.equal(m[k], undefined, `_stripMessageEphemeral 应剥离 ${k}`)
      }
    }
    // 但 PUT body 里的内容(text/role/id/ts/status)保留。
    assert.equal(cleaned[0].id, 'u-1')
    assert.equal(cleaned[0].text, '帮我算 1+1')
    assert.equal(cleaned[0].status, 'sent', "client status='sent' 保留")
    assert.equal(cleaned[1].id, 'srv-pX-t1')
    assert.equal(cleaned[1].status, 'completed')

    // ── Step 9:模拟刷新 —— state 清空,从 IDB 重新加载 ──
    // IDB 里持久化的是真正的 sess.messages(包含 server-authored 字段),
    // _normalizeLoadedSession 在 dbGetAll 阶段过滤老污染字段。
    const persisted = {
      id: 'sess-1',
      messages: [
        // 假设 IDB 里同时保留了 client 的 user + server-authored assistant
        { id: 'u-1', role: 'user', ts: 1000, text: '帮我算 1+1', status: 'sent' },
        { ...serverAssistant }, // 含 _source/_seq/usage/status='completed'
      ],
    }
    const loaded = _normalizeLoadedSession(persisted)
    // 字段全保留,因为没有污染需要清理。
    assert.equal(loaded.messages[0].status, 'sent')
    assert.equal(loaded.messages[1]._source, 'server')
    assert.deepEqual(loaded.messages[1].usage, serverAssistant.usage)
    assert.equal(loaded.messages[1].status, 'completed')

    // ── Step 10:重渲 — 派生 status + meta 行 ── 跟刷新前一致 ──
    const reloadDerived = _deriveUserMsgStatus(loaded.messages, 0)
    assert.equal(reloadDerived, 'replied', '刷新后派生仍为 replied')
    const reloadMeta = formatMeta(loaded.messages[1])
    assert.equal(reloadMeta, meta, '刷新后 meta 文字串与刷新前完全一致')
  })

  it('thinking-only turn — user 派生 status="sent" 不"replied"', () => {
    // server 写了 thinking 但没写 assistant(turn 中断 / 仅推理 / interrupted),
    // 此时 user 应该显示 sent 不 replied。
    const messages = [
      { id: 'u-1', role: 'user', ts: 1000, status: 'sent' },
      { id: 'th-1', role: 'thinking', ts: 1001, _source: 'server' }, // not assistant
    ]
    assert.equal(_deriveUserMsgStatus(messages, 0), 'sent')
  })

  it('interrupted server-authored assistant — 不算 replied', () => {
    const messages = [
      { id: 'u-1', role: 'user', ts: 1000, status: 'sent' },
      {
        id: 'a-1',
        role: 'assistant',
        ts: 1001,
        _source: 'server',
        status: 'interrupted', // ← 关键
        text: 'partial...',
      },
    ]
    assert.equal(_deriveUserMsgStatus(messages, 0), 'sent')
  })
})

// ═══════════════════════════════════════════════════════════════════
// T19 — 历史 IDB 自愈条件化
// ═══════════════════════════════════════════════════════════════════
//
// 老前端写过 metaText / _rawMeta / status='replied' 到 IDB,新前端 dbGetAll 阶段
// 走 _normalizeLoadedSession 条件清洗:
//   - row A:含 metaText/_rawMeta 但**无 usage** → 保留(老 row 兼容,formatMeta
//     走 _rawMeta fallback 显示)
//   - row B:含 metaText/_rawMeta **且**有 usage → 删除(usage 是权威源)
//   - row C:user 消息 status='replied' → 删除(改派生)
describe('T19: dbGetAll → _normalizeLoadedSession — 三类历史污染 row', () => {
  it('row A — 老 row 无 usage:保留 metaText/_rawMeta + formatMeta 走 fallback', () => {
    const sess = {
      id: 'sess-A',
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          ts: 1000,
          text: 'old reply',
          metaText: 'in 100 · out 50',
          _rawMeta: { inputTokens: 100, outputTokens: 50 },
          // 注意:无 usage
        },
      ],
    }
    const loaded = _normalizeLoadedSession(sess)
    const m = loaded.messages[0]
    assert.equal(m.metaText, 'in 100 · out 50', 'metaText 应保留')
    assert.deepEqual(m._rawMeta, { inputTokens: 100, outputTokens: 50 }, '_rawMeta 应保留')
    // formatMeta 通过 _rawMeta fallback 仍能渲染
    const meta = formatMeta(m)
    assert.ok(meta.includes('in 100'), `应渲染 in 100,实际:${meta}`)
    assert.ok(meta.includes('out 50'), `应渲染 out 50,实际:${meta}`)
  })

  it('row B — 老 row 有 usage:删除 metaText/_rawMeta + formatMeta 走 usage', () => {
    const sess = {
      id: 'sess-B',
      messages: [
        {
          id: 'a-1',
          role: 'assistant',
          ts: 1000,
          text: 'reply',
          metaText: 'old text', // 应被 strip
          _rawMeta: { inputTokens: 999 }, // 应被 strip
          usage: { inputTokens: 100, outputTokens: 50, costCredits: '50' },
        },
      ],
    }
    const loaded = _normalizeLoadedSession(sess)
    const m = loaded.messages[0]
    assert.equal(m.metaText, undefined, 'metaText 应被 strip')
    assert.equal(m._rawMeta, undefined, '_rawMeta 应被 strip')
    assert.deepEqual(m.usage, { inputTokens: 100, outputTokens: 50, costCredits: '50' })
    // formatMeta 走 usage,不读老的 _rawMeta inputTokens=999
    const meta = formatMeta(m)
    assert.ok(meta.includes('in 100'), `应走 usage:${meta}`)
    assert.ok(!meta.includes('in 999'), `不应使用陈旧 _rawMeta:${meta}`)
    assert.ok(meta.includes('50 积分') || meta.includes('¥0.50') || meta.includes('积分'), meta)
  })

  it('row C — user 消息 status="replied" 历史污染:删除 + 派生算', () => {
    const sess = {
      id: 'sess-C',
      messages: [
        { id: 'u-1', role: 'user', ts: 1000, status: 'replied' }, // 老 row 污染
        {
          id: 'a-1',
          role: 'assistant',
          ts: 1001,
          _source: 'server',
          status: 'completed',
          text: 'reply',
        },
      ],
    }
    const loaded = _normalizeLoadedSession(sess)
    assert.equal(loaded.messages[0].status, undefined, "user.status='replied' 被 strip")
    // 派生函数算回来
    assert.equal(
      _deriveUserMsgStatus(loaded.messages, 0),
      'replied',
      '后续有 server-authored completed assistant → 派生为 replied',
    )
  })

  it('混合污染 row(metaText + _rawMeta + status="replied" + ephemeral 字段) — 一次清洗', () => {
    const sess = {
      id: 'sess-mixed',
      messages: [
        {
          id: 'u-1',
          role: 'user',
          ts: 1000,
          status: 'replied',
          // ephemeral 不该出现在 user 但容错
          inputPreview: 'preview',
        },
        {
          id: 'a-1',
          role: 'assistant',
          ts: 1001,
          _source: 'server',
          status: 'completed',
          usage: { costCredits: '500', inputTokens: 200, turn: 1 },
          // 历史污染齐全:
          metaText: 'old',
          _rawMeta: { fake: 1 },
          _partial: true,
          _completed: false,
          output: 'partial',
          error: 'oops',
          bashTail: 'tail',
          inputJson: '{}',
          inputPreview: 'pv',
          // partialJson — even on server-authored rows this is intra-stream
          // garbage that must always be stripped (parallel to _partial/bashTail).
          partialJson: '{"file_path":"/x","new_string":"...',
        },
      ],
    }
    const loaded = _normalizeLoadedSession(sess)
    const u = loaded.messages[0]
    const a = loaded.messages[1]
    assert.equal(u.status, undefined)
    // ephemeral 字段 inputPreview: client-authored user 行被 strip;_partial/bashTail 始终 strip
    assert.equal(u.inputPreview, undefined)
    // _partial / bashTail / partialJson 始终清(包括 server-authored)
    assert.equal(a._partial, undefined)
    assert.equal(a.bashTail, undefined)
    assert.equal(a.partialJson, undefined)
    // Phase 1 tool durability 语义(db.js:122-127):server-authored 行的
    // `_completed / output / error / inputJson / inputPreview` 必须保留 —
    // 否则会把 server-authoritative tool 字段也抹掉。本 row `_source: 'server'`
    // 命中保留分支。
    assert.equal(a._completed, false)
    assert.equal(a.output, 'partial')
    assert.equal(a.error, 'oops')
    assert.equal(a.inputJson, '{}')
    assert.equal(a.inputPreview, 'pv')
    // 因为 usage 在,metaText/_rawMeta 仍被 strip(usage 在场即清,不分 _source)
    assert.equal(a.metaText, undefined)
    assert.equal(a._rawMeta, undefined)
    // 其余 server-authoritative 全保留
    assert.equal(a._source, 'server')
    assert.equal(a.status, 'completed')
    assert.deepEqual(a.usage, { costCredits: '500', inputTokens: 200, turn: 1 })
    // 派生
    assert.equal(_deriveUserMsgStatus(loaded.messages, 0), 'replied')
  })
})

// ═══════════════════════════════════════════════════════════════════
// T21 — costCredits 早到 / 晚到 / 跨进程持久
// ═══════════════════════════════════════════════════════════════════
//
// cost_charged broadcast 可能比 isFinal 帧早或晚到。setUsage 走浅 merge:
//   - 早到:先建 msg.usage.costCredits,后续 isFinal 字段并入,不覆盖 costCredits
//   - 晚到:先建 msg.usage.{inputTokens,...},后续 cost_charged 合入 costCredits
//   - 跨进程:刷新后 server-authored usage 持有最终值,client 不再补 cost_charged
describe('T21: costCredits 早到/晚到/跨进程持久 — usage 合并语义', () => {
  it('cost 早到(broadcast 在 isFinal 之前):isFinal 字段并入,不覆盖 costCredits', () => {
    const msg: any = { id: 'a', role: 'assistant' }
    setUsage(msg, { costCredits: '300' }) // broadcast first
    setUsage(msg, { inputTokens: 100, outputTokens: 50, turn: 2 }) // isFinal next
    assert.deepEqual(msg.usage, {
      costCredits: '300',
      inputTokens: 100,
      outputTokens: 50,
      turn: 2,
    })
    const meta = formatMeta(msg)
    assert.ok(meta.includes('¥3.00'), meta)
    assert.ok(meta.includes('in 100'), meta)
  })

  it('cost 晚到(isFinal 先,broadcast 后):cost 字段并入既有 usage', () => {
    const msg: any = { id: 'a', role: 'assistant' }
    setUsage(msg, { inputTokens: 100, outputTokens: 50, turn: 1 }) // isFinal first
    setUsage(msg, { costCredits: '12' }) // broadcast next (晚到)
    assert.deepEqual(msg.usage, {
      inputTokens: 100,
      outputTokens: 50,
      turn: 1,
      costCredits: '12',
    })
    const meta = formatMeta(msg)
    assert.ok(meta.includes('12 积分'), meta) // <100 分 → 积分
    assert.ok(meta.includes('in 100'), meta)
  })

  it('跨进程持久:刷新后从 IDB 加载 → usage 完整保留', () => {
    // 模拟 server 端持久化的 server-authored assistant
    const serverMsg = {
      id: 'srv-1',
      role: 'assistant',
      ts: 1000,
      text: 'reply',
      _source: 'server',
      _seq: 5,
      status: 'completed',
      usage: { costCredits: '850', inputTokens: 13178, outputTokens: 142, turn: 1 },
    }
    const sess = { id: 'sess-1', messages: [serverMsg] }
    const loaded = _normalizeLoadedSession(sess)
    assert.deepEqual(loaded.messages[0].usage, serverMsg.usage, 'usage 跨刷新完整保留')
    // 与本会话内 setUsage(msg, {...broadcast...}) 后的 formatMeta 输出一致
    const reloadMeta = formatMeta(loaded.messages[0])
    assert.ok(reloadMeta.includes('¥8.50'), reloadMeta)
    assert.ok(reloadMeta.includes('in 13178'), reloadMeta)
    assert.ok(reloadMeta.includes('T1'), reloadMeta)
  })

  it('双重累加防御(broadcast + GET 各自合入)— costCredits 是覆盖语义', () => {
    // 注意:setUsage 是 spread merge,后到的 costCredits 会覆盖前面的。
    // 但 server broadcast(分整数)和 server GET(同一权威源)的 costCredits 相等,
    // 所以"覆盖"语义 = "无副作用"。这里固化:晚到的同值覆盖不双倍计费。
    const msg: any = { id: 'a' }
    setUsage(msg, { costCredits: '850', inputTokens: 100 }) // broadcast
    setUsage(msg, { costCredits: '850', inputTokens: 100, _seq: 7, _source: 'server' as any }) // GET
    // costCredits 仍是 850,不是 1700
    assert.equal(msg.usage.costCredits, '850', 'costCredits 是覆盖,不会双倍累加')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 引用面 sanity:确认覆盖范围没遗漏
// ═══════════════════════════════════════════════════════════════════
describe('整链一致性 — sanity', () => {
  it('formatMeta 字段集对齐 spec(in/out/cache-r/T/credits)— 无 cost / cache-w / totalCost', () => {
    // 旧字段不能再被偷偷加回来 —— 走 v3 商用版后 cost 字段是 server costCredits 权威。
    const meta = formatMeta({
      usage: {
        costCredits: '500',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1024,
        // 这些字段即使 client 错传,formatMeta 不应渲染
        cost: 0.0123,
        totalCost: 1.23,
        cacheCreationTokens: 999,
        turn: 1,
      },
    })
    assert.ok(!meta.includes('$'), `不应有 $ 估算价:${meta}`)
    assert.ok(!meta.includes('cache-w'), `不应有 cache-w 字段:${meta}`)
    assert.ok(!meta.includes('999'), `不应渲染 cacheCreationTokens:${meta}`)
    assert.ok(meta.includes('¥5.00'), meta)
  })
})
