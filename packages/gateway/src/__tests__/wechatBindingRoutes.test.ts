/**
 * Static regression tests for `/api/wechat/binding` gateway glue.
 *
 * Runtime route tests would require constructing a full Gateway with config,
 * channel factories and commercial hooks. Here we only lock the thin glue
 * contract that previously regressed:
 *   - duplicate-account pairing errors must surface as a stable 409 code;
 *   - unbind must also ask the commercial broker to clean PG pointer/outbox.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/wechatBindingRoutes.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = readFileSync(join(__dirname, '..', 'server.ts'), 'utf-8')

function extractMethodBody(source: string, methodName: string): string {
  const startRe = new RegExp(`^  (private|public|protected)?\\s*(async\\s+)?${methodName}\\b`, 'm')
  const startMatch = startRe.exec(source)
  if (!startMatch) throw new Error(`method ${methodName} not found`)
  const startIdx = startMatch.index
  const rest = source.slice(startIdx + startMatch[0].length)
  const nextMatch = /^  (private|public|protected|async|static)\b/m.exec(rest)
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : source.length
  return source.slice(startIdx, endIdx)
}

const handleWechat = extractMethodBody(SERVER_TS, '_handleWechat')

test('_handleWechat maps duplicate-account pairing to WECHAT_ACCOUNT_ALREADY_BOUND 409', () => {
  assert.match(handleWechat, /WechatAccountAlreadyBoundError/)
  assert.match(handleWechat, /sendJson\(\s*res\s*,\s*409\s*,/)
  assert.match(handleWechat, /WECHAT_ACCOUNT_ALREADY_BOUND/)
})

test('DELETE /api/wechat/binding invokes commercial broker cleanup after sqlite delete', () => {
  const idxDelete = handleWechat.indexOf('await deleteWechatBinding(userId)')
  const idxCleanup = handleWechat.indexOf('wechatBroker?.cleanupBinding?.(userId)')
  assert.ok(idxDelete >= 0, 'sqlite binding delete must remain present')
  assert.ok(idxCleanup >= 0, 'commercial broker cleanup hook must be called')
  assert.ok(idxDelete < idxCleanup, 'user-facing sqlite unbind should not be blocked by cleanup ordering')
})
