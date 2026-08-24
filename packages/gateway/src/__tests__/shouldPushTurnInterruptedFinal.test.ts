/**
 * `_shouldPushTurnInterruptedFinal` unit tests(autoResumeFromHello 合成终态帧判据)。
 *
 * 历史:Plan 1(turn-alive-heartbeat)把判据从进程级 `runner.isRunning` 升级为
 * engine turn 计数 `_activeTurnCount`,堵 submit 内 subprocess respawn 窗口误推。
 *
 * team-durability(2026-07-07)再升级:去掉 isRunning 参与(warm runner 架构下
 * codex app-server / warm CCB runner 在 turn 之间常驻,isRunning 恒 true,导致
 * "turn 已正常结束、客户端错过终态帧"的会话永远等不到对账 —— 团队模式事故里
 * 客户端重连 6 次都没被救回),并加入 client turn 计数 `_activeClientTurnCount`
 * (覆盖 engine turn 结束后 gateway 还在跑 hidden-reviewer 硬编排的窗口)。
 *
 * 新决策表(helper jsdoc 同步):
 * | peerInFlight | engineTurnCount | clientTurnCount | result |
 * | false        | *               | *               | false  |
 * | true         | > 0             | *               | false  |
 * | true         | *               | > 0             | false  |
 * | true         | 0/undefined     | 0/undefined     | true   |
 *
 * Repository convention: import from `../server.js` (TS source resolves via
 * tsx). See `deliverStripAndConnTrace.test.ts` for the same pattern.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_TURN_REPLAY_CANDIDATE_MAX,
  _matchActiveTurnReplayCandidate,
  _shouldInterruptUnknownInFlight,
  _shouldPushTurnInterruptedFinal,
} from '../server.js'

// ── core matrix from the helper jsdoc decision table ──

test('peer not in-flight → false (nothing stuck to clear)', () => {
  // Even with both counters at 0, if the peer itself is not marked in-flight
  // there is no stuck client state to release.
  assert.equal(_shouldPushTurnInterruptedFinal(false, 0, 0), false)
  // undefined peer.inFlight should be treated as not-in-flight too.
  assert.equal(_shouldPushTurnInterruptedFinal(undefined, 0, 0), false)
})

test('peer in-flight + engine turn in flight → false', () => {
  // submit() promise pending — covers phantom-turn / auth-refresh / effort+
  // model swap respawn windows (all inside submit try/finally).
  assert.equal(_shouldPushTurnInterruptedFinal(true, 1, 0), false)
  // Defensive: counter > 1 (queued submit waiting on prev) should also block.
  assert.equal(_shouldPushTurnInterruptedFinal(true, 2, 0), false)
})

test('peer in-flight + client turn orchestration in flight → false', () => {
  // 团队模式核心窗口:engine turn 已结束(engine counter 0)但 gateway 还在跑
  // hidden-reviewer review pass / continuation。此时 hello 重连绝不能推终态帧
  // (turn 还活着,后续帧会继续流)。
  assert.equal(_shouldPushTurnInterruptedFinal(true, 0, 1), false)
  // Both alive (initial submit inside client-turn scope) — still false.
  assert.equal(_shouldPushTurnInterruptedFinal(true, 1, 1), false)
})

test('peer in-flight + both counters 0 → true (push reconcile/interrupted isFinal)', () => {
  // "turn 已终结、客户端悬空"的对账路径。warm runner(isRunning=true)不再
  // 挡住这条路 —— 这正是 2026-07-07 事故修的洞。
  assert.equal(_shouldPushTurnInterruptedFinal(true, 0, 0), true)
})

// ── compatibility: counter fields missing ──

test('undefined counters → treated as 0', () => {
  // Historical session objects, test fakes, or sessions created in code paths
  // that bypass submit()/dispatchInbound won't have the fields set. Treating
  // undefined as 0 preserves the reconcile push for those cases. Also a
  // future-proofing guard: if a refactor drops the `?? 0` fallback, this
  // test catches it.
  assert.equal(
    _shouldPushTurnInterruptedFinal(true, undefined, undefined),
    true,
    'both undefined + peer in-flight → push (matches counters=0)',
  )
  assert.equal(
    _shouldPushTurnInterruptedFinal(true, 1, undefined),
    false,
    'engine turn alive → no push regardless of missing client counter',
  )
  assert.equal(
    _shouldPushTurnInterruptedFinal(true, undefined, 1),
    false,
    'client turn alive → no push regardless of missing engine counter',
  )
  assert.equal(
    _shouldPushTurnInterruptedFinal(false, undefined, undefined),
    false,
    'peer not in-flight → still no push',
  )
})

// ── defensive: stale negative counter values ──

test('negative counters → treated as 0 (defense against double-finally)', () => {
  // Math.max(0, n - 1) in sessionManager already guards the producer side,
  // but defense-in-depth: negative values must read as "no active turn"
  // rather than "turn alive" (which would silently suppress legitimate
  // reconcile pushes).
  assert.equal(_shouldPushTurnInterruptedFinal(true, -1, -1), true)
})

test('active-turn replay candidates authorize only an exact bounded server-owned id', () => {
  assert.equal(
    _matchActiveTurnReplayCandidate('m-user-1', ['m-queued-2', 'm-user-1']),
    'm-user-1',
  )
  assert.equal(_matchActiveTurnReplayCandidate('m-user-1', ['m-user-2']), undefined)
  assert.equal(_matchActiveTurnReplayCandidate(undefined, ['m-user-1']), undefined)
  assert.equal(_matchActiveTurnReplayCandidate('bad id', ['bad id']), undefined)
  assert.equal(
    _matchActiveTurnReplayCandidate(
      'm-user-1',
      Array.from({ length: ACTIVE_TURN_REPLAY_CANDIDATE_MAX + 1 }, () => 'm-user-1'),
    ),
    undefined,
    'oversized client hints degrade to ordinary cursor replay',
  )
})

test('unknown in-flight is interrupted when this process is not running that cmid', () => {
  assert.equal(
    _shouldInterruptUnknownInFlight({
      runningClientMessageId: undefined,
      inFlightClientMessageId: 'm-recover-1',
      engineTurnCount: 0,
      clientTurnCount: 0,
    }),
    true,
    'restart / dead recover: counters 0 and no running id',
  )
  assert.equal(
    _shouldInterruptUnknownInFlight({
      runningClientMessageId: 'm-other',
      inFlightClientMessageId: 'm-recover-1',
      engineTurnCount: 1,
      clientTurnCount: 1,
    }),
    true,
    'stale inFlight while a later turn is running',
  )
})

test('unknown in-flight stays unknown during dispatchInbound-before-submit', () => {
  assert.equal(
    _shouldInterruptUnknownInFlight({
      runningClientMessageId: undefined,
      inFlightClientMessageId: 'm-user-1',
      engineTurnCount: 1,
      clientTurnCount: 0,
    }),
    false,
  )
  assert.equal(
    _shouldInterruptUnknownInFlight({
      runningClientMessageId: undefined,
      admittingClientMessageId: 'm-user-1',
      inFlightClientMessageId: 'm-user-1',
      engineTurnCount: 0,
      clientTurnCount: 0,
    }),
    false,
    'real pre-submit window: counters still 0, admitting id is bound',
  )
  assert.equal(
    _shouldInterruptUnknownInFlight({
      runningClientMessageId: 'm-user-1',
      inFlightClientMessageId: 'm-user-1',
      engineTurnCount: 1,
      clientTurnCount: 1,
    }),
    false,
  )
})
