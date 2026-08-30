/**
 * Cursor MCP delegate_wait: one 55s round, running is not a failure,
 * missing jobId is not_found, wait does not start a job.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateWaitMcp.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatDelegateSuccess } from '../delegateCursorFastPath.js'
import {
  DEFAULT_MCP_DELEGATE_WAIT_MS,
  MAX_MCP_DELEGATE_WAIT_MS,
  mcpDelegateWaitHttpTimeoutMs,
  resolveMcpDelegateWaitMs,
  runMcpDelegateWait,
} from '../delegateWaitMcp.js'

function doneBody(jobId: string, output: string): string {
  return JSON.stringify({
    status: 'done',
    jobId,
    httpStatus: 200,
    ok: true,
    output,
  })
}

describe('resolveMcpDelegateWaitMs', () => {
  it('defaults to 55s and clamps to 250ms..55s (under the 60s tools/call wall)', () => {
    assert.equal(resolveMcpDelegateWaitMs(undefined), DEFAULT_MCP_DELEGATE_WAIT_MS)
    assert.equal(resolveMcpDelegateWaitMs(1), 250)
    assert.equal(resolveMcpDelegateWaitMs(999_999), MAX_MCP_DELEGATE_WAIT_MS)
    assert.equal(resolveMcpDelegateWaitMs(12_000), 12_000)
    assert.equal(mcpDelegateWaitHttpTimeoutMs(55_000), 58_000)
    assert.ok(mcpDelegateWaitHttpTimeoutMs(55_000) < 60_000)
  })
})

describe('runMcpDelegateWait', () => {
  it('terminal job returns immediately with the result (not isError)', async () => {
    let calls = 0
    const r = await runMcpDelegateWait({
      jobId: 'dlgjob-done',
      waitMs: 55_000,
      waitOnce: async (jobId, waitMs) => {
        calls++
        assert.equal(jobId, 'dlgjob-done')
        assert.equal(waitMs, 55_000)
        return { statusCode: 200, body: doneBody(jobId, '审查通过') }
      },
    })
    assert.equal(calls, 1)
    assert.equal(r.isError, false)
    assert.equal(r.status, 'done')
    assert.equal(r.text, formatDelegateSuccess('dlgjob-done', '审查通过'))
  })

  it('55s timeout still running → status=running, isError=false (not job failure)', async () => {
    const waits: number[] = []
    const r = await runMcpDelegateWait({
      jobId: 'dlgjob-slow',
      waitOnce: async (jobId, waitMs) => {
        waits.push(waitMs)
        return { statusCode: 200, body: JSON.stringify({ status: 'running', jobId }) }
      },
    })
    assert.deepEqual(waits, [55_000])
    assert.equal(r.isError, false)
    assert.equal(r.status, 'running')
    assert.equal(r.jobId, 'dlgjob-slow')
    assert.match(r.text, /^status=running jobId=dlgjob-slow/)
    assert.match(r.text, /不是失败/)
    assert.match(r.text, /oc-memory delegate-wait dlgjob-slow/)
    assert.doesNotMatch(r.text, /委派失败/)
  })

  it('unknown jobId is not_found immediately, does not hang', async () => {
    let calls = 0
    const r = await runMcpDelegateWait({
      jobId: 'dlgjob-nope',
      waitMs: 55_000,
      waitOnce: async (jobId) => {
        calls++
        return {
          statusCode: 404,
          body: JSON.stringify({
            status: 'expired',
            jobId,
            error: 'delegate job not found or expired',
          }),
        }
      },
    })
    assert.equal(calls, 1)
    assert.equal(r.isError, true)
    assert.equal(r.status, 'not_found')
    assert.match(r.text, /status=not_found jobId=dlgjob-nope/)
  })

  it('missing jobId is not_found without calling waitOnce', async () => {
    let calls = 0
    const r = await runMcpDelegateWait({
      jobId: '   ',
      waitOnce: async () => {
        calls++
        return { statusCode: 500, body: '{}' }
      },
    })
    assert.equal(calls, 0)
    assert.equal(r.status, 'not_found')
    assert.match(r.text, /status=not_found/)
  })

  it('wait is wait-only: never starts a job and does not occupy capacity', async () => {
    const starts: string[] = []
    const waits: Array<{ urlHint: string; jobId: string; waitMs: number }> = []
    const r = await runMcpDelegateWait({
      jobId: 'dlgjob-cap',
      waitMs: 999_999,
      waitOnce: async (jobId, waitMs) => {
        waits.push({ urlHint: '/api/delegate/wait', jobId, waitMs })
        return { statusCode: 200, body: JSON.stringify({ status: 'queued', jobId }) }
      },
    })
    assert.equal(starts.length, 0, 'wait must not enqueue /api/agents/*/delegate')
    assert.equal(waits.length, 1)
    assert.equal(waits[0].urlHint, '/api/delegate/wait')
    assert.equal(waits[0].waitMs, 55_000, 'oversize waitMs is clamped; cannot occupy a 60s call')
    assert.equal(r.isError, false)
    assert.equal(r.status, 'running')
  })
})
