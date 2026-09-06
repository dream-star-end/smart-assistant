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
    if ('error' in r) {
      assert.match(r.error, /委派失败/)
      assert.match(r.error, /too many/)
      assert.doesNotMatch(r.error, /\{/)
    }
  })

  it('start 429 with a live jobId is a handle, not a failure', () => {
    const r = interpretDelegateStartBody(
      429,
      JSON.stringify({
        error: 'too many concurrent delegations (max 4 non-review; in-use 4/4)',
        status: 'running',
        jobId: 'dlgjob-live',
        sessionKey: 'sk',
      }),
    )
    assert.ok(!('error' in r))
    if ('error' in r) return
    assert.equal(r.jobId, 'dlgjob-live')
    assert.equal(r.sessionKey, 'sk')
  })

  it('wait running / queued / done / expired / failed-429', () => {
    assert.deepEqual(
      interpretDelegateWaitBody(200, JSON.stringify({ status: 'running', jobId: 'j1' })),
      { kind: 'running', jobId: 'j1' },
    )
    assert.deepEqual(
      interpretDelegateWaitBody(200, JSON.stringify({ status: 'queued', jobId: 'j1' })),
      { kind: 'running', jobId: 'j1' },
    )
    assert.equal(
      interpretDelegateWaitBody(
        429,
        JSON.stringify({ status: 'running', jobId: 'j1' }),
      ).kind,
      'running',
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
    const failed = interpretDelegateWaitBody(
      429,
      JSON.stringify({
        status: 'failed',
        jobId: 'j1',
        httpStatus: 429,
        error: 'too many concurrent delegations (max 4 non-review; in-use 4/4)',
        failure_class: 'capacity_timeout',
      }),
    )
    assert.equal(failed.kind, 'result')
    if (failed.kind !== 'result') return
    assert.equal(failed.httpStatus, 429)
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

describe('runCursorDelegateFastPath — wait transport blip → running handle (2026-09-06 L2 矩阵)', () => {
  const started = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      status: 'running',
      jobId: 'dlgjob-blip',
      agentId: 'coding-assistant',
      sessionKey: 'agent:coding-assistant:delegate:main:1:deadbeef',
    }),
  })

  it('wait ETIMEDOUT(网关长轮询慢于客户端期限)→ 不是失败,返回 jobId + delegate-wait 指令', async () => {
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'coding-assistant',
      goal: 'slow gateway',
      transport: {
        start: started,
        wait: async () => {
          const err: any = new Error('delegate client timeout after 60s')
          err.code = 'ETIMEDOUT'
          throw err
        },
      },
    })
    assert.equal(r.kind, 'running')
    if (r.kind !== 'running') return
    assert.equal(r.jobId, 'dlgjob-blip')
    assert.match(r.text, /status=running jobId=dlgjob-blip/)
    assert.match(r.text, /oc-memory delegate-wait dlgjob-blip/)
    assert.match(r.text, /sessionKey=agent:coding-assistant:delegate:main:1:deadbeef/)
  })

  it('wait ECONNRESET / socket hang up 同样降级为 running', async () => {
    for (const mk of [
      () => Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      () => new Error('socket hang up'),
    ]) {
      const r = await runCursorDelegateFastPath({
        fastWaitMs: 40,
        label: 'x',
        transport: { start: started, wait: async () => { throw mk() } },
      })
      assert.equal(r.kind, 'running')
    }
  })

  it('非传输类错误仍向上抛(不吞真实 bug)', async () => {
    await assert.rejects(
      runCursorDelegateFastPath({
        fastWaitMs: 40,
        label: 'x',
        transport: { start: started, wait: async () => { throw new TypeError('bad json path') } },
      }),
      /bad json path/,
    )
  })

  it('start 阶段超时仍是失败(没有 jobId 可交还)', async () => {
    await assert.rejects(
      runCursorDelegateFastPath({
        fastWaitMs: 40,
        label: 'x',
        transport: {
          start: async () => { throw Object.assign(new Error('delegate client timeout after 15s'), { code: 'ETIMEDOUT' }) },
          wait: async () => ({ statusCode: 200, body: '{}' }),
        },
      }),
      /timeout/,
    )
  })
})
