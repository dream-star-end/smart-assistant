/**
 * Cursor delegate fast path: 45s-window complete vs timeout→jobId, plus wait
 * interpreting a later final result and TTL expiry. Uses short constants.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateCursorFastPath.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatDelegateFanoutRunning,
  formatDelegateSuccess,
  interpretDelegateStartBody,
  interpretDelegateWaitBody,
  resolveCursorFastWaitMs,
  runCursorDelegateFastPath,
} from '../delegateCursorFastPath.js'

describe('resolveCursorFastWaitMs', () => {
  it('defaults to 45s and clamps to 5s..55s', () => {
    assert.equal(resolveCursorFastWaitMs({}), 45_000)
    assert.equal(resolveCursorFastWaitMs({ OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS: '10' }), 5_000)
    assert.equal(
      resolveCursorFastWaitMs({ OPENCLAUDE_DELEGATE_CURSOR_FAST_WAIT_MS: '999999' }),
      55_000,
    )
  })
})

describe('runCursorDelegateFastPath', () => {
  it('fast path: job finishes inside the wait window → same success text as today', async () => {
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'coding-assistant',
      transport: {
        start: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-1', agentId: 'coding-assistant' }),
        }),
        wait: async () => ({
          statusCode: 200,
          body: JSON.stringify({
            status: 'done',
            jobId: 'dlgjob-1',
            httpStatus: 200,
            ok: true,
            agentId: 'coding-assistant',
            output: '修复完成',
          }),
        }),
      },
    })
    assert.equal(r.kind, 'ok')
    assert.equal(r.text, formatDelegateSuccess('coding-assistant', '修复完成'))
    assert.match(r.text, /^✅ 委派完成 \(agent: coding-assistant\)\n\n修复完成$/)
  })

  it('timeout: still running → jobId + oc-memory delegate-wait instruction', async () => {
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'coding-assistant',
      goal: '修一个慢 bug',
      transport: {
        start: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-slow', agentId: 'coding-assistant' }),
        }),
        wait: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-slow' }),
        }),
      },
    })
    assert.equal(r.kind, 'running')
    if (r.kind !== 'running') return
    assert.equal(r.jobId, 'dlgjob-slow')
    assert.match(r.text, /status=running jobId=dlgjob-slow/)
    assert.match(r.text, /oc-memory delegate-wait dlgjob-slow/)
    assert.match(r.text, /不要重复调用 delegate_task/)
    assert.match(r.text, /不要轮询 MCP/)
  })

  it('wait later returns the final result (CLI/long-poll shape)', async () => {
    let waits = 0
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'main',
      transport: {
        start: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-2' }),
        }),
        wait: async () => {
          waits++
          return {
            statusCode: 200,
            body: JSON.stringify({
              status: 'done',
              jobId: 'dlgjob-2',
              httpStatus: 200,
              ok: true,
              output: '最终结果',
            }),
          }
        },
      },
    })
    assert.equal(waits, 1)
    assert.equal(r.kind, 'ok')
    assert.match(r.text, /最终结果/)
  })

  it('TTL expired → error, not a fake success', async () => {
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'main',
      transport: {
        start: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-gone' }),
        }),
        wait: async () => ({
          statusCode: 404,
          body: JSON.stringify({
            status: 'expired',
            jobId: 'dlgjob-gone',
            error: 'delegate job not found or expired',
          }),
        }),
      },
    })
    assert.equal(r.kind, 'error')
    assert.match(r.text, /expired/)
  })
})

describe('interpret helpers', () => {
  it('start rejects HTTP errors the same way as sync 委派失败', () => {
    const r = interpretDelegateStartBody(429, '{"error":"too many"}')
    assert.ok('error' in r)
    if ('error' in r) assert.match(r.error, /委派失败/)
  })

  it('wait running / done / expired', () => {
    assert.deepEqual(
      interpretDelegateWaitBody(200, JSON.stringify({ status: 'running', jobId: 'j1' })),
      { kind: 'running', jobId: 'j1' },
    )
    const done = interpretDelegateWaitBody(
      200,
      JSON.stringify({ status: 'done', jobId: 'j1', httpStatus: 200, ok: true, output: 'x' }),
    )
    assert.equal(done.kind, 'result')
    const expired = interpretDelegateWaitBody(
      404,
      JSON.stringify({ status: 'expired', jobId: 'j1', error: 'gone' }),
    )
    assert.equal(expired.kind, 'expired')
  })
})

describe('formatDelegateFanoutRunning', () => {
  it('lists unfinished jobIds and a single delegate-wait command', () => {
    const text = formatDelegateFanoutRunning([
      {
        label: 'coder',
        goal: 'fast',
        isError: false,
        text: '✅ 委派完成 (agent: coder)\n\nok',
      },
      {
        label: 'research',
        goal: 'slow',
        isError: false,
        text: '',
        running: true,
        jobId: 'dlgjob-a',
      },
      {
        label: 'office',
        goal: 'also slow',
        isError: false,
        text: '',
        running: true,
        jobId: 'dlgjob-b',
      },
    ])
    assert.match(text, /1 已完成 \/ 2 仍在运行/)
    assert.match(text, /oc-memory delegate-wait dlgjob-a dlgjob-b/)
    assert.match(text, /不要重复调用 delegate_tasks/)
    assert.match(text, /不要轮询 MCP/)
    assert.match(text, /✅ coder/)
  })
})
