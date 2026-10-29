/**
 * V3 commercial — supervisor core-memory embedding env tests.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/v3SupervisorCoreMemoryEmbeddingEnv.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildCoreMemoryEmbeddingContainerEnv } from '../agent-sandbox/coreMemoryEmbeddingEnv.js'

const PINNED = ['EMBEDDING_BATCH_SIZE=10', 'OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1']

describe('buildCoreMemoryEmbeddingContainerEnv', () => {
  test('always pins batch size and local-semantic gate, even with empty master env', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv({})
    assert.deepEqual(out, PINNED)
    assert.equal(out.some((v) => v.includes('undefined')), false)
  })

  test('forwards present embedding keys and skips missing ones', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv({
      EMBEDDING_PROVIDER: 'dashscope',
      EMBEDDING_MODEL: 'text-embedding-v4',
      EMBEDDING_DIMENSIONS: '1024',
      EMBEDDING_BASE_URL: 'https://example.invalid/v1',
    })
    assert.ok(out.includes('EMBEDDING_PROVIDER=dashscope'))
    assert.ok(out.includes('EMBEDDING_MODEL=text-embedding-v4'))
    assert.ok(out.includes('EMBEDDING_DIMENSIONS=1024'))
    assert.ok(out.includes('EMBEDDING_BASE_URL=https://example.invalid/v1'))
    assert.equal(out.some((v) => v.startsWith('EMBEDDING_API_KEY=')), false)
    assert.ok(out.includes('EMBEDDING_BATCH_SIZE=10'))
    assert.ok(out.includes('OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1'))
  })

  test('forwards EMBEDDING_API_KEY from source env and never injects blank or undefined', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv({
      EMBEDDING_API_KEY: 'test-not-a-real-secret',
      EMBEDDING_PROVIDER: '  ',
    })
    assert.ok(out.includes('EMBEDDING_API_KEY=test-not-a-real-secret'))
    assert.equal(out.some((v) => v.startsWith('EMBEDDING_PROVIDER=')), false)
    assert.equal(out.some((v) => v.startsWith('EMBEDDING_MODEL=')), false)
    assert.equal(out.some((v) => v.includes('undefined')), false)
    assert.equal(out.some((v) => v.endsWith('=')), false)
  })

  test('without an openai key the DashScope batch pin still wins over EMBEDDING_BATCH_SIZE', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv({ EMBEDDING_BATCH_SIZE: '100' })
    assert.deepEqual(
      out.filter((v) => v.startsWith('EMBEDDING_BATCH_SIZE=')),
      ['EMBEDDING_BATCH_SIZE=10'],
    )
  })

  test('openai key switches to text-embedding-3-large at 1024 and lifts the batch cap', () => {
    const key = 'sk-test-openai-key-9876'
    const out = buildCoreMemoryEmbeddingContainerEnv(
      {
        EMBEDDING_PROVIDER: 'dashscope',
        EMBEDDING_MODEL: 'text-embedding-v4',
        EMBEDDING_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        EMBEDDING_API_KEY: 'dashscope-should-not-forward',
      },
      { openAiApiKey: key },
    )
    assert.deepEqual(out, [
      'EMBEDDING_PROVIDER=openai',
      'EMBEDDING_MODEL=text-embedding-3-large',
      'EMBEDDING_DIMENSIONS=1024',
      'EMBEDDING_BASE_URL=https://api.openai.com/v1',
      `EMBEDDING_API_KEY=${key}`,
      'EMBEDDING_BATCH_SIZE=100',
      'OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC=1',
    ])
    assert.equal(out.some((v) => v.includes('dashscope-should-not-forward')), false)
    assert.equal(out.filter((v) => v.includes(key)).length, 1)
  })

  test('blank openai key keeps the historical pin', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv(
      { EMBEDDING_MODEL: 'text-embedding-v4' },
      { openAiApiKey: '   ' },
    )
    assert.ok(out.includes('EMBEDDING_MODEL=text-embedding-v4'))
    assert.ok(out.includes('EMBEDDING_BATCH_SIZE=10'))
    assert.equal(out.some((v) => v.startsWith('EMBEDDING_API_KEY=')), false)
  })

  test('OPENAI_API_KEY in the source env switches and is not copied through as itself', () => {
    const out = buildCoreMemoryEmbeddingContainerEnv({ OPENAI_API_KEY: 'sk-env-openai-key-4321' })
    assert.ok(out.includes('EMBEDDING_MODEL=text-embedding-3-large'))
    assert.ok(out.includes('EMBEDDING_DIMENSIONS=1024'))
    assert.ok(out.includes('EMBEDDING_API_KEY=sk-env-openai-key-4321'))
    assert.ok(out.includes('EMBEDDING_BATCH_SIZE=100'))
    assert.equal(out.some((v) => v.startsWith('OPENAI_API_KEY=')), false)
  })
})
