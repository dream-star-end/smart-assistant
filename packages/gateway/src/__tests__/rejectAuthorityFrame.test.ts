/**
 * OCV5-746 — 容器侧模型权威拒帧必须回一张能绑定到本轮的错误帧。
 *
 * 只回 `{type:'error',code:'MODEL_AUTHORITY_REJECTED'}`(无 peer / clientMessageId)时,
 * master 无法把失败收敛到具体 dispatch,浏览器也会把无主 error 帧丢弃 —— 这一轮永远"运行中"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { _rejectAuthority } from '../turnDispatch.js'

test('authority rejection frame carries the turn identity (peer / clientMessageId / model)', () => {
  const sent: string[] = []
  const warnings: unknown[] = []
  const host = { log: { warn: (...args: unknown[]) => warnings.push(args) } }
  const ws = { send: (raw: string) => sent.push(raw) }

  _rejectAuthority.call(
    host as never,
    ws as never,
    'billing_request_mismatch',
    'engine-reported authority billingRequestId does not match frame.requestId',
    {
      type: 'inbound.message',
      channel: 'webchat',
      peer: { id: 'p1', kind: 'dm' },
      clientMessageId: 'cm-1',
      model: 'gpt-6-luna-remote',
    },
  )

  assert.equal(sent.length, 1)
  const frame = JSON.parse(sent[0]!) as Record<string, unknown>
  assert.equal(frame.type, 'error')
  assert.equal(frame.code, 'MODEL_AUTHORITY_REJECTED')
  assert.deepEqual(frame.peer, { id: 'p1', kind: 'dm' })
  assert.equal(frame.clientMessageId, 'cm-1')
  assert.equal(frame.model, 'gpt-6-luna-remote')
  // 内部线索(epoch / challenge / keyId)不进帧。
  assert.equal(JSON.stringify(frame).includes('epoch'), false)
  // 用户可见文案由 catalog 提供(model_authority_rejected)。
  assert.equal((frame.userError as { code?: string } | undefined)?.code, 'model_authority_rejected')
  assert.equal(warnings.length, 1, 'reason stays in the log for ops')
})

test('authority rejection without a turn identity stays a bare error frame', () => {
  const sent: string[] = []
  const host = { log: { warn: () => {} } }
  _rejectAuthority.call(host as never, { send: (raw: string) => sent.push(raw) } as never, 'missing', 'no envelope')
  const frame = JSON.parse(sent[0]!) as Record<string, unknown>
  assert.equal(frame.code, 'MODEL_AUTHORITY_REJECTED')
  assert.equal(frame.peer, undefined)
  assert.equal(frame.clientMessageId, undefined)
})
