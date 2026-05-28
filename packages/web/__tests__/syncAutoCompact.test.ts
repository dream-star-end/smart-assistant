/**
 * Unit tests for sync.js automatic oversized-session compaction helpers.
 *
 * Uses source-extract + new Function() to avoid importing browser modules.
 * Run: npx tsx --test packages/web/__tests__/syncAutoCompact.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

const helpers = new Function(
  `const PREFLIGHT_MAX_BYTES = 1.9 * 1024 * 1024;
   const AUTO_COMPACT_TARGET_BYTES = 1.45 * 1024 * 1024;
   const DATA_URI_RE = /^data:[^,;]+(?:;[^,;]+)*;base64,/;
   const DATA_URI_MIN_STRIP_CHARS = 4 * 1024;
   ${extractTopLevelFn(SYNC_SRC, '_jsonBytes')}
   ${extractTopLevelFn(SYNC_SRC, '_deepCloneJson')}
   ${extractTopLevelFn(SYNC_SRC, '_deepStripInlineBase64ForSync')}
   ${extractTopLevelFn(SYNC_SRC, '_stripMediaArrayForSync')}
   ${extractTopLevelFn(SYNC_SRC, '_messageSortKey')}
   ${extractTopLevelFn(SYNC_SRC, '_buildCompactedMessageList')}
   ${extractTopLevelFn(SYNC_SRC, '_autoCompactMessagesForSync')}
   return { _autoCompactMessagesForSync };`,
)() as {
  _autoCompactMessagesForSync: (messages: any[], opts?: any) => null | {
    messages: any[]
    finalBytes: number
    mediaStripped: number
    inlineBase64Stripped: number
    droppedCount: number
    truncated: boolean
  }
}

const compact = helpers._autoCompactMessagesForSync

describe('_autoCompactMessagesForSync', () => {
  it('strips heavy _media payloads and inline data URIs without dropping messages when enough', () => {
    const big = 'a'.repeat(5000)
    const result = compact([
      {
        id: 'u1',
        role: 'user',
        text: 'see image',
        ts: 1,
        _media: [{ kind: 'image', mimeType: 'image/png', filename: 'a.png', base64: big }],
        childBlocks: [{ dataUrl: `data:image/png;base64,${big}` }],
      },
    ], { maxBytes: 3000, targetBytes: 2500, now: 123, sessionId: 's1' })

    assert.ok(result)
    assert.equal(result.droppedCount, 0)
    assert.equal(result.mediaStripped, 1)
    assert.equal(result.inlineBase64Stripped, 1)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0]._media[0].base64, undefined)
    assert.equal(result.messages[0]._media[0].base64Stripped, true)
    assert.match(result.messages[0].childBlocks[0].dataUrl, /^\[stripped:base64/)
  })

  it('drops oldest client-authored rows and keeps newest rows under the hard cap', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `${i}:` + 'x'.repeat(900),
      ts: 1000 + i,
    }))
    const result = compact(messages, { maxBytes: 3600, targetBytes: 2400, now: 999, sessionId: 's2' })

    assert.ok(result)
    assert.equal(result.truncated, true)
    assert.ok(result.droppedCount > 0)
    assert.ok(result.finalBytes <= 3600)
    const ids = result.messages.map((m: any) => m.id)
    assert.ok(ids.includes('m9'), 'newest message should be kept')
    assert.equal(ids.includes('m0'), false, 'oldest message should be dropped')
    assert.ok(result.messages.some((m: any) => m.role === 'system' && /自动上下文压缩/.test(m.text)))
  })

  it('preserves server-authored rows byte-for-byte while truncating client rows', () => {
    const serverData = 'data:image/png;base64,' + 's'.repeat(5000)
    const serverMedia = 'm'.repeat(2000)
    const messages = [
      {
        id: 'srv1',
        role: 'assistant',
        text: 'server',
        ts: 1,
        _source: 'server',
        _seq: 1,
        _media: [{ kind: 'image', base64: serverMedia }],
        childBlocks: [{ dataUrl: serverData }],
      },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, role: 'user', text: 'x'.repeat(800), ts: 10 + i })),
    ]
    const result = compact(messages, { maxBytes: 13_000, targetBytes: 10_000, now: 999, sessionId: 's3' })

    assert.ok(result)
    const server = result.messages.find((m: any) => m.id === 'srv1' && m._source === 'server')
    assert.ok(server)
    assert.equal(server._media[0].base64, serverMedia)
    assert.equal(server.childBlocks[0].dataUrl, serverData)
    assert.ok(result.droppedCount > 0)
    assert.ok(result.finalBytes <= 13_000)
  })

  it('returns null when server-authored rows alone exceed the hard cap', () => {
    const result = compact([
      { id: 'srv1', role: 'assistant', text: 's'.repeat(5000), ts: 1, _source: 'server', _seq: 1 },
    ], { maxBytes: 1000, targetBytes: 800, now: 999, sessionId: 's4' })

    assert.equal(result, null)
  })
})
