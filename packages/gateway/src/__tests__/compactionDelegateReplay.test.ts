import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DelegateJobStore } from '../delegateJobs.js'
import { DelegateResumeRegistry, delegateTaskKey } from '../delegateResume.js'
import { compactionDelegateTasks } from '../compactionTasks.js'

const fresh = (goal = '实现子任务') => ({
  parentSessionKey: 'parent', targetAgentId: 'auditor', sourceAgent: 'main',
  taskKey: delegateTaskKey({ goal, model: 'gpt-5.6-sol' }),
})

// Acceptance GAP-D2 (#1309): the real fresh body has no key, so the registry
// granted a second dispatch for the same in-flight task.
test('GAP-D2: a fresh request repeating an in-flight task replays its job instead of dispatching', () => {
  const registry = new DelegateResumeRegistry()
  const jobs = new DelegateJobStore({ sm: true })
  try {
    const first = registry.preflight(fresh())
    assert.ok(first.ok && first.dispatchGranted)
    const created = jobs.create('auditor', { sessionKey: first.sessionKey, parentSessionKey: 'parent' })
    assert.ok('jobId' in created)
    registry.bindJob(first.sessionKey, undefined, created.jobId)
    assert.equal(compactionDelegateTasks(jobs.listNonTerminal(), 'parent')[0]?.id, created.jobId)
    const again = registry.preflight(fresh())
    assert.ok(again.ok)
    assert.equal(again.dispatchGranted, false)
    assert.equal(again.jobId, created.jobId)
    assert.equal(registry.dispatchGrants, 1)
    assert.ok(registry.preflight(fresh('另一个子任务')).dispatchGranted, 'a different task dispatches')
    registry.release(first.sessionKey)
    assert.ok(registry.preflight(fresh()).dispatchGranted, 'a finished task may run again')
  } finally { jobs.close() }
})

test('task replay never crosses parent, target, source or a retiring session', () => {
  const registry = new DelegateResumeRegistry()
  const first = registry.preflight(fresh())
  assert.ok(first.ok)
  for (const changed of [{ parentSessionKey: 'other' }, { targetAgentId: 'coder' }, { sourceAgent: 'other' }, { parentSessionKey: '' }]) {
    assert.ok(registry.preflight({ ...fresh(), ...changed }).dispatchGranted)
  }
  registry.markRetiring(first.sessionKey)
  assert.ok(registry.preflight(fresh()).dispatchGranted)
})

test('a resumed session no longer answers for its original fresh task', () => {
  const registry = new DelegateResumeRegistry()
  const first = registry.preflight(fresh())
  assert.ok(first.ok)
  registry.release(first.sessionKey)
  const resumed = registry.preflight({ ...fresh(), taskKey: undefined, resumeSessionKey: first.sessionKey })
  assert.ok(resumed.ok && resumed.dispatchGranted)
  assert.ok(registry.preflight(fresh()).dispatchGranted)
})
