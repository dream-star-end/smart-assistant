import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { readTaskboardDelegateBody, TaskboardBodyTimeoutError } from '../delegateBody.js'
import { TaskboardCancelledError, TaskboardRunControls } from '../runControl.js'

test('a never ending signed request body cannot keep Stop waiting for a pending child', async () => {
  const registry = new TaskboardRunControls()
  const control = registry.begin('run-body', 'ticket', 'owner', 'root-body')
  const leaveRoot = control.enter('root-body')
  const leavePending = control.enterPending('root-body')
  const req = Object.assign(new EventEmitter(), { complete: false, destroyed: false, destroy() { this.destroyed = true; this.emit('aborted') } })
  const body = readTaskboardDelegateBody(req as unknown as IncomingMessage, () => new Promise(() => {}), control).finally(leavePending)
  control.requestStop()
  await assert.rejects(body, TaskboardCancelledError)
  await control.waitForDescendants('root-body')
  assert.equal(req.destroyed, true)
  assert.equal(req.listenerCount('aborted'), 0)
  leaveRoot(); registry.finish(control)
})

test('normal completion also has a bounded request body deadline', async () => {
  const registry = new TaskboardRunControls()
  const control = registry.begin('run-body-timeout', 'ticket', 'owner', 'root-body-timeout')
  const req = Object.assign(new EventEmitter(), { complete: false, destroy() {} })
  // Keep the event loop alive as a real socket would while the helper's timer is unref'd.
  const socket = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(readTaskboardDelegateBody(req as unknown as IncomingMessage, () => new Promise(() => {}), control, 10), TaskboardBodyTimeoutError)
  } finally { clearTimeout(socket); registry.finish(control) }
})
