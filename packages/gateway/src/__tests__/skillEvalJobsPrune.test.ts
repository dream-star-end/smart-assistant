// S-02 wiring: SkillEvalJobStore.prune drops aged terminal runs from memory AND disk,
// while sparing active runs and the newest-per-skill keep-floor. Dynamic import so the
// temp OPENCLAUDE_HOME is frozen into paths before the store module evaluates.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-skilljob-'))
process.env.OPENCLAUDE_HOME = home
const { SkillEvalJobStore } = await import('../skillEvalJobs.js')
const { paths } = await import('@openclaude/storage')

after(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('SkillEvalJobStore.prune · S-02', () => {
  it('evicts aged terminal runs (memory + disk), keeps active and newest-per-skill', async () => {
    // Pre-create the evals root so persist's realpath containment is consistent on
    // Windows (the store realpaths the root before its first mkdir).
    const { mkdir } = await import('node:fs/promises')
    await mkdir(paths.skillEvalsDir, { recursive: true })
    const store = new SkillEvalJobStore({
      maxConcurrent: 5,
      retentionMs: 1000,
      keepPerSkill: 1,
      maxEntries: 100,
    })
    const now = Date.now()
    const mk = (skillName: string, startedAt: number) =>
      store.create({
        runId: SkillEvalJobStore.newRunId(),
        skillName,
        userId: 'u',
        mode: 'baseline',
        model: 'm',
        cases: [],
        now: startedAt,
      })

    const old = await mk('s', now - 10_000)
    await store.finish(old, now - 9_000, {})
    const fresh = await mk('s', now - 8_000) // newest terminal for skill 's' → protected by keepPerSkill=1
    await store.finish(fresh, now - 7_000, {})
    const active = await mk('s2', now) // queued/active → never evictable

    // Disk persistence is best-effort and has a known Windows realpath quirk (see the
    // pre-existing durability tests); gate the disk assertions on it having worked, but
    // always assert the guaranteed in-memory eviction.
    const oldDirExisted = existsSync(join(paths.skillEvalRunDir(old.runId), 'run.json'))

    const evicted = store.prune(now)
    await new Promise((r) => setTimeout(r, 50)) // let async _rmRunDir settle

    assert.equal(evicted, 1)
    assert.equal(store.get(old.runId), undefined, 'aged terminal evicted from memory')
    assert.ok(store.get(fresh.runId), 'newest-per-skill kept')
    assert.ok(store.get(active.runId), 'active kept')
    if (oldDirExisted) {
      assert.equal(
        existsSync(paths.skillEvalRunDir(old.runId)),
        false,
        'aged run dir removed from disk',
      )
      assert.equal(
        existsSync(paths.skillEvalRunDir(fresh.runId)),
        true,
        'kept run dir stays on disk',
      )
    }
  })
})
