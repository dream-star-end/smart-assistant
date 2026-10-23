import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, type UUID } from 'node:crypto'
import { loadFullLog, loadTranscriptFile, clearSessionMessagesCache, resetProjectForTesting } from '../sessionStorage.js'
import { flushSessionFileIo } from '../sessionFileIo.js'
import type { LogOption } from '../../types/logs.js'

const sid = '60700000-0000-4000-8000-000000001000'
const id = (n: number): UUID => `60700000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stamp = (n: number): string => new Date(Date.UTC(2026, 9, 24, 0, 0, n)).toISOString()
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
let directory: string
let file: string
let saved: Record<string, string | undefined>
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'g607-reader-'))
  saved = Object.fromEntries(['CLAUDE_CONFIG_DIR', 'OPENCLAUDE_TRANSCRIPT_INTEGRITY', 'CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP'].map(key => [key, process.env[key]]))
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'
  Reflect.deleteProperty(process.env, 'CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP')
  await mkdir(join(directory, 'projects', 'fixture'), { recursive: true, mode: 0o700 })
  file = join(directory, 'projects', 'fixture', `${sid}.jsonl`)
  clearSessionMessagesCache(); resetProjectForTesting()
})
afterEach(async () => {
  await flushSessionFileIo()
  clearSessionMessagesCache(); resetProjectForTesting()
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(directory, { recursive: true, force: true })
})
function message(n: number, parent: string | null, type: 'user' | 'assistant', content: unknown, sidechain = false, group?: string): any {
  return { parentUuid: parent, isSidechain: sidechain, type, message: { role: type, ...(type === 'assistant' ? { id: group ?? `m-${n}` } : {}), content }, uuid: id(n), timestamp: stamp(n), cwd: '/synthetic', sessionId: sid, version: 'fixture', userType: 'external' }
}
async function write(entries: unknown[]): Promise<void> { await writeFile(file, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 }) }
async function both(): Promise<{ full: LogOption; optimized: LogOption }> {
  const log = { sessionId: sid, fullPath: file, messages: [], modified: new Date(0), created: new Date(0), firstPrompt: 'fixture', messageCount: 0 } as unknown as LogOption
  process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP = '1'
  const full = await loadFullLog(log)
  Reflect.deleteProperty(process.env, 'CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP')
  const optimized = await loadFullLog(log)
  if (hash(full.messages) !== hash(optimized.messages)) throw new Error('G607_READER_MODEL_CONTEXT_MISMATCH')
  expect(hash(optimized)).toBe(hash(full))
  return { full, optimized }
}
for (const sidechain of [false, true]) {
  test(`parallel assistant parts and tool-result siblings survive the large-file filter (sidechain=${sidechain})`, async () => {
    const entries = [
      message(1, null, 'user', 'synthetic prompt', sidechain),
      message(2, id(1), 'assistant', [{ type: 'thinking', thinking: 'preserved thought', signature: 'opaque-signature-one' }], sidechain, 'parallel-model-message'),
      message(3, id(1), 'assistant', [{ type: 'redacted_thinking', data: 'opaque-redacted-data' }], sidechain, 'parallel-model-message'),
      message(4, id(1), 'assistant', [{ type: 'text', text: 'preserved text' }, { type: 'tool_use', id: 'read-a', name: 'Read', input: { file_path: '/synthetic/a.png' } }], sidechain, 'parallel-model-message'),
      message(5, id(1), 'assistant', [{ type: 'tool_use', id: 'read-b', name: 'Read', input: { file_path: '/synthetic/b.png' } }], sidechain, 'parallel-model-message'),
      message(6, id(4), 'user', [{ type: 'tool_result', tool_use_id: 'read-a', content: [{ type: 'image', source: { type: 'base64', data: image, media_type: 'image/png' } }] }], sidechain),
      message(7, id(5), 'user', [{ type: 'tool_result', tool_use_id: 'read-b', content: [{ type: 'image', source: { type: 'base64', data: image, media_type: 'image/png' } }] }], sidechain),
      // A large, valid dead branch makes the optimization's benefit gate real.
      message(0, null, 'assistant', `dead-branch-${'x'.repeat(6 * 1024 * 1024)}`, sidechain),
      message(8, id(6), 'user', 'continue with both images', sidechain),
      { type: 'custom-title', sessionId: sid, customTitle: 'synthetic title' },
    ]
    await write(entries)
    if (sidechain) {
      // Agent callers anchor a UA leaf even when there is no foreground root.
      process.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP = '1'
      const full = await loadTranscriptFile(file, { keepAllLeaves: true })
      Reflect.deleteProperty(process.env, 'CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP')
      const optimized = await loadTranscriptFile(file)
      const { buildConversationChain } = await import('../sessionStorage.js')
      const original = buildConversationChain(full.messages, full.messages.get(id(8) as any)!)
      const actual = buildConversationChain(optimized.messages, optimized.messages.get(id(8) as any)!)
      if (hash(actual) !== hash(original)) throw new Error('G607_READER_MODEL_CONTEXT_MISMATCH')
      expect(hash(actual)).toBe(hash(original))
    } else {
      const { optimized } = await both()
      const serialized = JSON.stringify(optimized.messages)
      expect(serialized.includes('opaque-signature-one')).toBe(true)
      expect(serialized.includes('opaque-redacted-data')).toBe(true)
      expect(serialized.includes('read-b')).toBe(true)
    }
  })
}

test('Snip can remove its own source and a large parent bridge without losing the retained chain', async () => {
  const source = message(5, id(4), 'user', 'explicit snip metadata source')
  source.snipMetadata = { removedUuids: [id(3), id(5)] }
  await write([
    message(1, null, 'user', 'base'), message(2, id(1), 'assistant', 'A'),
    message(3, id(2), 'user', `explicitly-removed-${'x'.repeat(6 * 1024 * 1024)}`),
    message(4, id(3), 'assistant', 'B'), source,
    message(6, id(5), 'user', 'retained final prompt'),
  ])
  const { optimized } = await both()
  expect(optimized.messages.map(m => m.uuid)).toEqual([id(1), id(2), id(4), id(6)])
})

test('legacy progress bridging is as-of each physical row, including a reused progress UUID', async () => {
  await write([
    message(1, null, 'user', 'base'),
    { type: 'progress', uuid: id(99), parentUuid: id(1), timestamp: stamp(1) },
    message(2, id(99), 'assistant', 'earlier child'),
    message(3, id(2), 'user', 'middle'),
    { type: 'progress', uuid: id(99), parentUuid: id(3), timestamp: stamp(3) },
    message(4, id(99), 'assistant', 'later child'),
    message(0, null, 'assistant', `dead-${'x'.repeat(6 * 1024 * 1024)}`),
    message(5, id(4), 'user', 'final'),
  ])
  const { optimized } = await both()
  expect(optimized.messages.map(m => m.uuid)).toEqual([id(1), id(2), id(3), id(4), id(5)])
})

test('duplicate UUID last value and first insertion order survive equal timestamps', async () => {
  const first = message(2, id(1), 'assistant', 'old value')
  const other = message(3, id(1), 'assistant', 'same-time competing leaf')
  first.timestamp = stamp(10); other.timestamp = stamp(10)
  const replacement = { ...first, message: { ...first.message, content: 'final value' } }
  await write([message(1, null, 'user', 'base'), first, other,
    message(0, null, 'assistant', `dead-${'x'.repeat(6 * 1024 * 1024)}`), replacement])
  await both()
})
