/**
 * Run: npx tsx --test packages/gateway/src/__tests__/codexRelayPathGuard.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODEX_RELAY_PATH_DENIED_ABORT_AFTER,
  CodexRelayPathDeniedTracker,
  isCodexRelayPathDeniedLine,
  shouldAbortOnRelayPathDenied,
} from '../engine/codexRelayPathGuard.js'

const DENIED =
  'rmcp::transport::worker: worker quit with fatal: UnexpectedServerResponse("HTTP 404: {\\"error\\":{\\"code\\":\\"PATH_NOT_ALLOWED\\",\\"message\\":\\"codex relay path not allowed\\"}}")'

describe('codexRelayPathGuard', () => {
  it('识别 rmcp PATH_NOT_ALLOWED stderr,忽略普通日志', () => {
    assert.equal(isCodexRelayPathDeniedLine(DENIED), true)
    assert.equal(isCodexRelayPathDeniedLine('codex app-server ready'), false)
    assert.equal(isCodexRelayPathDeniedLine('PATH_NOT_ALLOWED only'), false)
    assert.equal(isCodexRelayPathDeniedLine(''), false)
  })

  it('连续拒绝达到阈值才 abort', () => {
    assert.equal(shouldAbortOnRelayPathDenied(0), false)
    assert.equal(shouldAbortOnRelayPathDenied(CODEX_RELAY_PATH_DENIED_ABORT_AFTER - 1), false)
    assert.equal(shouldAbortOnRelayPathDenied(CODEX_RELAY_PATH_DENIED_ABORT_AFTER), true)
  })

  it('拆包必须拼成完整行才判定,合包按行计数', () => {
    const tracker = new CodexRelayPathDeniedTracker(true)
    const line = `${DENIED}\n`
    const mid = line.indexOf('PATH_NOT_ALLOWED') + 'PATH_NOT_'.length
    const first = tracker.consume(line.slice(0, mid))
    assert.equal(first.deniedLines, 0)
    assert.equal(first.activityLines, 0)
    assert.equal(first.abort, false)
    const second = tracker.consume(line.slice(mid))
    assert.equal(second.deniedLines, 1)
    assert.equal(second.activityLines, 0)
    const packed = tracker.consume(`${DENIED}\n${DENIED}\n`)
    assert.equal(packed.deniedLines, 2)
    assert.equal(packed.abort, true)
  })

  it('普通日志清零连续拒绝;非阶段会话永不 abort', () => {
    const stage = new CodexRelayPathDeniedTracker(true)
    assert.equal(stage.consume(`${DENIED}\n`).consecutiveDenied, 1)
    assert.equal(stage.consume('codex app-server ready\n').consecutiveDenied, 0)
    assert.equal(stage.consume(`${DENIED}\n`).consecutiveDenied, 1)
    assert.equal(stage.consume(`${DENIED}\n`).abort, false)

    const webchat = new CodexRelayPathDeniedTracker(false)
    const burst = webchat.consume(`${DENIED}\n${DENIED}\n${DENIED}\n`)
    assert.equal(burst.deniedLines, 3)
    assert.equal(burst.abort, false)
  })
})
