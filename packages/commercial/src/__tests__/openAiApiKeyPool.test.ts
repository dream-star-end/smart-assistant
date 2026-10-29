import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { API_KEY_SERVICE_RE, apiKeyHint, apiKeyPoolShouldQuery } from '../account-pool/apiKeyPool.js'
import { resetOpenAiPlatformKeyCacheForTests, selectOpenAiPlatformKey } from '../openai/openAiPlatformKey.js'
import { apiKeyServices } from '../http/admin/pools.js'

describe('openai api key pool', () => {
  test('apiKeyServices accepts openai exactly once', () => {
    const services = apiKeyServices()
    assert.equal(services.filter((service) => service === 'openai').length, 1)
    assert.equal(API_KEY_SERVICE_RE.test('openai'), true)
  })

  test('hint shows only the last 4 characters', () => {
    const secret = 'sk-test-pool-key-9876'
    const hint = apiKeyHint(secret)
    assert.equal(hint, '\u20269876')
    assert.equal(hint.includes('sk-test'), false)
    assert.equal(hint.includes(secret), false)
    assert.equal(apiKeyHint('short'), '')
  })

  test('unprimed pool does not query and does not read a missing env key', async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = ''
    resetOpenAiPlatformKeyCacheForTests()
    assert.equal(apiKeyPoolShouldQuery('openai'), false)
    const started = Date.now()
    const key = await selectOpenAiPlatformKey()
    assert.equal(key, null)
    assert.ok(Date.now() - started < 1000)
    process.env.OPENAI_API_KEY = prev ?? ''
  })
})
