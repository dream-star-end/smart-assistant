import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)
const MAIN = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'main.js'),
  'utf-8',
)
const SESSIONS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sessions.js'),
  'utf-8',
)
const SYNC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)
const COMMANDS = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'commands.js'),
  'utf-8',
)
const INDEX = readFileSync(resolve(import.meta.dirname, '..', 'public', 'index.html'), 'utf-8')
const SW = readFileSync(resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf-8')

describe('conversation turn lifetime', () => {
  it('never converts browser silence into an automatic stop', () => {
    assert.match(SRC, /function _resetThinkingSafety\(_sessId\) \{\}/)
    assert.doesNotMatch(SRC, /state\._thinkingSafetyTimer\s*=\s*setTimeout/)
    assert.doesNotMatch(SRC, /state\._reconnectInFlightTimer\s*=\s*setTimeout/)
  })

  it('renders a self-cancelled empty turn neutrally rather than as a failure', () => {
    // The gateway tags meta.interrupted='user' for an explicit Stop. Without
    // this branch, a stop with no output falls through to the generic notice
    // and tells the user "未收到回复 … 请重试" about their own cancellation.
    assert.match(SRC, /const userCancelled = frame\.meta\?\.interrupted === 'user'/)
    assert.match(SRC, /if \(userCancelled\) \{\s*\n\s*noticeText = '已取消本轮/)
    // Soft styling too, otherwise the notice still renders in the alarm style.
    assert.match(SRC, /_emptyTurnSoft: userCancelled \|\| priorTurnHadContent/)
  })

  it('does not force-complete a busy turn while draining offline messages', () => {
    assert.doesNotMatch(SRC, /state\._drainTimeout\s*=\s*setTimeout/)
    assert.match(SRC, /still busy after 60s, deferring/)
    assert.match(SRC, /if \(allBusy\) \{/)
  })

  it('accepts exact running and terminal reconciliation states after reconnect', () => {
    assert.match(
      SRC,
      /status === 'idle' \|\|\s+status === 'completed' \|\|\s+status === 'interrupted' \|\|\s+status === 'unknown'/,
    )
    assert.match(SRC, /if \(status !== 'idle'\) \{\s+sess\._needsFetch = true/)
    assert.match(SRC, /status !== 'idle' && sess\.id === state\.currentSessionId/)
    assert.match(SRC, /localClientMessageId !== frameClientMessageId/)
  })

  it('does not count authoritative running heartbeats as real progress', () => {
    const handler = SRC.slice(
      SRC.indexOf('function handleOutboundTurnStatus(frame)'),
      SRC.indexOf('function _ensureBlockIdMap(sess)'),
    )
    assert.doesNotMatch(handler, /markFrameReceived\(sess\)/)
    assert.doesNotMatch(handler, /仍在运行/)
    assert.match(handler, /heartbeats cannot hide a real stall/)
  })

  it('keeps terminal goal state visible while residual execution is still running', () => {
    assert.match(SRC, /msg\.completedAt < sess\._turnStartedAt/)
    assert.match(SRC, /msg\.status === 'complete'.*目标已完成/)
    assert.match(SRC, /目标已完成.*残留执行|terminalGoal.*残留执行/s)
    assert.match(SRC, /可点击停止/)
  })

  it('cache-busts the full circular dependency group changed by websocket', () => {
    assert.match(INDEX, /main\.js\?v=91/)
    assert.match(MAIN, /sync\.js\?v=15/)
    assert.match(MAIN, /sessions\.js\?v=15/)
    assert.match(MAIN, /commands\.js\?v=12/)
    assert.match(SESSIONS, /sync\.js\?v=15/)
    assert.match(SESSIONS, /websocket\.js\?v=59/)
    assert.match(SYNC, /sessions\.js\?v=15/)
    assert.match(COMMANDS, /websocket\.js\?v=59/)
    assert.match(SRC, /sync\.js\?v=15/)
    assert.match(SW, /main\.js\?v=91/)
    assert.match(SW, /sessions\.js\?v=15/)
    assert.match(SW, /sync\.js\?v=15/)
    assert.match(SW, /commands\.js\?v=12/)
    assert.match(SW, /websocket\.js\?v=59/)
  })
})
