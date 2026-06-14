/**
 * WS auth-control errors must not be rendered as assistant chat bubbles.
 *
 * `/ws/user-chat-bridge` sends `{type:"error", code:"UNAUTHORIZED"}` right
 * before close(1008) when the browser used an expired access JWT for the WS
 * handshake. `ws.onclose` already performs silentRefresh() + reconnect; this
 * test protects the pre-close frame from leaking as a red chat message.
 *
 * Run: npx tsx --test packages/web/__tests__/wsAuthControlError.test.ts
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

const normalizeSrc = extractTopLevelFn(WS_SRC, '_normalizeBridgeErrorCode')
const authControlSrc = extractTopLevelFn(WS_SRC, '_isBridgeAuthControlError')
const handleLegacySrc = extractTopLevelFn(WS_SRC, 'handleLegacyBridgeError')

const _isBridgeAuthControlError = new Function(
  `${normalizeSrc}; ${authControlSrc}; return _isBridgeAuthControlError;`,
)() as (code: unknown) => boolean

function makeHandleLegacyBridgeError(sess: any) {
  const calls: {
    added: Array<{ role: string; text: string; extra: any }>
    finished: any[]
    toasts: Array<{ text: string; kind: string }>
  } = { added: [], finished: [], toasts: [] }
  const state = {
    currentSessionId: sess.id,
    sessions: new Map([[sess.id, sess]]),
  }
  const handleLegacyBridgeError = new Function(
    'state',
    'getSession',
    '_friendlyBridgeErrorMessage',
    'addMessage',
    '_finishErroredTurn',
    'toast',
    'updateSendEnabled',
    'showTypingIndicator',
    'setTitleBusy',
    'refreshBalance',
    `
      ${normalizeSrc}
      ${authControlSrc}
      ${handleLegacySrc}
      return handleLegacyBridgeError;
    `,
  )(
    state,
    () => sess,
    (code: unknown, message: unknown) => String(message || `friendly:${code}`),
    (_sess: any, role: string, text: string, extra: any) => {
      calls.added.push({ role, text, extra })
    },
    (_sess: any) => {
      calls.finished.push(_sess)
    },
    (text: string, kind: string) => {
      calls.toasts.push({ text, kind })
    },
    () => {},
    () => {},
    () => {},
    () => {},
  ) as (frame: any) => void
  return { handleLegacyBridgeError, calls }
}

describe('websocket legacy bridge auth-control errors', () => {
  it('recognizes only the bridge auth error code', () => {
    assert.equal(_isBridgeAuthControlError('UNAUTHORIZED'), true)
    assert.equal(_isBridgeAuthControlError(' unauthorized '), true)
    assert.equal(_isBridgeAuthControlError('UNAUTHORIZED_MODEL'), false)
    assert.equal(_isBridgeAuthControlError('CODEX_ROUTE_UNAVAILABLE'), false)
    assert.equal(_isBridgeAuthControlError(''), false)
  })

  it('suppresses UNAUTHORIZED before it can become a chat message', () => {
    const sess = {
      id: 's1',
      _sendingInFlight: true,
      messages: [{ role: 'user', status: 'sent', text: 'hello' }],
    }
    const { handleLegacyBridgeError, calls } = makeHandleLegacyBridgeError(sess)

    handleLegacyBridgeError({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'invalid or expired token',
    })

    assert.deepEqual(calls.added, [])
    assert.deepEqual(calls.finished, [])
    assert.deepEqual(calls.toasts, [])
    assert.equal(sess.messages[0].status, 'sent')
  })

  it('keeps non-auth legacy errors on the existing visible error path', () => {
    const sess = {
      id: 's1',
      _sendingInFlight: true,
      messages: [{ role: 'user', status: 'sent', text: 'hello' }],
    }
    const { handleLegacyBridgeError, calls } = makeHandleLegacyBridgeError(sess)

    handleLegacyBridgeError({
      type: 'error',
      code: 'CODEX_ROUTE_UNAVAILABLE',
      message: 'route unavailable',
    })

    assert.equal(calls.added.length, 1)
    assert.equal(calls.added[0].role, 'assistant')
    assert.equal(calls.added[0].text, 'route unavailable')
    assert.equal(calls.added[0].extra._errorCode, 'codex_route_unavailable')
    assert.equal(calls.finished.length, 1)
  })
})
