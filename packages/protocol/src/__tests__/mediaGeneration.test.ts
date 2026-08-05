import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Value } from '@sinclair/typebox/value'

import { AnyFrame } from '../frames.js'
import { MediaGenerationJobSchema, VideoProjectSchema } from '../mediaGeneration.js'

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  requestId: 'request-1',
  kind: 'h3_generate',
  resourceClass: 'gpu-h3',
  status: 'running',
  phase: 'sampling',
  currentStep: 7,
  totalSteps: 20,
  queuePosition: null,
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:01.000Z',
}

describe('media generation protocol', () => {
  test('accepts durable progress and master-authored media job frames', () => {
    assert.equal(Value.Check(MediaGenerationJobSchema, job), true)
    assert.equal(Value.Check(AnyFrame, { type: 'sys.media_job', job, ts: 1 }), true)
    assert.equal(Value.Check(MediaGenerationJobSchema, { ...job, status: 'invented' }), false)
  })

  test('projects expose unresolved stale continuity instead of projecting ready', () => {
    const project = {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'minute project',
      rev: 3,
      status: 'needs_review',
      currentComposeJobId: null,
      shots: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          ordinal: 1,
          prompt: 'continue',
          durationSeconds: 10,
          activeJobId: job.id,
          activeJob: job,
          stale: true,
        },
      ],
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:01.000Z',
    }
    assert.equal(Value.Check(VideoProjectSchema, project), true)
  })
})
