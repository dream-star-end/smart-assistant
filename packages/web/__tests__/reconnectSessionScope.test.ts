import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf8',
)
const GATEWAY_SRC = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'gateway', 'src', 'server.ts'),
  'utf8',
)

describe('session-scoped reconnect', () => {
  it('never emits the legacy restart explanation as assistant content', () => {
    assert.doesNotMatch(GATEWAY_SRC, /上一轮对话被服务重启中断/)
    const start = WS_SRC.indexOf("frame.meta?.interrupted === 'service_restart'")
    const end = WS_SRC.indexOf('// Early stale-final guard', start)
    const compatibilityBranch = WS_SRC.slice(start, end)
    assert.match(compatibilityBranch, /maybeSyncNow\(\{ force: true/)
    assert.match(compatibilityBranch, /return/)
    assert.doesNotMatch(compatibilityBranch, /addMessage|renderMessage/)
  })

  it('does not force-sync a background replay miss', () => {
    const start = WS_SRC.indexOf('function handleResumeFailed')
    const end = WS_SRC.indexOf('// ══', start)
    const fn = WS_SRC.slice(start, end)
    assert.match(fn, /affectedSessId !== state\.currentSessionId\) return/)
    assert.ok(
      fn.indexOf('affectedSessId !== state.currentSessionId) return') < fn.indexOf('maybeSyncNow'),
    )
  })

  it('does not bind another tab turn to this tab pending submit', () => {
    assert.match(WS_SRC, /frame\.clientMessageId !== sess\._inFlightClientMessageId/)
    assert.match(WS_SRC, /A different tab owns this live turn/)
  })
})
