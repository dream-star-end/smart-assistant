import * as assert from 'node:assert/strict'
/**
 * jobWorker execution-side fence tests (block C / design §A2): the guarded
 * starting→running CAS return value is CHECKED — a cancel that wins first
 * yields session destruction and ZERO submits; clone preparation happens
 * before any submit and its failure fails the job (with a best-effort failed
 * callback); the repair prompt carries the clone path.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealJobWorkerFence.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-selfheal-worker-'))
process.env.OPENCLAUDE_HOME = testHome

const { claimNextJob, closeSelfhealDb, getJob, insertJobReceived } = await import(
  '@openclaude/storage'
)
type AgentDefLike = import('@openclaude/storage').AgentDef
const { SelfhealJobWorker, claimSelfhealCapability } = await import('../selfheal/jobWorker.js')
const { executeSelfhealCancel } = await import('../selfheal/cancel.js')
type SessionManagerLike = import('../sessionManager.js').SessionManager

after(async () => {
  await closeSelfhealDb()
})

const AGENT = { id: 'codex-v5ops' } as unknown as AgentDefLike

function fakeSessionManager() {
  const live = new Set<string>()
  const state = {
    live,
    submits: [] as { sessionKey: string; prompt: string; executionId: string }[],
    destroys: [] as string[],
  }
  const mgr = {
    state,
    getOrCreate: async (input: { sessionKey: string }) => {
      live.add(input.sessionKey)
      return { sessionKey: input.sessionKey }
    },
    getByKey: (k: string) => (live.has(k) ? { sessionKey: k } : undefined),
    interrupt: (_k: string) => true,
    destroySession: async (k: string) => {
      state.destroys.push(k)
      live.delete(k)
    },
    submitWithExecutionId: async (
      session: { sessionKey: string },
      prompt: string,
      executionId: string,
      _onEvent?: (event: unknown) => void,
    ) => {
      state.submits.push({ sessionKey: session.sessionKey, prompt, executionId })
      return { executionId, status: 'done', ranHere: true }
    },
  }
  return mgr
}

/** fetch stub: answers claim-capability with a token, context with the
 *  authoritative condition key (frozen before any submit), records calls. */
function fakeFetch(
  conditionKey: string | null = 'ops.monitor:svc_v5',
  opts: { ackStatus?: number; executionClass?: 'tier1' | 'tier2'; actionOpcode?: string } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/claim-capability')) {
      return { ok: true, status: 200, json: async () => ({ token: 'cap-test' }) }
    }
    if (String(url).endsWith('/context')) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          conditionKey === null
            ? {}
            : {
                conditionKey,
                tier: opts.executionClass ?? 'tier2',
                executionClass: opts.executionClass ?? 'tier2',
                actionOpcode: opts.actionOpcode ?? null,
              },
      }
    }
    if (/\/(ack|done|failed|progress)$/.test(String(url))) {
      const status = String(url).endsWith('/ack') ? (opts.ackStatus ?? 200) : 200
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof fetch
  return { impl, calls }
}

function makeWorker(opts: {
  sessions: ReturnType<typeof fakeSessionManager>
  fetchImpl: typeof fetch
  resolveAgent?: () => Promise<AgentDefLike | null>
  prepareClone?: (input: { repairId: string }) => Promise<{ clonePath: string }>
}) {
  return new SelfhealJobWorker({
    sessions: opts.sessions as unknown as SessionManagerLike,
    resolveAgent: opts.resolveAgent ?? (async () => AGENT),
    callbackBaseUrl: 'http://127.0.0.1:1',
    hmacSecret: 'test-secret-of-decent-length-123456',
    canonicalRepo: '/canon',
    canonicalBranch: 'main',
    ochealUid: 1000,
    ochealGid: 1000,
    prepareClone:
      (opts.prepareClone as never) ??
      (async ({ repairId }: { repairId: string }) => ({ clonePath: `/clones/${repairId}` })),
    fetchImpl: opts.fetchImpl,
  })
}

function claimFetch(payload: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as typeof fetch
}

describe('claim-capability wire response', () => {
  it('accepts the canonical token field', async () => {
    const token = await claimSelfhealCapability({
      callbackBaseUrl: 'http://127.0.0.1:1',
      hmacSecret: 'test-secret-of-decent-length-123456',
      repairId: '1',
      fetchImpl: claimFetch({ token: 'cap-test' }),
    })
    assert.equal(token, 'cap-test')
  })

  for (const [name, payload] of [
    ['missing token', {}],
    ['empty token', { token: '' }],
    ['non-string token', { token: 123 }],
    ['legacy capability field', { capability: 'cap-test' }],
  ] as const) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(
        claimSelfhealCapability({
          callbackBaseUrl: 'http://127.0.0.1:1',
          hmacSecret: 'test-secret-of-decent-length-123456',
          repairId: '1',
          fetchImpl: claimFetch(payload),
        }),
        /claim-capability response missing token/,
      )
    })
  }
})

type ProcessJobRunner = { processJob(job: unknown): Promise<void> }

async function stageStartingJob(repairId: string) {
  await insertJobReceived({ repairId, incidentId: 'i', attempt: 0, payloadHash: 'p' })
  const job = await claimNextJob({ owner: 'test', leaseMs: 600_000, now: Date.now() })
  assert.equal(job?.repairId, repairId)
  return job
}

describe('processJob happy path — clone precedes submit; prompt carries the clone path', () => {
  it('runs one turn and succeeds the job', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch()
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-ok')
    await worker.processJob(job)

    assert.equal(sessions.state.submits.length, 1)
    assert.equal(sessions.state.submits[0]?.executionId, 'w-ok')
    assert.ok(
      sessions.state.submits[0]?.prompt.includes('/clones/w-ok'),
      'prompt carries clone path',
    )
    assert.ok(sessions.state.submits[0]?.prompt.includes('oc-selfheal'), 'prompt teaches the CLI')
    const after = await getJob('w-ok')
    assert.equal(after?.status, 'succeeded')
    assert.equal(after?.capability, 'cap-test')
    assert.equal(after?.sessionKey, 'selfheal:w-ok')
  })
})

describe('CAS return-value check — cancel-first ⇒ destroy session, ZERO submit', () => {
  it('a job cancelled before the fence never submits', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch()
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-cancelled')
    // Cancel lands after the claim but before processJob's fence.
    const cancel = await executeSelfhealCancel(
      { repairId: 'w-cancelled', incidentId: 'i' },
      sessions,
    )
    assert.equal(cancel.terminated, true)

    await worker.processJob(job)
    assert.equal(sessions.state.submits.length, 0, 'zero submit after cancel')
    assert.deepEqual(
      sessions.state.destroys,
      ['selfheal:w-cancelled'],
      'the built session is destroyed',
    )
    assert.equal(
      (await getJob('w-cancelled'))?.status,
      'cancelled',
      'cancel owns the terminal status',
    )
  })

  it('a cancel landing DURING processJob (while cloning) still yields zero submit', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch()
    let releaseClone: () => void = () => {}
    const cloneGate = new Promise<void>((r) => {
      releaseClone = r
    })
    const worker = makeWorker({
      sessions,
      fetchImpl: impl,
      prepareClone: async ({ repairId }) => {
        await cloneGate
        return { clonePath: `/clones/${repairId}` }
      },
    }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-mid')
    const run = worker.processJob(job)
    // While the worker is parked in prepareClone, the cancel wins the fence.
    await new Promise((r) => setTimeout(r, 10))
    const cancel = await executeSelfhealCancel({ repairId: 'w-mid', incidentId: 'i' }, sessions)
    assert.equal(cancel.terminated, true)
    releaseClone()
    await run

    assert.equal(sessions.state.submits.length, 0, 'zero submit')
    assert.deepEqual(sessions.state.destroys, ['selfheal:w-mid'])
    assert.equal((await getJob('w-mid'))?.status, 'cancelled')
  })
})

describe('clone failure — job failed + best-effort failed callback, no session, no submit', () => {
  it('fails the job when prepareClone throws', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch()
    const worker = makeWorker({
      sessions,
      fetchImpl: impl,
      prepareClone: async () => {
        throw new Error('disk full')
      },
    }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-clonefail')
    await worker.processJob(job)

    assert.equal((await getJob('w-clonefail'))?.status, 'failed')
    assert.equal(sessions.state.submits.length, 0)
    // Best-effort failed callback went to the master with the capability before
    // processJob settled.
    const failedCall = calls.find((c) => c.url.includes('/repairs/w-clonefail/failed'))
    assert.ok(failedCall, 'reported failed to v5')
    assert.equal(
      (failedCall?.init?.headers as Record<string, string>)?.Authorization,
      'Bearer cap-test',
    )
  })

  it('does not report failed when cancel wins while clone preparation is failing', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch()
    let releaseClone: () => void = () => {}
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve
    })
    const worker = makeWorker({
      sessions,
      fetchImpl: impl,
      prepareClone: async () => {
        await cloneGate
        throw new Error('disk full after cancel')
      },
    }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-clone-cancel')
    const run = worker.processJob(job)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await executeSelfhealCancel({ repairId: 'w-clone-cancel', incidentId: 'i' }, sessions)
    releaseClone()
    await run

    assert.equal((await getJob('w-clone-cancel'))?.status, 'cancelled')
    assert.equal(
      calls.some((c) => c.url.includes('/repairs/w-clone-cancel/failed')),
      false,
      'cancel owns terminal status and callback',
    )
  })
})

describe('terminal worker failures are reported exactly when the failed CAS wins', () => {
  it('reports a missing repair agent', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch()
    const worker = makeWorker({
      sessions,
      fetchImpl: impl,
      resolveAgent: async () => null,
    }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-no-agent')
    await worker.processJob(job)

    assert.equal((await getJob('w-no-agent'))?.status, 'failed')
    assert.equal(calls.filter((c) => c.url.includes('/repairs/w-no-agent/failed')).length, 1)
  })

  it('reports a thrown repair turn', async () => {
    const sessions = fakeSessionManager()
    sessions.submitWithExecutionId = async () => {
      throw new Error('upstream auth failed')
    }
    const { impl, calls } = fakeFetch()
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-turn-throw')
    await worker.processJob(job)

    assert.equal((await getJob('w-turn-throw'))?.status, 'failed')
    assert.equal(calls.filter((c) => c.url.includes('/repairs/w-turn-throw/failed')).length, 1)
  })

  it('reports an authoritative final isError result', async () => {
    const sessions = fakeSessionManager()
    sessions.submitWithExecutionId = async (_session, _prompt, executionId, onEvent) => {
      onEvent?.({ kind: 'final', meta: { isError: true } } as never)
      return { executionId, status: 'done', ranHere: true }
    }
    const { impl, calls } = fakeFetch()
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-final-error')
    await worker.processJob(job)

    assert.equal((await getJob('w-final-error'))?.status, 'failed')
    assert.equal(calls.filter((c) => c.url.includes('/repairs/w-final-error/failed')).length, 1)
  })
})

describe('condition key freeze — before any submit, fail-closed (batch0)', () => {
  it('freezes the authoritative condition key onto the job before the turn starts', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch('selfheal.drill:transport_v1')
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-freeze')
    await worker.processJob(job)

    const after = await getJob('w-freeze')
    assert.equal(after?.conditionKey, 'selfheal.drill:transport_v1')
    assert.equal(sessions.state.submits.length, 1)
    const contextCall = calls.findIndex((c) => c.url.endsWith('/context'))
    const capabilityCall = calls.findIndex((c) => c.url.includes('/claim-capability'))
    assert.ok(contextCall > capabilityCall, 'context is fetched with the claimed capability')
  })

  it('fail-closed: no usable conditionKey ⇒ zero submit, job stays starting for retry', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch(null) // context answers {} — nothing to freeze
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-freeze-fail')
    await worker.processJob(job)

    assert.equal(sessions.state.submits.length, 0, 'a turn must never start unfrozen')
    const after = await getJob('w-freeze-fail')
    assert.equal(after?.status, 'starting', 'job is left for a later tick (lease retry)')
    assert.equal(after?.conditionKey, null)
  })
})

describe('machine-authored ack — before any submit, fail-closed (drill#1 409 root cause)', () => {
  it('acks the master (capability auth) after freeze and before the turn', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch()
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-ack')
    await worker.processJob(job)

    assert.equal(sessions.state.submits.length, 1)
    const ackCall = calls.find((c) => c.url.endsWith('/ack'))
    assert.ok(ackCall, 'worker must send the ack callback')
    assert.match(String(ackCall?.init?.headers && (ackCall.init.headers as Record<string, string>).Authorization), /^Bearer cap-test$/)
    const ackIdx = calls.findIndex((c) => c.url.endsWith('/ack'))
    const ctxIdx = calls.findIndex((c) => c.url.endsWith('/context'))
    assert.ok(ackIdx > ctxIdx, 'ack follows the condition freeze')
  })

  it('fail-closed: ack rejected ⇒ zero submit, job stays starting for retry', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_v5', { ackStatus: 503 })
    const worker = makeWorker({ sessions, fetchImpl: impl }) as unknown as ProcessJobRunner
    const job = await stageStartingJob('w-ack-fail')
    await worker.processJob(job)

    assert.equal(sessions.state.submits.length, 0, 'no turn may start unacked')
    assert.equal((await getJob('w-ack-fail'))?.status, 'starting')
  })
})

describe('Tier1 pure machine path (batch1a) — no clone, no codex, machine done', () => {
  const HOST_CFG = { host: 'kl-mirror', keyPath: '/k' }

  function tier1Worker(opts: {
    sessions: ReturnType<typeof fakeSessionManager>
    fetchImpl: typeof fetch
    hostActionConfig?: unknown
    executeHostOpcode?: unknown
    prepareClone?: (input: { repairId: string }) => Promise<{ clonePath: string }>
  }) {
    return new SelfhealJobWorker({
      sessions: opts.sessions as never,
      resolveAgent: async () => AGENT,
      callbackBaseUrl: 'http://127.0.0.1:1',
      hmacSecret: 'test-secret-of-decent-length-123456',
      canonicalRepo: '/canon',
      canonicalBranch: 'main',
      ochealUid: 1000,
      ochealGid: 1000,
      prepareClone:
        (opts.prepareClone as never) ??
        (async ({ repairId }: { repairId: string }) => ({ clonePath: `/clones/${repairId}` })),
      fetchImpl: opts.fetchImpl,
      hostActionConfig: opts.hostActionConfig as never,
      executeHostOpcode: opts.executeHostOpcode as never,
    }) as unknown as ProcessJobRunner
  }

  it('svc_egress: executes opcode, machine done, job succeeded, ZERO codex submit / clone', async () => {
    const sessions = fakeSessionManager()
    const { impl, calls } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1',
      actionOpcode: 'restart-v5-egress-v1',
    })
    const opcodes: string[] = []
    let cloned = false
    const worker = tier1Worker({
      sessions,
      fetchImpl: impl,
      hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => {
        opcodes.push(op)
        return { opcode: op, outcome: 'completed', exit: 0, host: 'kl-mirror', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} }
      },
      prepareClone: async () => { cloned = true; return { clonePath: '/x' } },
    })
    await worker.processJob(await stageStartingJob('t1-ok'))

    assert.deepEqual(opcodes, ['restart-v5-egress-v1'], 'the frozen opcode was transmitted')
    assert.equal(sessions.state.submits.length, 0, 'Tier1 never starts a codex turn')
    assert.equal(cloned, false, 'Tier1 never prepares a clone')
    // Terminal callback goes via the durable outbox (pump not run here), so the
    // job reaching 'succeeded' proves the enqueue landed before terminalization.
    assert.equal((await getJob('t1-ok'))?.status, 'succeeded')
    assert.ok((await getJob('t1-ok'))?.tier1Receipt, 'receipt is durable')
  })

  it('opcode drift (frozen ≠ local map) ⇒ machine failed, opcode NOT transmitted', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1',
      actionOpcode: 'clean-v5-disk-v1', // wrong opcode for svc_egress
    })
    let transmitted = false
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async () => { transmitted = true; return { opcode: 'x', outcome: 'completed', exit: 0, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} } },
    })
    await worker.processJob(await stageStartingJob('t1-drift'))
    assert.equal(transmitted, false, 'drift must never transmit')
    assert.equal((await getJob('t1-drift'))?.status, 'failed')
  })

  it('host action not provisioned (null config) ⇒ machine failed, no transmit', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:disk_root', {
      executionClass: 'tier1', actionOpcode: 'clean-v5-disk-v1',
    })
    const worker = tier1Worker({ sessions, fetchImpl: impl, hostActionConfig: null })
    await worker.processJob(await stageStartingJob('t1-noprov'))
    assert.equal((await getJob('t1-noprov'))?.status, 'failed')
  })

  it('action_failed (remote ran, exit>0) ⇒ done → verifying (NOT machine failed; probe decides)', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:http_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => ({ opcode: op, outcome: 'action_failed', exit: 3, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} }),
    })
    await worker.processJob(await stageStartingJob('t1-actionfail'))
    assert.equal((await getJob('t1-actionfail'))?.status, 'succeeded', 'attempted action → done, probe adjudicates')
  })

  it('rejected (never authorized to run) ⇒ machine failed', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => ({ opcode: op, outcome: 'rejected', exit: 65, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} }),
    })
    await worker.processJob(await stageStartingJob('t1-rejected'))
    assert.equal((await getJob('t1-rejected'))?.status, 'failed')
  })

  it('unknown transport outcome ⇒ optimistic done → verifying (probe fence adjudicates)', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => ({ opcode: op, outcome: 'unknown', exit: -1, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} }),
    })
    await worker.processJob(await stageStartingJob('t1-unknown'))
    assert.equal((await getJob('t1-unknown'))?.status, 'succeeded')
  })

  it('pre-claim replay guard: a re-claim with a committed receipt does NOT re-transmit', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    let transmits = 0
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => { transmits++; return { opcode: op, outcome: 'completed', exit: 0, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} } },
    })
    const job = await stageStartingJob('t1-replay')
    await worker.processJob(job)
    await worker.processJob(job) // re-claim after crash
    assert.equal(transmits, 1, 'the opcode is transmitted at most once')
  })

  it('cancel-first ⇒ tier1 zero SSH transmit, no stale callback', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    let transmits = 0
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => { transmits++; return { opcode: op, outcome: 'completed', exit: 0, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} } },
    })
    const job = await stageStartingJob('t1-cancelfirst')
    // Cancel terminalizes the job before processJob's running CAS.
    await executeSelfhealCancel({ repairId: 't1-cancelfirst', incidentId: 'i' }, sessions)
    await worker.processJob(job)
    assert.equal(transmits, 0, 'a cancelled tier1 repair never transmits the opcode')
    assert.equal((await getJob('t1-cancelfirst'))?.status, 'cancelled', 'cancel owns the terminal status')
  })

  it('worker-first ⇒ cancel WAITS for the SSH lock; one terminal, no stale callback', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    let releaseSsh: () => void = () => {}
    const sshGate = new Promise<void>((r) => { releaseSsh = r })
    let inSsh = false
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => {
        inSsh = true
        await sshGate // hold the lock while the SSH is "in flight"
        return { opcode: op, outcome: 'completed', exit: 0, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} }
      },
    })
    const job = await stageStartingJob('t1-workerfirst')
    const p = (worker as unknown as { processJob(j: unknown): Promise<void> }).processJob(job)
    // Wait until the worker is inside the SSH (holding withRepairLock).
    while (!inSsh) await new Promise((r) => setTimeout(r, 5))

    let cancelDone = false
    const cancelP = executeSelfhealCancel({ repairId: 't1-workerfirst', incidentId: 'i' }, sessions).then((r) => { cancelDone = true; return r })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(cancelDone, false, 'cancel must block on the repair lock while the SSH is in flight')

    releaseSsh()
    await p
    await cancelP
    // The worker won the lock: job is a worker terminal (succeeded), and the
    // cancel serialized behind it (no stale callback, no double terminal).
    assert.equal((await getJob('t1-workerfirst'))?.status, 'succeeded')
  })

  it('pre-claim crash window: claimed-without-receipt settles unknown, ZERO transmit', async () => {
    const sessions = fakeSessionManager()
    const { impl } = fakeFetch('ops.monitor:svc_egress', {
      executionClass: 'tier1', actionOpcode: 'restart-v5-egress-v1',
    })
    let transmits = 0
    const worker = tier1Worker({
      sessions, fetchImpl: impl, hostActionConfig: HOST_CFG,
      executeHostOpcode: async (op: string) => { transmits++; return { opcode: op, outcome: 'completed', exit: 0, host: 'h', startedAt: 0, finishedAt: 1, durationMs: 1, detail: {} } },
    })
    // Simulate a prior attempt that WON the pre-claim then crashed before the
    // receipt: freeze routing + set tier1_claimed_at, leave tier1_receipt NULL.
    await stageStartingJob('t1-crashclaim')
    const { setJobFrozenRouting, claimJobTier1 } = await import('@openclaude/storage')
    await setJobFrozenRouting('t1-crashclaim', 'ops.monitor:svc_egress', 'tier1', 'restart-v5-egress-v1')
    assert.equal(await claimJobTier1('t1-crashclaim'), true, 'pre-claim set')
    // Re-claim: routing already frozen, claim held, no receipt.
    const rejob = { repairId: 't1-crashclaim', incidentId: 'i', attempt: 0 } as unknown
    await (worker as unknown as { processJob(j: unknown): Promise<void> }).processJob(rejob)
    assert.equal(transmits, 0, 'a claimed-without-receipt repair NEVER re-transmits')
    assert.equal((await getJob('t1-crashclaim'))?.status, 'succeeded', 'unknown → done → succeeded')
    const receipt = JSON.parse((await getJob('t1-crashclaim'))?.tier1Receipt ?? '{}')
    assert.equal(receipt.outcome, 'unknown')
  })
})
