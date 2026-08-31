/**
 * Run: npx tsx --test packages/gateway/src/__tests__/codexRelayPathGuard.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODEX_RELAY_PATH_DENIED_ABORT_AFTER,
  isCodexRelayPathDeniedLine,
  shouldAbortOnRelayPathDenied,
} from '../engine/codexRelayPathGuard.js'

describe('codexRelayPathGuard', () => {
  it('识别 rmcp PATH_NOT_ALLOWED stderr,忽略普通日志', () => {
    const denied =
      'rmcp::transport::worker: worker quit with fatal: UnexpectedServerResponse("HTTP 404: {\\"error\\":{\\"code\\":\\"PATH_NOT_ALLOWED\\",\\"message\\":\\"codex relay path not allowed\\"}}")'
    assert.equal(isCodexRelayPathDeniedLine(denied), true)
    assert.equal(isCodexRelayPathDeniedLine('codex app-server ready'), false)
    assert.equal(isCodexRelayPathDeniedLine('PATH_NOT_ALLOWED only'), false)
    assert.equal(isCodexRelayPathDeniedLine(''), false)
  })

  it('连续拒绝达到阈值才 abort', () => {
    assert.equal(shouldAbortOnRelayPathDenied(0), false)
    assert.equal(shouldAbortOnRelayPathDenied(CODEX_RELAY_PATH_DENIED_ABORT_AFTER - 1), false)
    assert.equal(shouldAbortOnRelayPathDenied(CODEX_RELAY_PATH_DENIED_ABORT_AFTER), true)
    assert.equal(shouldAbortOnRelayPathDenied(CODEX_RELAY_PATH_DENIED_ABORT_AFTER + 2), true)
  })
})
