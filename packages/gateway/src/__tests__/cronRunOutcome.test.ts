// Regression guard for the 2026-07-19 → 07-26 silent-failure incident:
// skill-autotrain failed every night on an expired OAuth session, produced no
// output, and the "empty === silent" exit swallowed it. last-run.json stopped
// advancing and nobody noticed for 8 days.
//
// OPENCLAUDE_HOME is redirected BEFORE importing cron.js because storage/paths
// resolves it at module load — the dynamic import below must stay after it.
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
// Type-only: erased at compile time, so it cannot pull cron.js in before the
// OPENCLAUDE_HOME redirect below takes effect.
import type { CronJob, CronRunStatus } from '../cron.js'

const TEST_HOME = await mkdtemp(join(tmpdir(), 'oc-cron-test-'))
process.env.OPENCLAUDE_HOME = TEST_HOME

const { CronScheduler, classifyRunOutcome, normalizeLastRunEntry, shouldAlertOnFailure } =
  await import('../cron.js')

/** runJob stays private in production; tests reach it through this shape. */
type RunJobFn = (
  job: CronJob,
  agent: unknown,
  priorFailures: number,
) => Promise<{ status: CronRunStatus; error?: string }>

after(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
})

describe('classifyRunOutcome', () => {
  it('treats an empty transcript as failure, not silence', () => {
    assert.equal(classifyRunOutcome(undefined, ''), 'failed')
    assert.equal(classifyRunOutcome(undefined, '   \n  '), 'failed')
  })

  it('treats a thrown turn as failure even if partial text arrived', () => {
    assert.equal(classifyRunOutcome('OAuth session expired', 'partial output'), 'failed')
  })

  it('honours the explicit silence markers', () => {
    assert.equal(classifyRunOutcome(undefined, '[SILENT]'), 'silent')
    assert.equal(classifyRunOutcome(undefined, '[SILENT] nothing to add'), 'silent')
    assert.equal(classifyRunOutcome(undefined, 'HEARTBEAT_OK'), 'silent')
  })

  it('reports real output as ok', () => {
    assert.equal(classifyRunOutcome(undefined, 'trained 2 skills'), 'ok')
    // Only an exact HEARTBEAT_OK is silence; a report that mentions it is not.
    assert.equal(classifyRunOutcome(undefined, 'HEARTBEAT_OK plus a real finding'), 'ok')
  })
})

describe('shouldAlertOnFailure', () => {
  it('alerts on the first three, then every fifth', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9, 10, 11].map(shouldAlertOnFailure), [
      true,
      true,
      true,
      false,
      true,
      false,
      false,
      true,
      false,
    ])
  })
})

describe('normalizeLastRunEntry', () => {
  it('upgrades the legacy bare-number format to a success record', () => {
    const rec = normalizeLastRunEntry(29740012)
    assert.equal(rec?.minuteKey, 29740012)
    assert.equal(rec?.status, 'ok')
    assert.equal(rec?.consecutiveFailures, 0)
    assert.equal(rec?.at, new Date(29740012 * 60_000).toISOString())
  })

  it('round-trips a full record', () => {
    const rec = normalizeLastRunEntry({
      minuteKey: 100,
      status: 'failed',
      at: '2026-07-25T18:52:00.000Z',
      error: 'OAuth session expired',
      consecutiveFailures: 7,
    })
    assert.equal(rec?.status, 'failed')
    assert.equal(rec?.error, 'OAuth session expired')
    assert.equal(rec?.consecutiveFailures, 7)
  })

  it('rejects garbage instead of poisoning the ledger', () => {
    assert.equal(normalizeLastRunEntry(null), null)
    assert.equal(normalizeLastRunEntry('nope'), null)
    assert.equal(normalizeLastRunEntry({}), null)
    assert.equal(normalizeLastRunEntry({ minuteKey: Number.NaN }), null)
  })

  it('defaults an unknown status to ok rather than dropping the entry', () => {
    const rec = normalizeLastRunEntry({ minuteKey: 5, status: 'bogus' })
    assert.equal(rec?.status, 'ok')
  })
})

// ── runJob behaviour ────────────────────────────────────────────────────────

type SubmitImpl = (emit: (text: string) => void) => Promise<void>

function makeScheduler(submit: SubmitImpl) {
  const delivered: Array<{ text: string; jobId: string; deliver?: string; label?: string }> = []
  let destroyed = 0
  const sessions = {
    getOrCreate: async () => ({ id: 'test-session' }),
    submit: async (_session: unknown, _prompt: string, onEvent: (e: unknown) => void) => {
      await submit((text) => onEvent({ kind: 'block', block: { kind: 'text', text } }))
    },
    destroySession: async () => {
      destroyed += 1
    },
  }
  const scheduler = new CronScheduler({} as never, sessions as never, (text, job) => {
    delivered.push({ text, jobId: job.id, deliver: job.deliver, label: job.label })
  })
  const runJob = (scheduler as unknown as { runJob: RunJobFn }).runJob.bind(scheduler)
  return {
    delivered,
    destroyedCount: () => destroyed,
    run: (job: CronJob, priorFailures = 0) => runJob(job, { id: 'main' }, priorFailures),
  }
}

const baseJob = {
  id: 'test-job',
  schedule: '0 3 * * *',
  agent: 'main',
  prompt: 'do the thing',
  deliver: 'local' as const,
}

describe('CronScheduler.runJob outcomes', () => {
  it('reports failure and alerts when the turn produces nothing', async () => {
    const h = makeScheduler(async () => {
      /* emit nothing — the OAuth-failure shape */
    })

    const outcome = await h.run({ ...baseJob })

    assert.equal(outcome.status, 'failed')
    assert.equal(h.delivered.length, 1, 'a silent local job must still raise an alert')
    assert.match(h.delivered[0].text, /执行失败/)
    assert.equal(h.delivered[0].deliver, 'webchat', "deliver:'local' is overridden for alerts")
    assert.match(h.delivered[0].label ?? '', /⚠️/)
  })

  it('reports failure when submit throws, and still tears the session down', async () => {
    const h = makeScheduler(async () => {
      throw new Error('OAuth session expired and could not be refreshed')
    })

    const outcome = await h.run({ ...baseJob }, 1)

    assert.equal(outcome.status, 'failed')
    assert.match(outcome.error ?? '', /OAuth session expired/)
    assert.equal(h.destroyedCount(), 1, 'session must be destroyed even when submit throws')
    assert.match(h.delivered[0].text, /连续第 2 次/)
  })

  it('suppresses the alert on a run that is past the alert cadence', async () => {
    const h = makeScheduler(async () => {})

    const outcome = await h.run({ ...baseJob }, 3) // 4th consecutive failure

    assert.equal(outcome.status, 'failed')
    assert.equal(h.delivered.length, 0)
  })

  it('stays silent — no alert, no delivery — on an explicit [SILENT]', async () => {
    const h = makeScheduler(async (emit) => emit('[SILENT]'))

    const outcome = await h.run({ ...baseJob })

    assert.equal(outcome.status, 'silent')
    assert.equal(h.delivered.length, 0)
  })

  it('delivers real output for a non-local job', async () => {
    const h = makeScheduler(async (emit) => emit('trained 2 skills'))

    const outcome = await h.run({ ...baseJob, deliver: 'webchat' as const })

    assert.equal(outcome.status, 'ok')
    assert.deepEqual(
      h.delivered.map((d) => d.text),
      ['trained 2 skills'],
    )
  })

  it('does not deliver real output for a local job', async () => {
    const h = makeScheduler(async (emit) => emit('local-only report'))

    const outcome = await h.run({ ...baseJob })

    assert.equal(outcome.status, 'ok')
    assert.equal(h.delivered.length, 0)
  })

  it('does not burn a one-shot job on a failed run', async () => {
    const h = makeScheduler(async () => {
      throw new Error('boom')
    })
    const job = { ...baseJob, id: 'oneshot-fail', oneshot: true, enabled: true }

    const outcome = await h.run(job)

    assert.equal(outcome.status, 'failed')
    assert.notEqual(job.enabled, false, 'a failed run must not consume the single shot')
  })

  it('burns a one-shot job once it actually ran', async () => {
    const h = makeScheduler(async (emit) => emit('reminder fired'))
    const job = { ...baseJob, id: 'oneshot-ok', oneshot: true, enabled: true, deliver: 'local' }

    await h.run(job as never)

    assert.equal(job.enabled, false)
  })

  it('persists the transcript even when the run failed', async () => {
    const h = makeScheduler(async (emit) => {
      emit('partial work before the crash')
      throw new Error('died mid-turn')
    })

    await h.run({ ...baseJob, id: 'evidence-job' })

    const dir = join(TEST_HOME, 'cron', 'outputs')
    const { readdir } = await import('node:fs/promises')
    const files = (await readdir(dir)).filter((f) => f.startsWith('evidence-job-'))
    assert.equal(files.length, 1)
    assert.match(await readFile(join(dir, files[0]), 'utf-8'), /partial work before the crash/)
  })
})
