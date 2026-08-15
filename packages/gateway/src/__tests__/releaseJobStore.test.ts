import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  canTransition,
  isReleaseJobId,
  parseReleaseJobOutput,
  publicReleaseJob,
  readReleaseJob,
  RELEASE_JOB_TRANSITIONS,
} from '../releaseJobStore.js'

const sample = {
  version: 1,
  id: 'rel-20260816T010203Z-aaaaaaaaaaaa',
  phase: 'deploying',
  createdAt: '2026-08-16T01:02:03Z',
  updatedAt: '2026-08-16T01:03:03Z',
  startedAt: '2026-08-16T01:02:03Z',
  finishedAt: null,
  owner: 'agent',
  queueId: 'rq-20260816T010000Z-abcdef123456',
  title: '发布中',
  deployArgs: ['--with-dist'],
  thenSmoke: false,
  deployUnit: 'openclaude-v5-deploy-20260816-010000-deadbeef-with-dist.service',
  smokeUnit: null,
  supervisorPid: 12,
  exitCode: null,
  error: null,
  nextStep: '用 status 查询',
  recallRequired: false,
  entries: [{ at: '2026-08-16T01:02:03Z', phase: 'queued', text: '已登记' }],
  card: {
    kind: 'release_progress',
    runId: 'rel-20260816T010203Z-aaaaaaaaaaaa',
    goal: '发布中',
    entries: [{ phase: 'queued', text: '已登记' }],
    summary: null,
    error: null,
    startTime: '2026-08-16T01:02:03Z',
    completedAt: null,
    _completed: false,
    _isError: false,
    phase: 'deploying',
    nextStep: '用 status 查询',
  },
}

test('job id and transition table stay fail-closed', () => {
  assert.equal(isReleaseJobId(sample.id), true)
  assert.equal(isReleaseJobId('rq-20260816T010000Z-abcdef123456'), false)
  assert.equal(canTransition('queued', 'acquiring_lease'), true)
  assert.equal(canTransition('deploying', 'completed'), true)
  assert.equal(canTransition('deploying', 'queued'), false)
  assert.equal(canTransition('failed', 'deploying'), false)
  assert.deepEqual(RELEASE_JOB_TRANSITIONS.completed, [])
})

test('parseReleaseJobOutput accepts the Bash card marker and rejects junk', () => {
  const parsed = parseReleaseJobOutput(`noise\nOC_RELEASE_JOB_V1\n${JSON.stringify(sample)}\n`)
  assert.equal(parsed?.id, sample.id)
  assert.equal(parsed?.card.kind, 'release_progress')
  assert.equal(parseReleaseJobOutput('hello'), null)
  assert.equal(parseReleaseJobOutput('{"id":"nope"}'), null)
})

test('readReleaseJob refuses path traversal and projects a public card snapshot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-release-job-store-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${sample.id}.json`), JSON.stringify(sample))
    assert.equal(readReleaseJob(dir, '../secret'), null)
    const job = readReleaseJob(dir, sample.id)
    assert.equal(job?.queueId, sample.queueId)
    const pub = publicReleaseJob(job!, Date.parse('2026-08-16T01:04:03Z'))
    assert.equal(pub.phaseLabel, '部署中')
    assert.equal(pub.elapsedMs, 120_000)
    assert.equal(pub.card.runId, sample.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
