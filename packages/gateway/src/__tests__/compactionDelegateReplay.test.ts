import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateResumeRegistry } from '../delegateResume.js'
import { compactionDelegateTasks } from '../compactionTasks.js'

test('recovery retains job identities and replays an exact active attempt without dispatch', () => {
  const registry = new DelegateResumeRegistry()
  const jobs = new DelegateJobStore({ sm: true })
  const input = { parentSessionKey: 'parent', targetAgentId: 'auditor', sourceAgent: 'main', idempotencyKey: 'original-attempt' }
  const first = registry.preflight(input)
  assert.ok(first.ok && first.dispatchGranted)
  const created = jobs.create('auditor', { sessionKey: first.sessionKey, parentSessionKey: 'parent', idempotencyKey: input.idempotencyKey })
  assert.ok('jobId' in created)
  registry.bindJob(first.sessionKey, input.idempotencyKey, created.jobId)
  try {
    const tasks = compactionDelegateTasks(jobs.listNonTerminal(), 'parent')
    assert.equal(tasks[0]?.id, created.jobId)
    assert.equal(tasks[0]?.sessionKey, first.sessionKey)
    assert.equal(tasks[0]?.idempotencyKey, input.idempotencyKey)
    const replay = registry.preflight({ ...input, recoverActiveAttempt: true })
    assert.ok(replay.ok)
    assert.equal(replay.dispatchGranted, false)
    assert.equal(replay.jobId, created.jobId)
    assert.equal(registry.dispatchGrants, 1)
    assert.deepEqual(compactionDelegateTasks(jobs.listNonTerminal(), 'other-parent'), [])
    const different = registry.preflight({ ...input, idempotencyKey: 'new-attempt', recoverActiveAttempt: true })
    assert.ok(different.ok && different.dispatchGranted)
  } finally { jobs.close() }
})

test('recovery never reuses an attempt from another parent/source/target', () => {
  const registry = new DelegateResumeRegistry()
  const first = { parentSessionKey: 'a', targetAgentId: 'auditor', sourceAgent: 'main', idempotencyKey: 'same-key', recoverActiveAttempt: true }
  registry.preflight(first)
  for (const changed of [{ parentSessionKey: 'b' }, { targetAgentId: 'coder' }, { sourceAgent: 'other' }]) {
    const result = registry.preflight({ ...first, ...changed })
    assert.ok(result.ok && result.dispatchGranted)
  }
  assert.equal(registry.dispatchGrants, 4)
})
