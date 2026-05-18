/**
 * Wave 1 — WebSocket message-correctness fix:
 *   onopen drain status pill 中间态修复。
 *
 * 问题:onopen 时如果 offlineQueue 非空,旧代码立刻 setStatus('已连接'),
 * 但 drain 实际要 3s 后才启动,启动后还要逐条等 isFinal。中间窗口期
 * status 显示"已连接"误导用户(同 sess 新消息仍走 queue 排尾)。
 *
 * 修法:抽出
 *   - `_onopenSetInitialStatus(offlineQueueLen)`:纯函数,onopen 替换硬编码
 *   - `_maybePromoteToConnected()`:5 条 predicate 真终态判定,4 个收口点调用
 *     (nudgeDrain else / _drainNextOfflineItem 入口空 / 120s timeout else /
 *      handleOutbound isFinal)
 *
 * 本测试覆盖:
 *   1. _onopenSetInitialStatus pure-fn 决策表
 *   2. _maybePromoteToConnected predicate 表(关键回归:_offlineDrainingCurrent
 *      非空时不能 promote)
 *   3. 接线回归:nudgeDrain else 和 _drainNextOfflineItem 入口 queue 空确实
 *      会调到 helper
 *
 * Run: npx tsx --test packages/web/__tests__/wsDrainPromoteStatus.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

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

// ───────────────────────────────────────────────────────────────────────
// 1. _onopenSetInitialStatus — pure function decision table
// ───────────────────────────────────────────────────────────────────────
const _setInitialSrc = extractTopLevelFn(WS_SRC, '_onopenSetInitialStatus')
const _onopenSetInitialStatus = new Function(
  `${_setInitialSrc}; return _onopenSetInitialStatus;`,
)() as (offlineQueueLen: number) => [string, string]

describe('_onopenSetInitialStatus — onopen status decision', () => {
  it('offlineQueue empty → 已连接 / connected', () => {
    assert.deepEqual(_onopenSetInitialStatus(0), ['已连接', 'connected'])
  })
  it('offlineQueue.length === 5 → 补发离线消息… (5) / connecting', () => {
    assert.deepEqual(_onopenSetInitialStatus(5), ['补发离线消息… (5)', 'connecting'])
  })
  it('offlineQueue.length === 1 (boundary) → connecting state', () => {
    const [lbl, cls] = _onopenSetInitialStatus(1)
    assert.equal(cls, 'connecting')
    assert.match(lbl, /1/)
  })
})

// ───────────────────────────────────────────────────────────────────────
// 2. _maybePromoteToConnected — predicate table
// ───────────────────────────────────────────────────────────────────────
// 通过 new Function 把 `state` 和 `setStatus` 作为参数注入闭包,这样 helper
// 内部对它们的引用会绑到我们的 mock。
const _promoteSrc = extractTopLevelFn(WS_SRC, '_maybePromoteToConnected')

function makePromoteHelper(mockState: any, mockSetStatus: (l: string, c: string) => void) {
  return new Function(
    'state',
    'setStatus',
    `${_promoteSrc}; return _maybePromoteToConnected;`,
  )(mockState, mockSetStatus)
}

interface SetStatusCall { label: string; klass: string }

function makeSetStatusMock(): { fn: (l: string, c: string) => void; calls: SetStatusCall[] } {
  const calls: SetStatusCall[] = []
  return { calls, fn: (label, klass) => { calls.push({ label, klass }) } }
}

describe('_maybePromoteToConnected — predicate (5 conditions)', () => {
  it('all conditions met → setStatus("已连接","connected")', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: false,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(mock.calls[0], { label: '已连接', klass: 'connected' })
  })

  it('ws.readyState === 3 (CLOSED) → no promote (onclose owns status)', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 3 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: false,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0)
  })

  it('state.ws === null → no promote', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: null,
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: false,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0)
  })

  it('offlineQueue non-empty → no promote (drain not started)', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [{ sessId: 's1', msgId: 'm1' }],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: false,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0)
  })

  it('_offlineQueuePending non-empty → no promote (drain mid-flight)', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [{ sessId: 's1', msgId: 'm1' }],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: true,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0)
  })

  // ── KEY REGRESSION: 最后一条 payload 已 send 但 isFinal 未到 ──
  // 这就是为什么不能在 L745 promote 的原因。L745 处 _offlineQueuePending 已空但
  // _offlineDrainingCurrent 还在等 isFinal。Codex Round 2 specifically flagged
  // this as the must-have regression guard.
  it('REGRESSION: last payload sent but _offlineDrainingCurrent != null → NO promote', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: { sessId: 's1', msgId: 'm-last', payload: {} },
      _offlineQueueDraining: true,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0,
      'must NOT promote while waiting for isFinal — L745 trap')
  })

  it('_offlineQueueDraining flag true alone → no promote', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: true,
    }
    makePromoteHelper(state, mock.fn)()
    assert.equal(mock.calls.length, 0)
  })
})

// ───────────────────────────────────────────────────────────────────────
// 3. 接线回归 — helper 真的被 nudgeDrain 和 _drainNextOfflineItem 调到
// ───────────────────────────────────────────────────────────────────────
// 把 _maybePromoteToConnected + nudgeDrain + _drainNextOfflineItem 一起塞进
// 同一个闭包,这样 nudgeDrain/_drainNextOfflineItem 调 _maybePromoteToConnected
// 时能命中 mock 而非真模块引用。
const _nudgeSrc = extractTopLevelFn(WS_SRC, 'nudgeDrain')
const _drainSrc = extractTopLevelFn(WS_SRC, '_drainNextOfflineItem')
const _timeoutSrc = extractTopLevelFn(WS_SRC, '_handleDrainTimeout')

function makeWiringHelpers(mockState: any, mockSetStatus: (l: string, c: string) => void) {
  // _drainNextOfflineItem 内部用到 setTimeout / safeWsSend / updateMsgStatus /
  // showTypingIndicator / setTitleBusy / updateSendEnabled / _resetTurnBillingState /
  // _resetThinkingSafety / _drainGeneration 等;我们只测"queue 空入口"那条
  // 早 return 路径,所以那些依赖都不会被命中。但 _drainGeneration 在函数体
  // 顶 const gen = _drainGeneration 会读 — 给个 0 占位。
  //
  // _handleDrainTimeout 内部还会调 clearTurnTiming / resetReplyTracker / 几个
  // UI helper — else 分支 stub 为 noop 即可,因为 timeout-else 测试只关注
  // helper 接到 _maybePromoteToConnected 这一行有没有跑到。
  return new Function(
    'state',
    'setStatus',
    `
    let _drainGeneration = 0;
    function setTimeout(..._args) { /* stub for nudgeDrain branch test */ }
    function clearTimeout(..._args) { /* stub */ }
    function clearTurnTiming(..._args) { /* stub */ }
    function resetReplyTracker(..._args) { /* stub */ }
    function updateSendEnabled(..._args) { /* stub */ }
    function hideTypingIndicator(..._args) { /* stub */ }
    function setTitleBusy(..._args) { /* stub */ }
    ${_promoteSrc}
    ${_nudgeSrc}
    ${_drainSrc}
    ${_timeoutSrc}
    return { _maybePromoteToConnected, nudgeDrain, _drainNextOfflineItem, _handleDrainTimeout };
    `,
  )(mockState, mockSetStatus) as {
    nudgeDrain: () => void
    _drainNextOfflineItem: () => void
    _handleDrainTimeout: (item: any) => void
  }
}

describe('wiring regression — helper called at the right collapse points', () => {
  it('nudgeDrain else (_offlineDrainingCurrent=null + _offlineQueuePending=[]) → promote', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: null,
      _offlineQueueDraining: true,  // before nudgeDrain
      _drainTimeout: null,
    }
    const helpers = makeWiringHelpers(state, mock.fn)
    helpers.nudgeDrain()
    assert.equal(state._offlineQueueDraining, false,
      'nudgeDrain else 把 draining flag 置 false')
    assert.equal(mock.calls.length, 1,
      'nudgeDrain else 必须调 _maybePromoteToConnected → setStatus')
    assert.deepEqual(mock.calls[0], { label: '已连接', klass: 'connected' })
  })

  it('nudgeDrain with _offlineDrainingCurrent active → early return, NO promote', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: { sessId: 's1', msgId: 'm-busy' },
      _offlineQueueDraining: true,
      _drainTimeout: null,
    }
    const helpers = makeWiringHelpers(state, mock.fn)
    helpers.nudgeDrain()
    assert.equal(mock.calls.length, 0,
      'active drain in flight → nudgeDrain returns early, no premature promote')
  })

  it('_drainNextOfflineItem entry with empty queue → promote (drain naturally exhausted)', () => {
    const mock = makeSetStatusMock()
    const state = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: { sessId: 'leftover' },  // helper sets this to null
      _offlineQueueDraining: true,                       // helper sets this to false
    }
    const helpers = makeWiringHelpers(state, mock.fn)
    helpers._drainNextOfflineItem()
    assert.equal(state._offlineQueueDraining, false)
    assert.equal(state._offlineDrainingCurrent, null)
    assert.equal(mock.calls.length, 1,
      '_drainNextOfflineItem queue-empty entry must call _maybePromoteToConnected')
    assert.deepEqual(mock.calls[0], { label: '已连接', klass: 'connected' })
  })

  // ── 120s safety timeout else 分支接线回归(Codex Round 2 要求) ──
  // _handleDrainTimeout(item) 被设计为可挖出的 named helper(替代原 inline arrow),
  // 这样测试能直接调它、断言"_offlineQueuePending=[] && _offlineDrainingCurrent===item
  // 时 timeout 内部走 else 分支并 promote"。
  it('_handleDrainTimeout last-item-abandoned (pending empty) → promote', () => {
    const mock = makeSetStatusMock()
    const item = { sessId: 's1', msgId: 'm-stuck' }
    const state: any = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: item,
      _offlineQueueDraining: true,
      sessions: new Map(),     // no entry for s1 — skips stuckSess branch cleanly
      currentSessionId: null,
      sendingInFlight: false,
    }
    const helpers = makeWiringHelpers(state, mock.fn)
    helpers._handleDrainTimeout(item)
    assert.equal(state._offlineDrainingCurrent, null)
    assert.equal(state._offlineQueueDraining, false)
    assert.equal(mock.calls.length, 1,
      '_handleDrainTimeout else 必须接 _maybePromoteToConnected')
    assert.deepEqual(mock.calls[0], { label: '已连接', klass: 'connected' })
  })

  it('_handleDrainTimeout no-op when current item changed (raced past) → NO promote', () => {
    const mock = makeSetStatusMock()
    const armedItem = { sessId: 's1', msgId: 'm-armed' }
    const newItem = { sessId: 's2', msgId: 'm-new' }
    const state: any = {
      ws: { readyState: 1 },
      offlineQueue: [],
      _offlineQueuePending: [],
      _offlineDrainingCurrent: newItem,  // already moved on
      _offlineQueueDraining: true,
      sessions: new Map(),
      currentSessionId: null,
    }
    const helpers = makeWiringHelpers(state, mock.fn)
    helpers._handleDrainTimeout(armedItem)
    assert.equal(mock.calls.length, 0,
      'timeout race-past guard → must not promote, else 风险:误清后续 item 的状态')
  })

  // Note: "_handleDrainTimeout with pending non-empty" 路径的"不 promote"语义
  // 由 predicate 测试 "_offlineQueuePending non-empty" + "_offlineDrainingCurrent
  // non-null"两 case 联合覆盖;那条路径会递归回 _drainNextOfflineItem 的 send
  // 路径,需要 stub safeWsSend 等大量依赖,代价不值。
})
