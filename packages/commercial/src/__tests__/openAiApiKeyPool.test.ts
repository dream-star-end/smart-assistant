import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { skillEmbeddingConfigFromEnv } from '@openclaude/storage'
import { API_KEY_SERVICE_RE, apiKeyHint, apiKeyPoolShouldQuery, installApiKeyPoolSnapshotForTests, resetApiKeyPoolSnapshotForTests } from '../account-pool/apiKeyPool.js'
import { buildCoreMemoryEmbeddingContainerEnv } from '../agent-sandbox/coreMemoryEmbeddingEnv.js'
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

  test('disabled and cooling pool members do not fall back to OPENAI_API_KEY', async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-env-valid-1234'
    const explicitEnv = {
      OPENAI_API_KEY: 'sk-env-valid-1234',
      DASHSCOPE_API_KEY: 'dash-key',
    }
    resetOpenAiPlatformKeyCacheForTests()
    installApiKeyPoolSnapshotForTests([
      { id: 'openai-disabled', service: 'openai', status: 'disabled' },
      {
        id: 'openai-cooling',
        service: 'openai',
        status: 'active',
        cooldownUntil: new Date(Date.now() + 60 * 60 * 1000),
      },
      { id: 'openai-cooldown-status', service: 'openai', status: 'cooldown' },
    ])
    try {
      const key = await selectOpenAiPlatformKey('embedding-pool-disabled')
      assert.equal(key, null)
      const skill = skillEmbeddingConfigFromEnv(explicitEnv, { openAiApiKey: key })
      assert.equal(skill.model, 'text-embedding-v4')
      assert.equal(skill.apiKey, 'dash-key')
      const container = buildCoreMemoryEmbeddingContainerEnv(explicitEnv, { openAiApiKey: key })
      assert.equal(container.some((value) => value.startsWith('EMBEDDING_API_KEY=sk-')), false)
      assert.equal(container.includes('EMBEDDING_MODEL=text-embedding-3-large'), false)
      assert.ok(container.includes('EMBEDDING_BATCH_SIZE=10'))
    } finally {
      resetOpenAiPlatformKeyCacheForTests()
      resetApiKeyPoolSnapshotForTests()
      process.env.OPENAI_API_KEY = prev ?? ''
    }
  })
})
