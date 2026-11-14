import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIdleCompactionResult, applyIdleTranscript, writeIdleNativeFile } from './idleRecover.js'
import { annotateBoundaryWithPreservedSegment, buildPostCompactMessages } from './compact.js'
import { loadMessagesFromJsonlPath } from '../../utils/conversationRecovery.js'

for (const legacy of [false, true]) test(`OCV5-747 parallel tool results survive idle apply and the real resume loader: ${legacy ? 'legacy boundary' : 'ordered boundary'}`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'idle-siblings-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = home
  const file = join(home, '74700000-0000-4000-8000-000000000000.jsonl')
  const id = (n: number) => `74700000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const row = (n: number, parent: number | null, role: string, content: unknown) => ({
    type: role, uuid: id(n), parentUuid: parent === null ? null : id(parent),
    sessionId: '74700000-0000-4000-8000-000000000000', isSidechain: false,
    timestamp: new Date(1700000000000 + n).toISOString(),
    message: { role, content },
  })
  const original = [
    row(1, null, 'user', 'Keep both results'),
    row(2, 1, 'assistant', [{ type: 'tool_use', id: 'a', name: 'Read', input: {} },
      { type: 'tool_use', id: 'b', name: 'Read', input: {} }]),
    row(3, 2, 'user', [{ type: 'tool_result', tool_use_id: 'a', content: 'first result' }]),
    row(4, 2, 'user', [{ type: 'tool_result', tool_use_id: 'b', content: 'second result' }]),
    row(5, 4, 'assistant', [{ type: 'text', text: 'both received' }]),
  ]
  const native = { v: 1 as const, opId: 'a'.repeat(64), revision: 'b'.repeat(64),
    sessionId: original[0]!.sessionId, summaryText: 'earlier context', modelCalls: 1,
    frozenTail: original.map(m => ({ uuid: m.uuid, parentUuid: m.parentUuid, message: m as never })),
    attachments: [] }
  try {
    const built = buildIdleCompactionResult(native, original as never, annotateBoundaryWithPreservedSegment)
    const expected = buildPostCompactMessages(built.result)
    if (legacy) {
      Reflect.deleteProperty(built.result.boundaryMarker.compactMetadata as Record<string, unknown>, 'idlePreservedUuids')
      writeIdleNativeFile(join(home, 'idle-native', native.sessionId, `${native.revision}.json`), native)
    }
    // Native writer deduplicates kept UUIDs: original sibling parents remain on disk.
    const added = expected.filter(m => !original.some(o => o.uuid === m.uuid))
    const persisted = [...original, ...added.map((m, i) => ({ ...m,
      parentUuid: i === 0 ? null : added[i - 1]!.uuid,
      sessionId: native.sessionId, isSidechain: false,
      timestamp: new Date(1800000000000 + i).toISOString() })) ,
      { ...row(6, null, 'user', 'continue'), parentUuid: original[4]!.uuid,
        timestamp: new Date(1900000000000).toISOString() }]
    await writeFile(file, `${persisted.map(m => JSON.stringify(m)).join('\n')}\n`)
    const loaded = await loadMessagesFromJsonlPath(file)
    expect(loaded.messages.map(m => m.uuid)).toContain(id(3))
    await applyIdleTranscript({ sessionId: native.sessionId, messages: expected, artifact: built.artifact,
      record: async () => {}, flush: async () => {}, load: async () => loaded as never })
    expect(JSON.stringify(loaded.messages)).toContain('first result')
    expect(JSON.stringify(loaded.messages)).toContain('second result')
    if (legacy) {
      writeIdleNativeFile(join(home, 'idle-native', native.sessionId, `${native.revision}.json`),
        { ...native, summaryText: 'wrong projection' })
      await expect(loadMessagesFromJsonlPath(file)).rejects.toThrow('IDLE_RECOVERY_CORRUPT')
    }
  } finally {
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME'); else process.env.OPENCLAUDE_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
