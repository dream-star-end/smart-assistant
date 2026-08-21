import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  configFromEnv,
  defaultEmbeddingBatchSize,
  isEmbeddingAvailable,
  resetEmbeddingProvider,
} from '../embedding.js'

const KEYS = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_API_KEY',
  'OPENAI_API_KEY',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_BATCH_SIZE',
  'EMBEDDING_TIMEOUT_MS',
] as const

const saved = new Map<string, string | undefined>()

function stashEnv(): void {
  for (const key of KEYS) saved.set(key, process.env[key])
}

function restoreEnv(): void {
  for (const key of KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetEmbeddingProvider()
}

describe('embedding env config', () => {
  stashEnv()
  afterEach(restoreEnv)

  it('defaults DashScope compatible-mode to batch size 10', () => {
    assert.equal(
      defaultEmbeddingBatchSize('https://dashscope.aliyuncs.com/compatible-mode/v1'),
      10,
    )
    assert.equal(defaultEmbeddingBatchSize('https://api.openai.com/v1'), 100)
  })

  it('configFromEnv reads batch and timeout and DashScope default', () => {
    delete process.env.EMBEDDING_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.EMBEDDING_BATCH_SIZE
    delete process.env.EMBEDDING_TIMEOUT_MS
    process.env.EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    process.env.EMBEDDING_MODEL = 'text-embedding-v4'
    process.env.EMBEDDING_DIMENSIONS = '1024'
    const cfg = configFromEnv()
    assert.equal(cfg.batchSize, 10)
    assert.equal(cfg.timeoutMs, 30_000)
    assert.equal(cfg.dimensions, 1024)
    assert.equal(cfg.model, 'text-embedding-v4')
    assert.equal(isEmbeddingAvailable(), false)
  })

  it('explicit EMBEDDING_BATCH_SIZE wins over DashScope default', () => {
    process.env.EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    process.env.EMBEDDING_BATCH_SIZE = '8'
    process.env.EMBEDDING_TIMEOUT_MS = '1200'
    process.env.EMBEDDING_API_KEY = 'sk-test'
    const cfg = configFromEnv()
    assert.equal(cfg.batchSize, 8)
    assert.equal(cfg.timeoutMs, 1200)
    assert.equal(isEmbeddingAvailable(), true)
  })

  it('invalid EMBEDDING_BATCH_SIZE makes the provider unavailable', () => {
    process.env.EMBEDDING_API_KEY = 'sk-test'
    process.env.EMBEDDING_BATCH_SIZE = '10abc'
    assert.equal(isEmbeddingAvailable(), false)
  })
})
