import * as assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chunkCoreMemoryDocuments,
  rankCoreMemorySemantically,
  selectSemanticFiles,
} from '../coreMemorySemantic.js'

test('semantic rank covers every chunk in transport batches without a total cap', async () => {
  const documents = Array.from({ length: 100 }, (_, index) => ({
    path: `/memory/${index}.md`,
    label: `Memory ${index}`,
    size: 20,
    content: `generic stored fact number ${index}`,
  }))
  const seen: string[] = []
  let calls = 0
  const result = await rankCoreMemorySemantically('recall a stored fact', documents, {
    baseUrl: 'http://master.internal',
    token: 'token',
    async postImpl(_url, _token, body) {
      calls++
      const parsed = JSON.parse(body)
      seen.push(...parsed.documents.map((document: any) => document.id))
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          ranked: parsed.documents.map((document: any) => ({
            id: document.id,
            score: document.id === '0' ? 0.91 : 0.7,
          })),
        }),
      }
    },
  })
  assert.equal(calls, 3)
  assert.equal(seen.length, 100)
  assert.equal(new Set(seen).size, 100)
  assert.equal(result?.[0]?.path, '/memory/0.md')
})

test('one failed semantic batch discards the whole pass', async () => {
  const documents = Array.from({ length: 60 }, (_, index) => ({
    path: `/memory/${index}.md`,
    label: `Memory ${index}`,
    size: 20,
    content: `stored content ${index}`,
  }))
  let calls = 0
  const result = await rankCoreMemorySemantically('stored fact', documents, {
    baseUrl: 'http://master.internal',
    token: 'token',
    async postImpl(_url, _token, body) {
      calls++
      const parsed = JSON.parse(body)
      if (calls === 2) return { statusCode: 503, body: '{}' }
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          ranked: parsed.documents.map((document: any) => ({
            id: document.id,
            score: 0.9,
          })),
        }),
      }
    },
  })
  assert.equal(calls, 2)
  assert.equal(result, null)
})

test('no-match margin is file-level and single-file English uses absolute floor', () => {
  const chunks = [
    {
      id: 'a',
      path: '/memory/style.md',
      start: 0,
      text: 'Concise answer preference.',
    },
    {
      id: 'b',
      path: '/memory/style.md',
      start: 300,
      text: 'Conclusion first.',
    },
    { id: 'c', path: '/memory/deploy.md', start: 0, text: 'Deployment note.' },
  ]
  const overlapAccepted = selectSemanticFiles('Use my usual writing style', chunks, [
    { id: 'a', score: 0.83 },
    { id: 'b', score: 0.829 },
    { id: 'c', score: 0.8 },
  ])
  assert.deepEqual(
    overlapAccepted.map((item) => item.path),
    ['/memory/style.md'],
  )

  const singleAccepted = selectSemanticFiles(
    'What am I allergic to?',
    [chunks[0]],
    [{ id: 'a', score: 0.82 }],
  )
  assert.deepEqual(
    singleAccepted.map((item) => item.path),
    ['/memory/style.md'],
  )

  const missing = selectSemanticFiles(
    'What is my home address?',
    [chunks[0]],
    [{ id: 'a', score: 0.8199 }],
  )
  assert.deepEqual(missing, [])
})

test('Chinese multi-file gate preserves strong matches but rejects ambiguous neighbors', () => {
  const chunks = [
    { id: 'a', path: '/memory/a.md', start: 0, text: '甲' },
    { id: 'b', path: '/memory/b.md', start: 0, text: '乙' },
    { id: 'c', path: '/memory/c.md', start: 0, text: '丙' },
  ]
  const ambiguous = selectSemanticFiles('评阅新的采购方案', chunks, [
    { id: 'a', score: 0.8708 },
    { id: 'b', score: 0.8648 },
    { id: 'c', score: 0.7 },
  ])
  assert.deepEqual(ambiguous, [])

  const strong = selectSemanticFiles('执行投资风控快照', chunks, [
    { id: 'a', score: 0.904 },
    { id: 'b', score: 0.897 },
    { id: 'c', score: 0.888 },
  ])
  assert.deepEqual(
    strong.map((item) => item.path),
    ['/memory/a.md', '/memory/b.md'],
  )

  const clearWinner = selectSemanticFiles('根据我的病史给建议', chunks, [
    { id: 'a', score: 0.875 },
    { id: 'b', score: 0.85 },
    { id: 'c', score: 0.84 },
  ])
  assert.deepEqual(
    clearWinner.map((item) => item.path),
    ['/memory/a.md'],
  )
})

test('chunker preserves full content with overlap and no document cap', () => {
  const content = `${'前段事实。'.repeat(80)}\n\n${'后段事实。'.repeat(80)}`
  const documents = Array.from({ length: 70 }, (_, index) => ({
    path: `/memory/${index}.md`,
    label: `记忆 ${index}`,
    size: Buffer.byteLength(content),
    content,
  }))
  const chunks = chunkCoreMemoryDocuments(documents)
  assert.ok(chunks.length > documents.length)
  assert.equal(new Set(chunks.map((chunk) => chunk.path)).size, documents.length)
  for (const document of documents) {
    const fileChunks = chunks.filter((chunk) => chunk.path === document.path)
    assert.equal(fileChunks[0].start, 0)
    assert.match(fileChunks.at(-1)?.text ?? '', /后段事实/)
  }
})
