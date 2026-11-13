import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskboardCancelledError, TaskboardRunControls } from '../runControl.js'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('root waits for descendant full finally, including signed HTTP preparation and grandchildren', async () => {
  const registry = new TaskboardRunControls()
  const control = registry.begin('run', 'ticket', 'owner', 'root')
  const rootDone = control.enter('root')
  const httpDone = control.enterPending('root')
  const childDone = control.enter('child', 'root')
  const grandchildDone = control.enter('grandchild', 'child')
  let rootSettled = false
  const rootWait = control.waitForDescendants('root').then(() => { rootSettled = true })
  assert.throws(() => control.enterPending('root'), TaskboardCancelledError)
  await flush(); assert.equal(rootSettled, false)
  httpDone(); childDone()
  await flush(); assert.equal(rootSettled, false)
  grandchildDone()
  await rootWait
  rootDone()
  registry.finish(control)
  assert.equal(registry.lookup('root')?.closed, true)
  assert.equal(registry.lookup('child')?.control, null)
  assert.equal(registry.get('run', 'ticket', 'owner'), undefined)
})

test('stop fences late descendants and wrong run/lease cannot address the controller', async () => {
  const registry = new TaskboardRunControls()
  const control = registry.begin('run', 'ticket', 'owner', 'root')
  const leave = control.enter('root')
  assert.equal(registry.get('run', 'other-ticket', 'owner'), undefined)
  assert.equal(registry.get('run', 'ticket', 'other-owner'), undefined)
  assert.equal(control.requestStop(), true)
  assert.equal(control.requestStop(), false)
  assert.equal(control.signal.aborted, true)
  assert.throws(() => control.enter('late', 'root'), TaskboardCancelledError)
  assert.throws(() => control.enterPending('root'), TaskboardCancelledError)
  assert.throws(() => registry.finish(control), /active promises/)
  leave(); leave()
  registry.finish(control)
  assert.equal(registry.lookup('root')?.closed, true)
})


test('a completed resumable child can start another execution while its real parent remains open', () => {
  const registry = new TaskboardRunControls()
  const control = registry.begin('resume-run', 'ticket', 'owner', 'resume-root')
  const leaveRoot = control.enter('resume-root')
  const first = control.enter('resume-child', 'resume-root')
  control.recordResult({ executionId: 'execution-1', sessionKey: 'resume-child', agentId: 'worker', output: 'first paid output', tokensIn: 3, costUsd: 0.1 })
  first()
  const second = control.enter('resume-child', 'resume-root')
  control.recordResult({ executionId: 'execution-2', sessionKey: 'resume-child', agentId: 'worker', output: 'second paid output', tokensIn: 2, costUsd: 0.05 })
  assert.throws(() => control.enter('resume-child', 'resume-root'), TaskboardCancelledError)
  second()
  assert.deepEqual(control.childResults().map((item) => item.output), ['first paid output', 'second paid output'])
  leaveRoot(); registry.finish(control)
})
