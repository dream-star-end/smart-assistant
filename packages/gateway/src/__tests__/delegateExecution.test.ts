import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runDelegateExecution } from '../delegateExecution.js'
import { RunLog } from '../runLog.js'

function setup() {
  const runLog = new RunLog()
  const runEntry = runLog.start({
    agentId: 'main',
    sessionKey: 'agent:main:delegate:test:1',
    taskType: 'delegate',
  })
  let active = 1
  const completed: Array<{ output: string; error: string }> = []
  return {
    runLog,
    runEntry,
    completed,
    active: () => active,
    releaseActive: () => {
      active--
    },
  }
}

describe('runDelegateExecution', () => {
  it('captures text output, marks success, emits completion, and releases active slot', async () => {
    const ctx = setup()

    const result = await runDelegateExecution({
      agentId: 'main',
      sessionKey: ctx.runEntry.sessionKey,
      runLog: ctx.runLog,
      runEntry: ctx.runEntry,
      submit: async (onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'training done' } })
      },
      emitCompleted: (r) => ctx.completed.push(r),
      cleanup: async () => ctx.releaseActive(),
    })

    assert.deepEqual(result, { output: 'training done', error: '' })
    assert.equal(ctx.runEntry.status, 'completed')
    assert.equal(ctx.runEntry.outputPreview, 'training done')
    assert.equal(ctx.completed[0]?.output, 'training done')
    assert.equal(ctx.active(), 0)
  })

  it('marks error events as failed and keeps output preview', async () => {
    const ctx = setup()

    await runDelegateExecution({
      agentId: 'main',
      sessionKey: ctx.runEntry.sessionKey,
      runLog: ctx.runLog,
      runEntry: ctx.runEntry,
      submit: async (onEvent) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'partial output' } })
        onEvent({ kind: 'error', error: 'model failed' })
      },
      emitCompleted: (r) => ctx.completed.push(r),
      cleanup: async () => ctx.releaseActive(),
    })

    assert.equal(ctx.runEntry.status, 'failed')
    assert.equal(ctx.runEntry.error, 'model failed')
    assert.equal(ctx.runEntry.outputPreview, 'partial output')
    assert.equal(ctx.completed[0]?.error, 'model failed')
    assert.equal(ctx.active(), 0)
  })

  it('marks thrown submit errors as failed and releases active slot', async () => {
    const ctx = setup()

    await runDelegateExecution({
      agentId: 'main',
      sessionKey: ctx.runEntry.sessionKey,
      runLog: ctx.runLog,
      runEntry: ctx.runEntry,
      submit: async () => {
        throw new Error('submit exploded')
      },
      emitCompleted: (r) => ctx.completed.push(r),
      cleanup: async () => ctx.releaseActive(),
    })

    assert.equal(ctx.runEntry.status, 'failed')
    assert.match(ctx.runEntry.error ?? '', /submit exploded/)
    assert.equal(ctx.completed[0]?.error, 'Error: submit exploded')
    assert.equal(ctx.active(), 0)
  })
})
