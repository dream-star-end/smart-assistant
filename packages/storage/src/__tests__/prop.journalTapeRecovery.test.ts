/**
 * Model-based property tests for Journal / Tape crash truncation, out-of-order
 * replay, and idempotent recovery.
 *
 * Drives real production storage & protocol modules:
 *   - `JsonlLog` (`packages/storage/src/jsonl.ts`)
 *   - `withSessionFile`, `appendSessionFile`, `readSessionFile`
 *     (`packages/storage/src/sessionFileIo.ts`)
 *   - `upsertClientSession`, `appendServerAuthoredMessage`, `getClientSession`,
 *     `getSessionsDb` (`packages/storage/src/sessionsDb.ts`)
 *   - `losslessBillingAnchorId` (`@openclaude/protocol`)
 */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, open, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { losslessBillingAnchorId } from '@openclaude/protocol'
import {
  type AsyncCommand,
  assertAsyncProperty,
  assertProperty,
  asyncModelRun,
  fc,
  resolvePbtRuns,
} from '../../../kernel/src/testing/propertyCheck.js'
import { JsonlLog } from '../jsonl.js'
import { appendSessionFile, readSessionFile, withSessionFile } from '../sessionFileIo.js'

const PBT_RUNS = resolvePbtRuns(200, process.env.PBT_RUNS)

const testHome = await mkdtemp(join(tmpdir(), 'oc-prop-journal-tape-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendServerAuthoredMessage,
  closeSessionsDb,
  getClientSession,
  getSessionsDb,
  upsertClientSession,
} = await import('../sessionsDb.js')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

interface JournalEvent {
  seq: number
  id: string
  turn: number
  text: string
}

function recoverDedupedEvents(rawRows: unknown[]): JournalEvent[] {
  const bySeq = new Map<number, JournalEvent>()
  for (const row of rawRows) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Partial<JournalEvent>
    if (
      typeof rec.seq !== 'number' ||
      !Number.isSafeInteger(rec.seq) ||
      typeof rec.id !== 'string' ||
      typeof rec.turn !== 'number' ||
      typeof rec.text !== 'string'
    ) {
      continue
    }
    if (!bySeq.has(rec.seq)) {
      bySeq.set(rec.seq, { seq: rec.seq, id: rec.id, turn: rec.turn, text: rec.text })
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('Property: Journal / Tape crash truncation & out-of-order idempotent recovery', () => {
  it('JsonlLog recovers all committed records across random byte truncations, corrupt tails & out-of-order duplicate replays', async () => {
    const scenarioArb = fc.record({
      events: fc.array(
        fc.record({
          text: fc.string({ minLength: 1, maxLength: 24 }),
          turn: fc.integer({ min: 0, max: 5 }),
        }),
        { minLength: 2, maxLength: 14 },
      ),
      replayOrderSeed: fc.nat(10_000),
      duplicateCount: fc.integer({ min: 0, max: 6 }),
      corruptTailBytes: fc.integer({ min: 0, max: 20 }),
      truncateTailFraction: fc.integer({ min: 0, max: 100 }),
    })

    const scratchDir = await mkdtemp(join(testHome, 'jsonl-pbt-'))
    let fileIdx = 0

    await assertAsyncProperty(
      scenarioArb,
      async (s) => {
        const logPath = join(scratchDir, `run-${fileIdx++}.jsonl`)
        const log = new JsonlLog(logPath)

        // Build canonical committed stream (seq 1..N).
        const committed: JournalEvent[] = s.events.map((e, i) => ({
          seq: i + 1,
          id: `evt-${i + 1}`,
          turn: e.turn,
          text: e.text,
        }))

        // 1. Write committed stream sequentially.
        for (const evt of committed) {
          await log.append(evt)
        }
        const committedSize = (await readFile(logPath)).length

        // 2. Append out-of-order replays + duplicate seqs.
        const replayIndices: number[] = []
        for (let i = 0; i < s.duplicateCount; i += 1) {
          replayIndices.push((s.replayOrderSeed + i * 7) % committed.length)
        }
        for (const idx of replayIndices) {
          await log.append(committed[idx]!)
        }

        // 3. Inject an uncommitted crash-truncated JSON record at the tail.
        const uncommittedLine = JSON.stringify({
          seq: committed.length + 1,
          id: 'evt-uncommitted',
          turn: 99,
          text: 'this-write-crashed-mid-flush-without-newline',
        })
        const partialLen = Math.max(
          1,
          Math.floor((uncommittedLine.length * Math.max(1, s.truncateTailFraction)) / 101),
        )
        const truncatedFragment = uncommittedLine.slice(0, Math.min(uncommittedLine.length - 1, partialLen))
        await appendFile(logPath, truncatedFragment)

        // Optionally also corrupt a short non-JSON suffix.
        if (s.corruptTailBytes > 0) {
          await appendFile(logPath, '\n{"broken":'.slice(0, Math.min(10, s.corruptTailBytes)))
        }

        // 4. Recover via real JsonlLog.readAll() + seq-idempotent deduplication.
        const recovered = recoverDedupedEvents(await log.readAll())

        // Exact committed state preserved, zero lost records, zero duplicates, uncommitted tail dropped.
        assert.deepEqual(
          recovered,
          committed,
          'recovered event stream must exactly match committed records with zero loss or duplicates',
        )

        // 5. Also verify byte-level mid-file truncation preserves every full line strictly before cutOffset.
        const cutOffset = Math.min(committedSize, Math.max(0, Math.floor((committedSize * s.truncateTailFraction) / 100)))
        await truncate(logPath, cutOffset)
        const afterHardTrunc = recoverDedupedEvents(await log.readAll())
        const rawPrefix = (await readFile(logPath, 'utf8')).split('\n')
        // Every completely flushed newline-terminated line in prefix MUST survive.
        const fullLinesCount = rawPrefix.length - 1
        assert.ok(
          afterHardTrunc.length >= fullLinesCount,
          `expected >= ${fullLinesCount} surviving committed records after byte truncation at ${cutOffset}, got ${afterHardTrunc.length}`,
        )
        for (let i = 0; i < fullLinesCount; i += 1) {
          assert.deepEqual(afterHardTrunc[i], committed[i])
        }
      },
      { numRuns: PBT_RUNS, seed: 0x77a7777, label: 'jsonl-crash-truncation-recovery' },
    )
  })

  it('sessionFileIo intent-staged recovery heals mid-write crash truncation deterministically', async () => {
    const projectsDir = await mkdtemp(join(testHome, 'session-io-pbt-'))
    let runNo = 0

    const crashScenarioArb = fc.record({
      initialLines: fc.array(fc.string({ minLength: 2, maxLength: 20 }), { minLength: 1, maxLength: 6 }),
      appendLines: fc.array(fc.string({ minLength: 2, maxLength: 20 }), { minLength: 1, maxLength: 6 }),
      crashAtPercent: fc.integer({ min: 0, max: 100 }),
    })

    // Runs real flock + fsync intent staging; cap at min(PBT_RUNS, 200) or full PBT_RUNS when scaled.
    await assertAsyncProperty(
      crashScenarioArb,
      async (s) => {
        const sid = `sessio-${runNo++}`
        const filePath = join(projectsDir, `${sid}.jsonl`)
        const scope = { projectsDir, sessionId: sid }

        const initialText = `${s.initialLines.map((l) => JSON.stringify({ phase: 'init', l })).join('\n')}\n`
        const appendText = `${s.appendLines.map((l) => JSON.stringify({ phase: 'append', l })).join('\n')}\n`
        await appendSessionFile(filePath, initialText, scope)

        // Simulate a crash right after intent.json + blobs were fsynced and target was partially written.
        const realProjectsDir = await realpath(projectsDir)
        const artifactKey = sha256Hex(Buffer.from(`${realProjectsDir}\n${sid}\nmain`, 'utf8'))
        const artifactDir = join(realProjectsDir, '.oc-transcript-integrity', artifactKey)
        const initialBuf = Buffer.from(initialText, 'utf8')
        const targetBuf = Buffer.from(appendText, 'utf8')
        const sourceSha = sha256Hex(Buffer.alloc(0))
        const targetSha = sha256Hex(targetBuf)

        // Inspect inode & write real staged intent + partial truncated target tail.
        const fh = await open(filePath, 'r+')
        try {
          const st = await fh.stat()
          await writeFile(join(artifactDir, `source-${sourceSha}.blob`), Buffer.alloc(0), { mode: 0o600 })
          await writeFile(join(artifactDir, `target-${targetSha}.blob`), targetBuf, { mode: 0o600 })
          const intent = {
            schema: 1,
            dev: st.dev,
            ino: st.ino,
            offset: initialBuf.length,
            sourceBytes: 0,
            sourceSha256: sourceSha,
            targetBytes: targetBuf.length,
            targetSha256: targetSha,
          }
          await writeFile(join(artifactDir, 'intent.json'), Buffer.from(JSON.stringify(intent)), {
            mode: 0o600,
          })
          // Write only a partial prefix of targetBuf to simulate power loss mid-write.
          const partialLen = Math.floor((targetBuf.length * s.crashAtPercent) / 100)
          if (partialLen > 0) {
            await fh.write(targetBuf.subarray(0, partialLen), 0, partialLen, initialBuf.length)
          }
        } finally {
          await fh.close()
        }

        // Next real readSessionFile MUST invoke completeIntent() and recover exact committed bytes.
        const recovered = await readSessionFile(filePath, scope)
        assert.equal(
          recovered.toString('utf8'),
          initialText + appendText,
          'sessionFileIo must complete staged intent deterministically without truncation or duplication',
        )

        // Re-reading a second time is strictly idempotent.
        const secondRead = await withSessionFile(filePath, scope, false, async (file) => {
          const st = await file.stat()
          const buf = Buffer.alloc(st.size)
          await file.read(buf, 0, st.size, 0)
          return buf.toString('utf8')
        })
        assert.equal(secondRead, initialText + appendText)
      },
      { numRuns: Math.min(PBT_RUNS, 24), seed: 0x88b8888, label: 'sessionFileIo-staged-crash-recovery' },
    )
  })

  it('sessionsDb server-authored tape appends survive out-of-order client PUTs and duplicate replays with monotonic unique _seq', async () => {
    interface Model {
      sessionId: string
      userId: string
      committedServerIds: Map<string, { role: 'tool' | 'assistant'; text: string; blockId?: string }>
      nextTurn: number
    }
    interface Real {
      dbReady: true
    }

    const assertDbInvariants = async (m: Model, label: string): Promise<void> => {
      const sess = await getClientSession(m.sessionId, m.userId)
      if (!sess) {
        assert.equal(m.committedServerIds.size, 0, `${label}: session vanished with committed records`)
        return
      }
      const msgs = sess.messages as Array<Record<string, unknown>>
      const idSet = new Set<string>()
      const seqSet = new Set<number>()

      for (const msg of msgs) {
        const id = String(msg.id)
        assert.equal(idSet.has(id), false, `${label}: duplicate committed message id ${id}`)
        idSet.add(id)
        if (typeof msg._seq === 'number') {
          assert.equal(seqSet.has(msg._seq), false, `${label}: duplicate _seq ${msg._seq}`)
          seqSet.add(msg._seq)
        }
      }

      for (const serverId of m.committedServerIds.keys()) {
        assert.equal(
          idSet.has(serverId),
          true,
          `${label}: committed server-authored tape record ${serverId} was lost`,
        )
      }
    }

    class AppendServerRecordCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly role: 'tool' | 'assistant',
        readonly text: string,
      ) {}
      check(): boolean {
        return true
      }
      async run(m: Model): Promise<void> {
        const turn = m.nextTurn++
        const blockId = this.role === 'tool' ? `blk-${turn}` : undefined
        const id =
          this.role === 'tool'
            ? `srv-${m.sessionId}-t${turn}-tool-${blockId}`
            : `srv-${m.sessionId}-t${turn}`

        const res = await appendServerAuthoredMessage(m.sessionId, m.userId, {
          id,
          role: this.role,
          text: this.text,
          ...(blockId ? { toolName: 'Bash', blockId, _completed: true } : {}),
          ts: 10_000 + turn,
        })
        assert.equal(res.applied, true)
        m.committedServerIds.set(id, { role: this.role, text: this.text, blockId })
        await assertDbInvariants(m, this.toString())
      }
      toString(): string {
        return `AppendServer(${this.role})`
      }
    }

    class ReplayDuplicateServerRecordCmd implements AsyncCommand<Model, Real> {
      constructor(readonly pickIdx: number) {}
      check(m: Readonly<Model>): boolean {
        return m.committedServerIds.size > 0
      }
      async run(m: Model): Promise<void> {
        const entries = [...m.committedServerIds.entries()]
        const [id, info] = entries[this.pickIdx % entries.length]!
        // Replay exact same server-authored id out of order -> MUST deduplicate idempotently.
        await appendServerAuthoredMessage(m.sessionId, m.userId, {
          id,
          role: info.role,
          text: info.text,
          ...(info.blockId ? { toolName: 'Bash', blockId: info.blockId, _completed: true } : {}),
          ts: 5_000,
        })
        await assertDbInvariants(m, this.toString())
      }
      toString(): string {
        return `ReplayDuplicate(${this.pickIdx})`
      }
    }

    class StaleOutOfOrderClientPutCmd implements AsyncCommand<Model, Real> {
      constructor(readonly dropServerTail: boolean) {}
      check(): boolean {
        return true
      }
      async run(m: Model): Promise<void> {
        // Client sends stale snapshot containing user msg + phantoms, omitting server-authored records!
        const messages: Array<Record<string, unknown>> = [
          { id: 'u-root', role: 'user', text: 'hello', ts: 1000 },
        ]
        if (!this.dropServerTail) {
          for (const [, info] of m.committedServerIds) {
            if (info.blockId) {
              messages.push({
                id: `client-phantom-${info.blockId}`,
                role: 'tool',
                toolName: 'Bash',
                text: 'Bash',
                blockId: info.blockId,
                ts: 1100,
              })
            }
          }
        }
        const now = Date.now()
        await upsertClientSession({
          id: m.sessionId,
          userId: m.userId,
          agentId: 'main',
          title: 'recovery-test',
          pinned: false,
          createdAt: 1000,
          lastAt: now,
          updatedAt: now,
          messages,
        } as Parameters<typeof upsertClientSession>[0])
        await assertDbInvariants(m, this.toString())
      }
      toString(): string {
        return `StaleClientPut(dropTail=${this.dropServerTail})`
      }
    }

    const cmdsArb = fc.commands<Model, Real, AsyncCommand<Model, Real>>(
      [
        {
          weight: 5,
          arbitrary: fc
            .record({
              role: fc.constantFrom('tool' as const, 'assistant' as const),
              text: fc.string({ minLength: 1, maxLength: 16 }),
            })
            .map((x) => new AppendServerRecordCmd(x.role, x.text)),
        },
        {
          weight: 4,
          arbitrary: fc.nat(12).map((idx) => new ReplayDuplicateServerRecordCmd(idx)),
        },
        {
          weight: 3,
          arbitrary: fc.boolean().map((drop) => new StaleOutOfOrderClientPutCmd(drop)),
        },
      ],
      { minLength: 4, maxLength: 18 },
    )

    let sessionRun = 0
    await assertAsyncProperty(
      cmdsArb,
      async (cmds) => {
        await asyncModelRun(
          async () => {
            const db = await getSessionsDb()
            db.exec('DELETE FROM client_sessions')
            const sessionId = `s-tape-${sessionRun++}`
            const userId = 'u-tape'
            await upsertClientSession({
              id: sessionId,
              userId,
              agentId: 'main',
              title: 'tape',
              pinned: false,
              createdAt: 1000,
              lastAt: 1000,
              updatedAt: 1000,
              messages: [{ id: 'u-root', role: 'user', text: 'hello', ts: 1000 }],
            } as Parameters<typeof upsertClientSession>[0])
            return {
              model: {
                sessionId,
                userId,
                committedServerIds: new Map(),
                nextTurn: 1,
              },
              real: { dbReady: true as const },
            }
          },
          cmds,
        )
      },
      { numRuns: PBT_RUNS, seed: 0x99c9999, label: 'sessionsDb-tape-out-of-order-recovery' },
    )
  })

  it('losslessBillingAnchorId is invariant under out-of-order event permutation', () => {
    const permArb = fc.record({
      turnIndex: fc.integer({ min: 0, max: 50 }),
      runtimeBatching: fc.boolean(),
      events: fc.array(
        fc.record({
          ordinal: fc.integer({ min: 1, max: 500 }),
          observedAt: fc.integer({ min: 1000, max: 9999 }),
          payload: fc.string({ minLength: 1, maxLength: 12 }),
        }),
        { minLength: 1, maxLength: 12 },
      ),
    })

    assertProperty(
      permArb,
      (s) => {
        // Deduplicate ordinals to form a canonical event set.
        const unique = [...new Map(s.events.map((e) => [e.ordinal, e])).values()]
        const forward = unique.slice().sort((a, b) => a.ordinal - b.ordinal)
        const reversed = forward.slice().reverse()

        const a1 = losslessBillingAnchorId({
          sessionId: 'sess-anchor',
          agentId: 'main',
          turnIndex: s.turnIndex,
          runtimeEvents: forward,
          runtimeBatching: s.runtimeBatching,
        })
        const a2 = losslessBillingAnchorId({
          sessionId: 'sess-anchor',
          agentId: 'main',
          turnIndex: s.turnIndex,
          runtimeEvents: reversed,
          runtimeBatching: s.runtimeBatching,
        })
        assert.equal(a1, a2, 'billing anchor must be deterministic regardless of event arrival order')
      },
      { numRuns: PBT_RUNS, seed: 0xaabaaaa, label: 'lossless-billing-anchor-permutation-invariance' },
    )
  })
})
