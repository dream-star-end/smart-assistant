import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeIdleRollback, idleSyntheticUuid } from '../../../../packages/storage/src/idleRollback.js'
import { loadMessagesFromJsonlPath } from '../../utils/conversationRecovery.js'
import { findIdleNativeFile, readIdleNativeByOp, writeIdleNativeFile } from './idleRecover.js'

test('abandoned partial apply restores original context on two real resumes, including >5MB reader path', async () => {
  const home = await mkdtemp(join(tmpdir(), 'idle-rollback-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = home
  const sid = '74700000-0000-4000-8000-000000000010'
  const opId = 'd'.repeat(64)
  const id = (n: number) => `74700000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const boundary = idleSyntheticUuid(opId, 'boundary')
  const summary = idleSyntheticUuid(opId, 'summary')
  const row = (uuid: string, parentUuid: string | null, content: string, ts: number) => ({
    uuid, parentUuid, type: 'user', message: { role: 'user', content }, isSidechain: false,
    timestamp: new Date(1800000000000 + ts).toISOString(), sessionId: sid,
  })
  const file = join(home, `${sid}.jsonl`)
  const bytes = `${[
    row(id(1), null, `ORIGINAL_FULL_CONTEXT_${'x'.repeat(6 * 1024 * 1024)}`, 1),
    row(id(2), id(1), 'original last turn', 2),
    { ...row(boundary, null, '', 3), type: 'system', subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual', preTokens: 0, idleOpId: opId } },
    row(summary, boundary, 'FAILED_PARTIAL_SUMMARY', 4),
    // A local command error may parent the partial summary: validated rollback tip bridges it.
    row(id(3), summary, 'following user message', 5),
  ].map(r => JSON.stringify(r)).join('\n')}\n`
  await writeFile(file, bytes)
  writeIdleNativeFile(join(home, 'idle-native', sid, 'rev.json'), {
    v: 1, sessionId: sid, opId, revision: 'rev', modelCalls: 1, modelStarted: true,
    summaryText: 'FAILED_PARTIAL_SUMMARY', rollbackTip: id(2), frozenTail: [], attachments: [],
  })
  try {
    expect(JSON.stringify((await loadMessagesFromJsonlPath(file)).messages)).not.toContain('ORIGINAL_FULL_CONTEXT_')
    writeIdleRollback(home, { v: 1, sessionId: sid, opId, restoreTip: id(2) })
    for (let restart = 0; restart < 2; restart++) {
      const loaded = await loadMessagesFromJsonlPath(file)
      expect(loaded.messages.map(m => m.uuid)).toEqual([id(1), id(2), id(3)])
      expect(JSON.stringify(loaded.messages)).toContain('ORIGINAL_FULL_CONTEXT_')
      expect(JSON.stringify(loaded.messages)).not.toContain('FAILED_PARTIAL_SUMMARY')
    }
    expect(await readFile(file, 'utf8')).toBe(bytes) // integrity receipts/append-only data untouched
    expect(findIdleNativeFile(sid, home)).toBeUndefined()
    expect(() => readIdleNativeByOp(sid, opId, home)).toThrow('IDLE_OP_ABANDONED')
    await writeFile(join(home, 'idle-abandoned', sid, `${opId}.json`), '{}')
    await expect(loadMessagesFromJsonlPath(file)).rejects.toThrow('IDLE_RECOVERY_CORRUPT')
  } finally {
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME'); else process.env.OPENCLAUDE_HOME = oldHome
    await rm(home, { recursive: true, force: true })
  }
})
