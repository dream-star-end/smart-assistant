import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type CronFile,
  type CronJob,
  SKILL_AUTOTRAIN_JOB_ID,
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

describe('mergeDefaultCronJobs', () => {
  it('appends exactly skill-autotrain when it is missing', () => {
    const existing: CronFile = {
      jobs: [{ id: 'custom', schedule: '0 9 * * *', agent: 'main', prompt: 'custom' }],
    }

    const merged = mergeDefaultCronJobs(existing, [oldDefault, autoTrainDefault])

    assert.equal(merged.changed, true)
    assert.deepEqual(
      merged.file.jobs.map((job) => job.id),
      ['custom', SKILL_AUTOTRAIN_JOB_ID],
    )
    assert.equal(merged.file.jobs[1]?.prompt, 'auto train')
  })

  it('does not re-add old default jobs that the user deleted', () => {
    const merged = mergeDefaultCronJobs({ jobs: [] }, [oldDefault, autoTrainDefault])

    assert.equal(merged.changed, true)
    assert.deepEqual(
      merged.file.jobs.map((job) => job.id),
      [SKILL_AUTOTRAIN_JOB_ID],
    )
  })

  it('is idempotent and preserves a user-defined skill-autotrain job', () => {
    const userJob: CronJob = {
      id: SKILL_AUTOTRAIN_JOB_ID,
      schedule: '0 5 * * *',
      agent: 'coder',
      prompt: 'user customized',
      enabled: false,
    }
    const existing: CronFile = { jobs: [userJob] }

    const merged = mergeDefaultCronJobs(existing, [oldDefault, autoTrainDefault])

    assert.equal(merged.changed, false)
    assert.equal(merged.file, existing)
    assert.deepEqual(merged.file.jobs, [userJob])
  })
})
