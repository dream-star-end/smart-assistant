import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type CronFile,
  type CronJob,
  SKILL_AUTOTRAIN_JOB_ID,
  isDefaultJobId,
  mergeDefaultCronJobs,
} from '../cron.js'

const oldDefault: CronJob = {
  id: 'daily-reflection',
  schedule: '17 3 * * *',
  agent: 'main',
  prompt: 'old default',
}

const autoTrainDefault: CronJob = {
  id: SKILL_AUTOTRAIN_JOB_ID,
  schedule: '52 2 * * *',
  agent: 'main',
  prompt: 'auto train',
  deliver: 'local',
}

const DEFAULTS = [oldDefault, autoTrainDefault]

describe('mergeDefaultCronJobs — migration of pre-disabledDefaults files', () => {
  it('freezes the current state instead of resurrecting absent defaults', () => {
    // A legacy file: the user kept skill-autotrain and removed daily-reflection.
    // That removal exists only as absence, so it must become an explicit
    // tombstone — and no job may start running as a side effect of the upgrade.
    const existing: CronFile = {
      jobs: [
        { id: 'custom', schedule: '0 9 * * *', agent: 'main', prompt: 'custom' },
        autoTrainDefault,
      ],
    }

    const merged = mergeDefaultCronJobs(existing, DEFAULTS)

    assert.equal(merged.changed, true)
    assert.deepEqual(
      merged.file.jobs.map((job) => job.id),
      ['custom', SKILL_AUTOTRAIN_JOB_ID],
      'migration must not add or remove any job',
    )
    assert.deepEqual(merged.file.disabledDefaults, ['daily-reflection'])
  })

  it('tombstones every default when the user deleted them all', () => {
    const merged = mergeDefaultCronJobs({ jobs: [] }, DEFAULTS)

    assert.equal(merged.changed, true)
    assert.deepEqual(merged.file.jobs, [])
    assert.deepEqual(merged.file.disabledDefaults, ['daily-reflection', SKILL_AUTOTRAIN_JOB_ID])
  })

  it('is a no-op on the second pass (migration is idempotent)', () => {
    const once = mergeDefaultCronJobs({ jobs: [autoTrainDefault] }, DEFAULTS)
    const twice = mergeDefaultCronJobs(once.file, DEFAULTS)

    assert.equal(twice.changed, false)
    assert.deepEqual(twice.file.jobs, once.file.jobs)
    assert.deepEqual(twice.file.disabledDefaults, ['daily-reflection'])
  })
})

describe('mergeDefaultCronJobs — steady state', () => {
  it('adds a genuinely new default without editing an allowlist', () => {
    // The point of the rewrite: a default that is neither present nor tombstoned
    // installs itself. Previously this required hand-editing a Set, and a
    // forgotten edit was indistinguishable from a user deletion.
    const existing: CronFile = { jobs: [autoTrainDefault], disabledDefaults: [] }

    const merged = mergeDefaultCronJobs(existing, DEFAULTS)

    assert.equal(merged.changed, true)
    assert.deepEqual(
      merged.file.jobs.map((job) => job.id),
      [SKILL_AUTOTRAIN_JOB_ID, 'daily-reflection'],
    )
  })

  it('never re-adds a default the user explicitly removed', () => {
    const existing: CronFile = {
      jobs: [autoTrainDefault],
      disabledDefaults: ['daily-reflection'],
    }

    const merged = mergeDefaultCronJobs(existing, DEFAULTS)

    assert.equal(merged.changed, false)
    assert.equal(merged.file, existing)
  })

  it('preserves a user-customized copy of a default job', () => {
    const userJob: CronJob = {
      id: SKILL_AUTOTRAIN_JOB_ID,
      schedule: '0 5 * * *',
      agent: 'coder',
      prompt: 'user customized',
      enabled: false,
    }
    const existing: CronFile = { jobs: [userJob], disabledDefaults: ['daily-reflection'] }

    const merged = mergeDefaultCronJobs(existing, DEFAULTS)

    assert.equal(merged.changed, false)
    assert.deepEqual(merged.file.jobs, [userJob])
  })

  it('clones appended defaults so callers cannot mutate the template', () => {
    const merged = mergeDefaultCronJobs({ jobs: [], disabledDefaults: [] }, DEFAULTS)
    const appended = merged.file.jobs.find((job) => job.id === 'daily-reflection')

    assert.ok(appended)
    assert.notEqual(appended, oldDefault)
    appended.prompt = 'mutated'
    assert.equal(oldDefault.prompt, 'old default')
  })
})

describe('isDefaultJobId', () => {
  it('recognizes built-in ids and rejects user-created ones', () => {
    assert.equal(isDefaultJobId(SKILL_AUTOTRAIN_JOB_ID, DEFAULTS), true)
    assert.equal(isDefaultJobId('daily-reflection', DEFAULTS), true)
    assert.equal(isDefaultJobId('remind-mpfy6eth-v1sj', DEFAULTS), false)
  })

  it('recognizes the real shipped defaults without an explicit list', () => {
    assert.equal(isDefaultJobId(SKILL_AUTOTRAIN_JOB_ID), true)
    assert.equal(isDefaultJobId('heartbeat'), true)
    assert.equal(isDefaultJobId('not-a-default'), false)
  })
})
