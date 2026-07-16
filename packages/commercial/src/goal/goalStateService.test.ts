import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GoalStateError, resolveGoalTransition } from './goalStateService.js'

describe('GoalState state machine', () => {
  it('accepts the specified transitions and idempotent repeats', () => {
    assert.deepEqual(resolveGoalTransition('active', 'pause'), { target: 'paused', idempotent: false })
    assert.deepEqual(resolveGoalTransition('paused', 'pause'), { target: 'paused', idempotent: true })
    assert.deepEqual(resolveGoalTransition('blocked', 'resume'), { target: 'active', idempotent: false })
    assert.deepEqual(resolveGoalTransition('active', 'resume'), { target: 'active', idempotent: true })
    assert.deepEqual(resolveGoalTransition('paused', 'complete'), { target: 'completed', idempotent: false })
  })

  it('rejects illegal transitions', () => {
    assert.throws(() => resolveGoalTransition('completed', 'resume'), GoalStateError)
    assert.throws(() => resolveGoalTransition('cleared', 'pause'), GoalStateError)
    assert.throws(() => resolveGoalTransition('completed', 'block'), (err) => {
      assert.ok(err instanceof GoalStateError)
      assert.equal(err.code, 'CONFLICT')
      return true
    })
  })
})
