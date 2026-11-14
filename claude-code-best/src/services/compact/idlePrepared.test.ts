import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findIdleNativeFile,
  runIdleCompact,
  resumeIdleSummary,
  readIdleNativeFile,
  writeIdleNativeFile,
  type IdleNativeFile,
} from './idleRecover.ts'

const sessionId = 'ccb-session'
const opId = 'ab'.repeat(32)

describe('idle summary is prepared before it is applied', () => {
  test('the first success does not record, and the next call applies once', async () => {
    const home = await mkdtemp(join(tmpdir(), 'idle-prepared-'))
    process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({ oc_turn_key: opId })
    const file: IdleNativeFile = {
      v: 1, opId, revision: 'rev-1', sessionId, modelCalls: 0, frozenTail: [], attachments: [],
    }
    writeIdleNativeFile(join(home, 'idle-native', encodeURIComponent(sessionId), 'rev-1.json'), file)
    const messages = [
      { type: 'user', uuid: 'tail-1', message: { role: 'user', content: 'kept goal'.padEnd(170_000 * 4, 'x') } },
    ] as never
    let modelCalls = 0
    let lastRecorded: unknown[] = []
    const prepared = await runIdleCompact({
      sessionId, home, messages,
      summarize: async () => {
        modelCalls += 1
        return 'kept goal, including the text API Error: 403'
      },
      record: async () => { throw new Error('recorded too early') },
      flush: async () => {},
      load: async () => null,
    })
    expect(prepared).toBe('prepared')
    expect(modelCalls).toBe(1)
    const raw = readFileSync(findIdleNativeFile(sessionId, home)!, 'utf8')
    expect(raw.includes('API Error: 403')).toBe(true)
    expect(raw.includes('"applied":true')).toBe(false)
    const again = await runIdleCompact({
      sessionId, home, messages,
      summarize: async () => { throw new Error('second model') },
      record: async (rows) => { lastRecorded = [...(rows as unknown[])] },
      flush: async () => {},
      load: async () => ({ messages: lastRecorded as never }),
    })
    expect(again).not.toBe('prepared')
    expect(lastRecorded.length).toBeGreaterThan(0)
    const applied = readFileSync(join(home, 'idle-native', encodeURIComponent(sessionId), 'rev-1.json'), 'utf8')
    expect(applied.includes('"applied":true')).toBe(true)
    expect(modelCalls).toBe(1)
    Reflect.deleteProperty(process.env, 'CLAUDE_CODE_EXTRA_METADATA')
    await rm(home, { recursive: true, force: true })
  })
})

describe('proof-only one-shot pre-apply anchor', () => {
  test('anchor is durable before record, and a partial-apply retry never recaptures the tip', async () => {
    const home = await mkdtemp(join(tmpdir(), 'idle-proof-anchor-'))
    const path = join(home, 'idle-native', sessionId, 'proof.json')
    const tip = '74700000-0000-4000-8000-000000000031'
    writeIdleNativeFile(path, { v: 1, sessionId, opId, revision: 'proof', summaryText: 'accepted proof',
      modelStarted: true, modelCalls: 1, frozenTail: [], attachments: [], captureRollbackTip: true } as IdleNativeFile)
    const messages = [{ type: 'user', uuid: tip, message: { role: 'user', content: 'original full context' } }] as never
    let persisted = messages
    let reads = 0
    try {
      await expect(runIdleCompact({ sessionId, home, messages,
        flush: async () => {}, load: async () => { reads++; return { messages: persisted } },
        record: async (rows) => {
          expect(readIdleNativeFile(path).rollbackTip).toBe(tip)
          expect((readIdleNativeFile(path) as any).captureRollbackTip).toBeUndefined()
          persisted = rows as never
          throw new Error('simulated lost receipt after record')
        },
      })).rejects.toThrow('simulated lost receipt after record')
      expect(reads).toBe(1)
      const resumed = await resumeIdleSummary({ sessionId, home, messages: persisted,
        loadOriginalTip: async () => { throw new Error('must not recapture partial tip') } })
      expect(resumed?.file.rollbackTip).toBe(tip)
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  test('missing original tip fails before apply and cannot silently consume authorization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'idle-no-anchor-'))
    const path = join(home, 'idle-native', sessionId, 'proof.json')
    writeIdleNativeFile(path, { v: 1, sessionId, opId, revision: 'proof', summaryText: 'accepted proof',
      modelStarted: true, modelCalls: 1, frozenTail: [], attachments: [], captureRollbackTip: true } as IdleNativeFile)
    let records = 0
    try {
      await expect(runIdleCompact({ sessionId, home, messages: [], flush: async () => {},
        load: async () => null, record: async () => { records++ },
      })).rejects.toThrow('IDLE_HISTORY_PENDING')
      expect(records).toBe(0)
      expect((readIdleNativeFile(path) as any).captureRollbackTip).toBe(true)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
