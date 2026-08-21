/**
 * oc-memory delegate-wait loop: long-poll until all jobs finish or expire.
 * Short constants; fake waitOnce, no real 45s.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateWaitCli.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isTransientDelegateWaitError, runDelegateWaitLoop } from '../delegateWaitCli.js'

function doneBody(jobId: string, output: string): string {
  return JSON.stringify({
    status: 'done',
    jobId,
    httpStatus: 200,
    ok: true,
    output,
  })
}

describe('runDelegateWaitLoop', () => {
  it('waits through a running poll then prints the final result', async () => {
    const calls: string[] = []
    let n = 0
    const r = await runDelegateWaitLoop({
      jobIds: ['dlgjob-1'],
      pollWaitMs: 20,
      waitOnce: async (jobId) => {
        calls.push(jobId)
        n++
        if (n === 1) {
          return { statusCode: 200, body: JSON.stringify({ status: 'running', jobId }) }
        }
        return { statusCode: 200, body: doneBody(jobId, '修好了') }
      },
    })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(r.stdout, /修好了/)
    assert.equal(calls.length, 2)
  })

  it('waits multiple jobIds in one command and aggregates', async () => {
    const remaining = new Set(['dlgjob-a', 'dlgjob-b'])
    const r = await runDelegateWaitLoop({
      jobIds: ['dlgjob-a', 'dlgjob-b'],
      pollWaitMs: 20,
      waitOnce: async (jobId) => {
        remaining.delete(jobId)
        return { statusCode: 200, body: doneBody(jobId, `out-${jobId}`) }
      },
    })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(r.stdout, /2 成功 \/ 0 失败/)
    assert.match(r.stdout, /out-dlgjob-a/)
    assert.match(r.stdout, /out-dlgjob-b/)
    assert.equal(remaining.size, 0)
  })

  it('TTL expired → exit 2 with readable error', async () => {
    const r = await runDelegateWaitLoop({
      jobIds: ['dlgjob-gone'],
      pollWaitMs: 20,
      waitOnce: async (jobId) => ({
        statusCode: 404,
        body: JSON.stringify({
          status: 'expired',
          jobId,
          error: 'delegate job not found or expired',
        }),
      }),
    })
    assert.equal(r.exitCode, 2)
    assert.match(r.stdout, /expired/)
  })

  it('keeps waiting through repeated running views until the job completes', async () => {
    let waitCalls = 0
    const r = await runDelegateWaitLoop({
      jobIds: ['dlgjob-slow'],
      pollWaitMs: 30,
      sleep: async () => {},
      waitOnce: async (jobId) => {
        waitCalls++
        if (waitCalls === 4) {
          return { statusCode: 200, body: doneBody(jobId, '长任务完成') }
        }
        return { statusCode: 200, body: JSON.stringify({ status: 'running', jobId }) }
      },
    })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(r.stdout, /长任务完成/)
    assert.equal(waitCalls, 4)
  })

  it('one long-poll transport timeout → keep waiting, do not fail the CLI', async () => {
    assert.equal(
      isTransientDelegateWaitError(Object.assign(new Error('delegate client timeout after 45s'), { code: 'ETIMEDOUT' })),
      true,
    )
    let n = 0
    const r = await runDelegateWaitLoop({
      jobIds: ['dlgjob-blip'],
      pollWaitMs: 20,
      waitOnce: async (jobId) => {
        n++
        if (n === 1) {
          const err: Error & { code?: string } = new Error('delegate client timeout after 45s')
          err.code = 'ETIMEDOUT'
          throw err
        }
        return { statusCode: 200, body: doneBody(jobId, '仍在，已完成') }
      },
    })
    assert.equal(r.exitCode, 0, r.stderr)
    assert.match(r.stdout, /仍在，已完成/)
    assert.equal(n, 2)
  })

  it('missing jobIds → exit 1', async () => {
    const r = await runDelegateWaitLoop({
      jobIds: ['  '],
      pollWaitMs: 20,
      waitOnce: async () => ({ statusCode: 500, body: '{}' }),
    })
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /requires at least one/)
  })
})
