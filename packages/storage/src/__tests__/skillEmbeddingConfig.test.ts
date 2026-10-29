import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  getSkillEmbeddingProvider,
  resetSkillEmbeddingProvider,
  skillEmbeddingConfigFromEnv,
} from '../skillEmbedding.js'

const KEYS = [
  'SKILL_EMBEDDING_MODEL',
  'SKILL_EMBEDDING_BASE_URL',
  'SKILL_EMBEDDING_API_KEY',
  'SKILL_EMBEDDING_DIMENSIONS',
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
] as const

const saved = new Map<string, string | undefined>()

function stash(): void {
  for (const key of KEYS) saved.set(key, process.env[key])
}

function restore(): void {
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('skillEmbeddingConfigFromEnv', () => {
  stash()
  afterEach(restore)

  it('keeps DashScope text-embedding-v4 and batch 10 when no OpenAI key is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-process-env-must-not-leak-into-explicit-env'
    const cfg = skillEmbeddingConfigFromEnv({
      DASHSCOPE_API_KEY: 'dash-key',
    })
    assert.equal(cfg.model, 'text-embedding-v4')
    assert.equal(cfg.dimensions, 1024)
    assert.equal(cfg.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    assert.equal(cfg.apiKey, 'dash-key')
    assert.equal(cfg.batchSize, 10)
  })

  it('uses the base URL batch default instead of a hardcoded 10', () => {
    const cfg = skillEmbeddingConfigFromEnv({
      SKILL_EMBEDDING_BASE_URL: 'https://api.openai.com/v1',
      SKILL_EMBEDDING_API_KEY: 'sk-explicit',
    })
    assert.equal(cfg.model, 'text-embedding-v4')
    assert.equal(cfg.batchSize, 100)
    assert.equal(cfg.apiKey, 'sk-explicit')
  })

  it('switches to text-embedding-3-large at 1024 when an OpenAI key is passed', () => {
    const cfg = skillEmbeddingConfigFromEnv(
      { DASHSCOPE_API_KEY: 'dash-key' },
      { openAiApiKey: 'sk-pool-openai-key-1111' },
    )
    assert.equal(cfg.model, 'text-embedding-3-large')
    assert.equal(cfg.dimensions, 1024)
    assert.equal(cfg.baseUrl, 'https://api.openai.com/v1')
    assert.equal(cfg.apiKey, 'sk-pool-openai-key-1111')
    assert.equal(cfg.batchSize, 100)
    assert.equal(String(cfg.apiKey).includes('dash-key'), false)
  })

  it('reads OPENAI_API_KEY from process.env when no config object is passed', () => {
    for (const key of ['SKILL_EMBEDDING_MODEL', 'SKILL_EMBEDDING_BASE_URL', 'SKILL_EMBEDDING_API_KEY']) {
      delete process.env[key]
    }
    process.env.OPENAI_API_KEY = 'sk-env-openai-key-4321'
    const cfg = skillEmbeddingConfigFromEnv()
    assert.equal(cfg.model, 'text-embedding-3-large')
    assert.equal(cfg.dimensions, 1024)
    assert.equal(cfg.apiKey, 'sk-env-openai-key-4321')
    assert.equal(cfg.batchSize, 100)
  })

  it('keeps an explicit skill-embedding pin even when an OpenAI key exists', () => {
    const cfg = skillEmbeddingConfigFromEnv({
      OPENAI_API_KEY: 'sk-env-openai-key-4321',
      SKILL_EMBEDDING_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      DASHSCOPE_API_KEY: 'dash-key',
    })
    assert.equal(cfg.model, 'text-embedding-v4')
    assert.equal(cfg.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
    assert.equal(cfg.apiKey, 'dash-key')
    assert.equal(cfg.batchSize, 10)
  })

  it('ignores a blank OpenAI key', () => {
    const cfg = skillEmbeddingConfigFromEnv(
      { DASHSCOPE_API_KEY: 'dash-key' },
      { openAiApiKey: '  \n' },
    )
    assert.equal(cfg.model, 'text-embedding-v4')
    assert.equal(cfg.apiKey, 'dash-key')
    assert.equal(cfg.batchSize, 10)
  })

  it('rebuilds the provider when the model changes and reuses it for the same config', () => {
    resetSkillEmbeddingProvider()
    const dash = getSkillEmbeddingProvider(
      skillEmbeddingConfigFromEnv({ DASHSCOPE_API_KEY: 'dash-key' }),
    )
    assert.equal(dash.modelId, 'text-embedding-v4')
    const switched = getSkillEmbeddingProvider(
      skillEmbeddingConfigFromEnv({}, { openAiApiKey: 'sk-pool-openai-key-1111' }),
    )
    assert.equal(switched.modelId, 'text-embedding-3-large')
    assert.equal(switched.dimensions, 1024)
    assert.notEqual(switched, dash)
    const again = getSkillEmbeddingProvider(
      skillEmbeddingConfigFromEnv({}, { openAiApiKey: 'sk-pool-openai-key-1111' }),
    )
    assert.equal(again, switched)
    resetSkillEmbeddingProvider()
  })
})
