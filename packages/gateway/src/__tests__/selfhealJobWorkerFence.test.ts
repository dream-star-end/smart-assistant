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

/** fetch stub: answers claim-capability with a token and records every call. */
function fakeFetch() {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/claim-capability')) {
      return { ok: true, status: 200, json: async () => ({ token: 'cap-test' }) }
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
