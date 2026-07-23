import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { readQqBotConfig } from '../qqbot/config.js'
import { splitQqText } from '../qqbot/outbox.js'
import { generateBindCode, normalizeBindCode } from '../qqbot/store.js'

describe('QQ Bot pure contracts', () => {
  test('binding code has 50 bits of alphabet entropy and normalizes display separators', () => {
    const code = generateBindCode(() => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))
    assert.equal(code, '23456789AB')
    assert.equal(normalizeBindCode('23-45 6789ab'), code)
  })

  test('text splitting is lossless and never breaks a surrogate pair', () => {
    const text = `甲${'😀'.repeat(9)}乙`
    const chunks = splitQqText(text, 3)
    assert.equal(chunks.join(''), text)
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 3))
  })

  test('configuration is inert when absent and fails loud when partial', () => {
    assert.equal(readQqBotConfig({}), null)
    assert.throws(() => readQqBotConfig({ QQBOT_APP_ID: 'app' }), /configuration is partial/)
    assert.deepEqual(
      readQqBotConfig({
        QQBOT_APP_ID: 'app_1',
        QQBOT_APP_SECRET: 's'.repeat(32),
        QQBOT_ENTRY_URL: 'https://qun.qq.com/qqweb/qunpro/share',
        QQBOT_BINDING_HMAC_SECRET: 'h'.repeat(32),
      }),
      {
        appId: 'app_1',
        appSecret: 's'.repeat(32),
        entryUrl: 'https://qun.qq.com/qqweb/qunpro/share',
        bindingHmacSecret: 'h'.repeat(32),
      },
    )
  })
})
