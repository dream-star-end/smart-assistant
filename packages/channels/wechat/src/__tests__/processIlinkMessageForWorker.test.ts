/**
 * Tests for processIlinkMessageForWorker — the pure decoder extracted from
 * WechatWorker.loop's per-msg body.
 *
 * 不变量:
 *   1. from_user_id 形如 `<base64url>@im.wechat` → senderId 剥后缀
 *   2. from_user_id 已是 canonical → passthrough
 *   3. 缺 from_user_id 或 context_token → drop_no_sender_or_ctx (worker silent continue)
 *   4. 缺稳定 id (seq/message_id/client_id) → drop_no_id 但 contextToken 仍返回供 worker 更新缓存
 *      (原 loop 行为:即便 msg 因缺 id 被 drop,context_token 仍要落 cache + DB,
 *      否则未来 reply 这个 sender 的路径就没 token)
 *   5. text 从 item_list 提取(type=1 text_item.text / type=3 voice_item.text)
 *
 * Run: npx tsx --test packages/channels/wechat/src/__tests__/processIlinkMessageForWorker.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { processIlinkMessageForWorker } from '../worker.js'

describe('processIlinkMessageForWorker — happy path', () => {
  it('strips @im.wechat suffix from from_user_id', () => {
    const result = processIlinkMessageForWorker({
      from_user_id: 'o9cq803RaiYffHD5475dcduJaDgg@im.wechat',
      context_token: 'ctx-token-1',
      seq: 42,
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    })
    assert.equal(result.kind, 'ok')
    if (result.kind !== 'ok') throw new Error('typeguard')
    assert.equal(result.senderId, 'o9cq803RaiYffHD5475dcduJaDgg')
    assert.equal(result.contextToken, 'ctx-token-1')
    assert.equal(result.text, '你好')
    assert.equal(result.messageId, '42')
  })

  it('passthrough sender already in canonical form (idempotent)', () => {
    const result = processIlinkMessageForWorker({
      from_user_id: 'canonical-id-no-suffix',
      context_token: 'ctx',
      message_id: 'm-1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    assert.equal(result.kind, 'ok')
    if (result.kind !== 'ok') throw new Error('typeguard')
    assert.equal(result.senderId, 'canonical-id-no-suffix')
  })

  it('prefers seq over message_id over client_id', () => {
    const r1 = processIlinkMessageForWorker({
      from_user_id: 'abc',
      context_token: 'c',
      seq: 1,
      message_id: 'm',
      client_id: 'cid',
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(r1.kind, 'ok')
    if (r1.kind !== 'ok') throw new Error('typeguard')
    assert.equal(r1.messageId, '1')

    const r2 = processIlinkMessageForWorker({
      from_user_id: 'abc',
      context_token: 'c',
      message_id: 'm',
      client_id: 'cid',
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(r2.kind, 'ok')
    if (r2.kind !== 'ok') throw new Error('typeguard')
    assert.equal(r2.messageId, 'm')

    const r3 = processIlinkMessageForWorker({
      from_user_id: 'abc',
      context_token: 'c',
      client_id: 'cid',
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(r3.kind, 'ok')
    if (r3.kind !== 'ok') throw new Error('typeguard')
    assert.equal(r3.messageId, 'cid')
  })

  it('extracts voice_item.text when type=3', () => {
    const result = processIlinkMessageForWorker({
      from_user_id: 'abc@im.wechat',
      context_token: 'c',
      seq: 1,
      item_list: [{ type: 3, voice_item: { text: 'voice transcription' } }],
    })
    assert.equal(result.kind, 'ok')
    if (result.kind !== 'ok') throw new Error('typeguard')
    assert.equal(result.text, 'voice transcription')
  })
})

describe('processIlinkMessageForWorker — drop paths', () => {
  it('drop_no_sender_or_ctx when from_user_id missing', () => {
    const result = processIlinkMessageForWorker({
      context_token: 'ctx',
      seq: 1,
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(result.kind, 'drop_no_sender_or_ctx')
  })

  it('drop_no_sender_or_ctx when context_token missing', () => {
    const result = processIlinkMessageForWorker({
      from_user_id: 'abc@im.wechat',
      seq: 1,
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(result.kind, 'drop_no_sender_or_ctx')
  })

  it('drop_no_sender_or_ctx for a bare wire-form id that canonicalizes to empty', () => {
    // Edge: from_user_id === '@im.wechat' → canonicalSenderId 剥后变 ''
    // 触发 sender 空 → drop_no_sender_or_ctx,而不是产出空 senderId 的 ok。
    const result = processIlinkMessageForWorker({
      from_user_id: '@im.wechat',
      context_token: 'ctx',
      seq: 1,
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(result.kind, 'drop_no_sender_or_ctx')
  })

  it('drop_no_id when seq/message_id/client_id all missing — but contextToken returned', () => {
    // 关键不变量:即便 msg 因缺 id 被 drop,worker 仍要拿到 contextToken
    // 更新 in-memory cache + DB,否则未来 reply 这个 sender 就没 token。
    const result = processIlinkMessageForWorker({
      from_user_id: 'abc@im.wechat',
      context_token: 'still-need-this',
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(result.kind, 'drop_no_id')
    if (result.kind !== 'drop_no_id') throw new Error('typeguard')
    assert.equal(result.senderId, 'abc')
    assert.equal(result.contextToken, 'still-need-this')
  })

  it('drop_no_id when id source is empty string', () => {
    const result = processIlinkMessageForWorker({
      from_user_id: 'abc@im.wechat',
      context_token: 'ctx',
      seq: '   ',
      item_list: [{ type: 1, text_item: { text: 'x' } }],
    })
    assert.equal(result.kind, 'drop_no_id')
  })
})
