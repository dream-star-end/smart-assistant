/**
 * Tests for canonicalSenderId / toIlinkUserId — the wire/canonical boundary
 * converters for WeChat (iLink) senderIds.
 *
 * 不变量:
 *   1. canonicalSenderId 剥 `@im.wechat` 后缀,其他后缀(如 `@im.bot`)不动
 *   2. canonicalSenderId 对已是 canonical 的输入幂等(passthrough)
 *   3. toIlinkUserId 加 `@im.wechat` 后缀,对已是 wire 形态的输入幂等
 *   4. 空串两端均返回空串(不拼后缀)
 *   5. canonical(toIlink(x)) === x 且 toIlink(canonical(y)) === y 当 y 是 wire 形态
 *
 * Run: npx tsx --test packages/channels/wechat/src/__tests__/canonicalSenderId.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalSenderId, toIlinkUserId } from '../canonicalSenderId.js'

describe('canonicalSenderId — wire → canonical', () => {
  it('strips @im.wechat suffix', () => {
    assert.equal(
      canonicalSenderId('o9cq803RaiYffHD5475dcduJaDgg@im.wechat'),
      'o9cq803RaiYffHD5475dcduJaDgg',
    )
  })

  it('passthrough when already canonical (no suffix)', () => {
    assert.equal(canonicalSenderId('o9cq803RaiYffHD5475dcduJaDgg'), 'o9cq803RaiYffHD5475dcduJaDgg')
  })

  it('does not touch @im.bot suffix (only @im.wechat is in scope)', () => {
    // @im.bot 是 bot 自己的 accountId,不属于 senderId 语义,本函数不动它。
    // 上游 SENDER_ID_RE 拒不拒是上游的事。
    assert.equal(canonicalSenderId('77fb1ebc7237@im.bot'), '77fb1ebc7237@im.bot')
  })

  it('does not strip arbitrary other suffixes', () => {
    assert.equal(canonicalSenderId('abc@im.group'), 'abc@im.group')
    assert.equal(canonicalSenderId('abc@example.com'), 'abc@example.com')
  })

  it('empty string returns empty', () => {
    assert.equal(canonicalSenderId(''), '')
  })

  it('idempotent', () => {
    const wire = 'xKv7Q-test_id@im.wechat'
    const canon = canonicalSenderId(wire)
    assert.equal(canonicalSenderId(canon), canon)
  })
})

describe('toIlinkUserId — canonical → wire', () => {
  it('appends @im.wechat suffix', () => {
    assert.equal(
      toIlinkUserId('o9cq803RaiYffHD5475dcduJaDgg'),
      'o9cq803RaiYffHD5475dcduJaDgg@im.wechat',
    )
  })

  it('idempotent when already wire form', () => {
    assert.equal(toIlinkUserId('abc@im.wechat'), 'abc@im.wechat')
  })

  it('empty string returns empty (does NOT produce bare @im.wechat)', () => {
    assert.equal(toIlinkUserId(''), '')
  })
})

describe('canonicalSenderId ↔ toIlinkUserId — round trip', () => {
  it('canonical(toIlink(x)) === x for canonical input', () => {
    const canon = 'xKv7Q-test_id'
    assert.equal(canonicalSenderId(toIlinkUserId(canon)), canon)
  })

  it('toIlink(canonical(y)) === y for wire input', () => {
    const wire = 'xKv7Q-test_id@im.wechat'
    assert.equal(toIlinkUserId(canonicalSenderId(wire)), wire)
  })
})
