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
})
