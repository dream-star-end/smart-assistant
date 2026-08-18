import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_LOCAL_TIMEOUT_MS,
  LLM_RERANK_ENV,
  LOCAL_SEMANTIC_ENV,
  LOCAL_TIMEOUT_ENV,
  localSemanticTimeoutMs,
  MAX_LOCAL_TIMEOUT_MS,
  MIN_LOCAL_TIMEOUT_MS,
  rankCoreMemoryLocally,
  selectLocalSemanticFiles,
} from '../coreMemoryLocalSemantic.js'
import {
  type CoreMemoryDocument,
  rankCoreMemorySemantically,
} from '../coreMemorySemantic.js'

function docs(): CoreMemoryDocument[] {
  return [
    {
      path: '/memory/semantic.md',
      label: '语义召回上线',
      size: 40,
      content: '通用语义 Core 记忆召回已上线，同义查询可以命中。',
    },
    {
      path: '/memory/ocr.md',
      label: 'OCR 验证',
      size: 40,
      content: 'PaddleOCR-VL 在 SCNet BW 上跑通了 PP-OCRv6。',
    },
  ]
}

function orthogonalEmbed(texts: string[]): Float32Array[] {
  return texts.map((text) => {
    const semantic = /记忆|语义|召回|检索/.test(text)
    return semantic ? new Float32Array([1, 0]) : new Float32Array([0, 1])
  })
}

test('no master and no local opt-in returns null even if EMBEDDING_API_KEY is set', async () => {
  const previousFlag = process.env[LOCAL_SEMANTIC_ENV]
  const previousKey = process.env.EMBEDDING_API_KEY
  process.env.EMBEDDING_API_KEY = 'sk-test-not-used'
  delete process.env[LOCAL_SEMANTIC_ENV]
  delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  try {
    const result = await rankCoreMemorySemantically('记忆功能', docs())
    assert.equal(result, null)
  } finally {
    if (previousFlag === undefined) delete process.env[LOCAL_SEMANTIC_ENV]
    else process.env[LOCAL_SEMANTIC_ENV] = previousFlag
    if (previousKey === undefined) delete process.env.EMBEDDING_API_KEY
    else process.env.EMBEDDING_API_KEY = previousKey
  }
})

test('local embedding admits a synonym winner that lexical terms do not share', async () => {
  const result = await rankCoreMemorySemantically('记忆功能', docs(), {
    localEmbed: async (texts) => orthogonalEmbed(texts),
  })
  assert.equal(result?.length, 1)
  assert.equal(result?.[0]?.path, '/memory/semantic.md')
  assert.ok((result?.[0]?.score ?? 0) >= 0.99)
})

test('master relay wins over local embedding and never calls it', async () => {
  let localCalls = 0
  const result = await rankCoreMemorySemantically('记忆功能', docs(), {
    baseUrl: 'http://master.internal',
    token: 'token',
    async postImpl(_url, _token, body) {
      const parsed = JSON.parse(body)
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          ranked: parsed.documents.map((document: { id: string }) => ({
            id: document.id,
            score: document.id === '0' ? 0.91 : 0.7,
          })),
        }),
      }
    },
    async localEmbed(texts) {
      localCalls++
      return orthogonalEmbed(texts)
    },
  })
  assert.equal(localCalls, 0)
  assert.equal(result?.[0]?.path, '/memory/semantic.md')
})

test('local embed timeout degrades to null without throwing', async () => {
  const result = await rankCoreMemorySemantically('记忆功能', docs(), {
    timeoutMs: 40,
    localEmbed: () => new Promise(() => {}),
  })
  assert.equal(result, null)
})

test('local semantic timeout default and env clamp to the cold-TLS budget', () => {
  const previous = process.env[LOCAL_TIMEOUT_ENV]
  delete process.env[LOCAL_TIMEOUT_ENV]
  try {
    assert.equal(DEFAULT_LOCAL_TIMEOUT_MS, 3_800)
    assert.equal(MAX_LOCAL_TIMEOUT_MS, 5_000)
    assert.equal(MIN_LOCAL_TIMEOUT_MS, 200)
    assert.equal(localSemanticTimeoutMs(), 3_800)
    assert.equal(localSemanticTimeoutMs(40), 200)
    assert.equal(localSemanticTimeoutMs(10_000), 5_000)
    process.env[LOCAL_TIMEOUT_ENV] = '99999'
    assert.equal(localSemanticTimeoutMs(), 5_000)
    process.env[LOCAL_TIMEOUT_ENV] = '100'
    assert.equal(localSemanticTimeoutMs(), 200)
    process.env[LOCAL_TIMEOUT_ENV] = '4200'
    assert.equal(localSemanticTimeoutMs(), 4_200)
    process.env[LOCAL_TIMEOUT_ENV] = '3800'
    assert.equal(localSemanticTimeoutMs(), 3_800)
    process.env[LOCAL_TIMEOUT_ENV] = 'not-a-number'
    assert.equal(localSemanticTimeoutMs(), 3_800)
  } finally {
    if (previous === undefined) delete process.env[LOCAL_TIMEOUT_ENV]
    else process.env[LOCAL_TIMEOUT_ENV] = previous
  }
})

test('local embed throw degrades to null', async () => {
  const result = await rankCoreMemorySemantically('记忆功能', docs(), {
    localEmbed: async () => {
      throw new Error('upstream 500')
    },
  })
  assert.equal(result, null)
})

test('LLM rerank path is used when embedding is not opted in', async () => {
  const result = await rankCoreMemoryLocally('记忆功能', docs(), {
    async localLlmRerank() {
      return [
        { id: '0', score: 0.88 },
        { id: '1', score: 0.12 },
      ]
    },
  })
  assert.equal(result?.length, 1)
  assert.equal(result?.[0]?.path, '/memory/semantic.md')
})

test('LLM rerank flag without explicit config stays off', async () => {
  const previous = {
    flag: process.env[LLM_RERANK_ENV],
    base: process.env.OPENCLAUDE_CORE_MEMORY_LLM_BASE_URL,
    model: process.env.OPENCLAUDE_CORE_MEMORY_LLM_MODEL,
    key: process.env.OPENCLAUDE_CORE_MEMORY_LLM_API_KEY,
  }
  process.env[LLM_RERANK_ENV] = '1'
  delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_BASE_URL
  delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_MODEL
  delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_API_KEY
  try {
    const result = await rankCoreMemoryLocally('记忆功能', docs())
    assert.equal(result, null)
  } finally {
    if (previous.flag === undefined) delete process.env[LLM_RERANK_ENV]
    else process.env[LLM_RERANK_ENV] = previous.flag
    if (previous.base === undefined) delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_BASE_URL
    else process.env.OPENCLAUDE_CORE_MEMORY_LLM_BASE_URL = previous.base
    if (previous.model === undefined) delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_MODEL
    else process.env.OPENCLAUDE_CORE_MEMORY_LLM_MODEL = previous.model
    if (previous.key === undefined) delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_API_KEY
    else process.env.OPENCLAUDE_CORE_MEMORY_LLM_API_KEY = previous.key
  }
})

test('selectLocalSemanticFiles uses cosine-scale floors, not the q8 0.82 gate', () => {
  const chunks = [
    { id: 'a', path: '/memory/a.md', start: 0, text: '语义召回' },
    { id: 'b', path: '/memory/b.md', start: 0, text: 'OCR' },
    { id: 'c', path: '/memory/c.md', start: 0, text: '教程' },
  ]
  const winner = selectLocalSemanticFiles('记忆功能', chunks, [
    { id: 'a', score: 0.365 },
    { id: 'b', score: 0.311 },
    { id: 'c', score: 0.295 },
  ])
  assert.deepEqual(
    winner.map((file) => file.path),
    ['/memory/a.md'],
  )

  const clustered = selectLocalSemanticFiles('模型繁忙', chunks, [
    { id: 'a', score: 0.358 },
    { id: 'b', score: 0.347 },
    { id: 'c', score: 0.337 },
  ])
  assert.deepEqual(clustered, [])

  const belowFloor = selectLocalSemanticFiles('记忆功能', chunks, [
    { id: 'a', score: 0.33 },
    { id: 'b', score: 0.10 },
    { id: 'c', score: 0.09 },
  ])
  assert.deepEqual(belowFloor, [])
})
