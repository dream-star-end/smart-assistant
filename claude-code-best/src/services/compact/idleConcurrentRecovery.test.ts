import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIdleRollback } from '../../../../packages/storage/src/idleRollback.js'
import { loadMessagesFromJsonlPath } from '../../utils/conversationRecovery.js'
import { readIdleNativeFile, resumeIdleSummary, runIdleCompact, writeIdleNativeFile } from './idleRecover.js'
import type { Message } from '../../types/message.js'

for (const crossProcess of [false, true]) test('two proof-only recoverers retain the pre-apply anchor and applied receipt: ' + (crossProcess ? 'separate process' : 'same process'), async () => {
  const home = await mkdtemp(join(tmpdir(), 'idle-concurrent-'))
  const sessionId = '74700000-0000-4000-8000-0000000000a0', opId = 'e'.repeat(64)
  const oldHome = process.env.OPENCLAUDE_HOME, oldMeta = process.env.CLAUDE_CODE_EXTRA_METADATA
  process.env.OPENCLAUDE_HOME = home
  process.env.CLAUDE_CODE_EXTRA_METADATA = JSON.stringify({ oc_turn_key: opId })
  const path = join(home, 'idle-native', sessionId, 'proof.json')
  const transcript = join(home, sessionId + '.jsonl')
  const original = [1, 2, 3].map((n) => ({
    type: 'user', uuid: `74700000-0000-4000-8000-0000000000a${n}`,
    parentUuid: n === 1 ? null : `74700000-0000-4000-8000-0000000000a${n - 1}`,
    message: { role: 'user', content: n === 1 ? 'ORIGINAL_FULL_CONTEXT' : 'original turn ' + n },
    timestamp: new Date(1700000000000 + n).toISOString(), sessionId, isSidechain: false,
  })) as Message[]
  const tip = original.at(-1)!.uuid
  writeFileSync(transcript, original.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeIdleNativeFile(path, { v: 1, sessionId, opId, revision: 'proof', summaryText: 'accepted proof',
    modelStarted: true, modelCalls: 1, frozenTail: [],
    attachments: [], captureRollbackTip: true })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(r => { release = r })
  const started = new Promise<void>(r => { entered = r })
  let child: ReturnType<typeof spawn> | undefined
  let late: Promise<unknown> | undefined
  const load = async () => await loadMessagesFromJsonlPath(transcript) as { messages: Message[] }
  try {
    if (crossProcess) {
      const worker = join(home, 'worker.ts')
      writeFileSync(worker, `
        import { resumeIdleSummary } from ${JSON.stringify(fileURLToPath(new URL('./idleRecover.ts', import.meta.url)))};
        import { loadMessagesFromJsonlPath } from ${JSON.stringify(fileURLToPath(new URL('../../utils/conversationRecovery.ts', import.meta.url)))};
        import { existsSync, writeFileSync } from 'node:fs';
        const home = process.env.OPENCLAUDE_HOME!;
        await resumeIdleSummary({ sessionId: ${JSON.stringify(sessionId)}, home, messages: [],
          loadOriginalTip: async () => {
            writeFileSync(home + '/entered', '');
            while (!existsSync(home + '/release')) await new Promise(r => setTimeout(r, 10));
            return (await loadMessagesFromJsonlPath(${JSON.stringify(transcript)})).messages.at(-1)?.uuid;
          }
        });
      `)
      child = spawn(process.execPath, [worker], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stderr!.on('data', b => { output += b })
      late = new Promise<void>((resolve, reject) => {
        child!.once('error', reject)
        child!.once('close', code => code === 0 ? resolve() : reject(new Error('worker exit ' + code + ': ' + output)))
      })
      // Observe early failures without leaving an unhandled rejection while waiting for the gate.
      void late.catch(() => {})
      const deadline = Date.now() + 60000
      while (!existsSync(join(home, 'entered'))) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error('worker never entered capture: ' + output)
        await new Promise(r => setTimeout(r, 10))
      }
    } else {
      late = resumeIdleSummary({ sessionId, home, messages: [],
        loadOriginalTip: async () => { entered(); await gate; return (await load()).messages.at(-1)?.uuid } })
      await started
    }
    const seen = new Set(original.map(m => m.uuid))
    await runIdleCompact({ sessionId, home, messages: [], flush: async () => {}, load,
      record: async (rows) => {
        // Append-only writer boundary: dedup kept UUIDs, retain the real result/metadata and original parents.
        for (const [index, row] of rows.entries()) {
          if (seen.has(row.uuid)) continue
          seen.add(row.uuid)
          appendFileSync(transcript, JSON.stringify({ ...row, sessionId, isSidechain: false,
            parentUuid: index === 0 ? null : rows[index - 1]!.uuid,
            timestamp: (row as { timestamp?: string }).timestamp ?? new Date().toISOString(),
          }) + '\n')
        }
      },
    })
    const applied = readIdleNativeFile(path)
    const postApplyTip = (await load()).messages.at(-1)!.uuid
    expect(postApplyTip).not.toBe(tip)
    expect(applied.applied).toBe(true)
    expect(applied.artifact?.digest).toBeDefined()
    release()
    writeFileSync(join(home, 'release'), '')
    await late
    const final = readIdleNativeFile(path)
    expect(final.rollbackTip).toBe(tip)
    expect(final.applied).toBe(true)
    expect(final.artifact).toEqual(applied.artifact)
    expect(final.captureRollbackTip).toBeUndefined()
    writeIdleRollback(home, { v: 1, sessionId, opId, restoreTip: final.rollbackTip! })
    for (let resume = 0; resume < 2; resume++) {
      const restored = await load()
      expect(restored.messages.map(m => m.uuid)).toEqual(original.map(m => m.uuid))
      expect(JSON.stringify(restored.messages)).toContain('ORIGINAL_FULL_CONTEXT')
      expect(JSON.stringify(restored.messages)).not.toContain('accepted proof')
    }
  } finally {
    release()
    writeFileSync(join(home, 'release'), '')
    if (late) await Promise.allSettled([late])
    if (oldHome === undefined) delete process.env.OPENCLAUDE_HOME; else process.env.OPENCLAUDE_HOME = oldHome
    if (oldMeta === undefined) delete process.env.CLAUDE_CODE_EXTRA_METADATA; else process.env.CLAUDE_CODE_EXTRA_METADATA = oldMeta
    await rm(home, { recursive: true, force: true })
  }
})

test('concurrent native summary claims call the model only once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'idle-summary-claim-'))
  const sessionId = '74700000-0000-4000-8000-0000000000b0', opId = 'f'.repeat(64)
  const path = join(home, 'idle-native', sessionId, 'claim.json')
  writeIdleNativeFile(path, { v: 1, sessionId, opId, revision: 'claim', modelCalls: 0,
    frozenTail: [], attachments: [] })
  let release!: () => void, both!: () => void
  const gate = new Promise<void>(r => { release = r })
  const entered = new Promise<void>(r => { both = r })
  let samples = 0, calls = 0
  const input = { sessionId, home, messages: [], fit: { inputTokens: 100, inputBudget: 10 },
    loadOriginalTip: async () => { if (++samples === 2) both(); await gate; return 'original-tip' },
    summarize: async () => { calls++; return 'single summary' },
  }
  const runs = [resumeIdleSummary(input), resumeIdleSummary(input)]
  void Promise.allSettled(runs)
  try {
    await entered
    release()
    const results = await Promise.allSettled(runs)
    expect(calls).toBe(1)
    expect(results.some(r => r.status === 'fulfilled')).toBe(true)
    for (const result of results) if (result.status === 'rejected')
      expect(result.reason.message).toBe('IDLE_HISTORY_PENDING')
    expect(readIdleNativeFile(path).summaryText).toBe('single summary')
    expect(readIdleNativeFile(path).modelCalls).toBe(1)
    expect(readIdleNativeFile(path).rollbackTip).toBe('original-tip')
  } finally {
    release()
    await Promise.allSettled(runs)
    await rm(home, { recursive: true, force: true })
  }
})
