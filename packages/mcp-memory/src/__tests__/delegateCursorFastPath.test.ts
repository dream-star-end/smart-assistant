/**
 * Delegate tools retain one invocation across HTTP polls, and hand off only
 * at the engine budget. Virtual clocks cover long jobs without paid models.
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
  resolveDelegateMcpBudgetMs,
  runCursorDelegateFastPath,
} from '../delegateCursorFastPath.js'

const response = (body: Record<string, unknown>) => ({ statusCode: 200, body: JSON.stringify(body) })

describe('resolveCursorFastWaitMs', () => {
  it('uses the gateway-projected tool budget and a conservative legacy default', () => {
    assert.equal(resolveDelegateMcpBudgetMs({}), 45_000)
    assert.equal(resolveDelegateMcpBudgetMs({ OPENCLAUDE_DELEGATE_MCP_BUDGET_MS: '585000' }), 585_000)
    assert.equal(resolveDelegateMcpBudgetMs({ OPENCLAUDE_DELEGATE_MCP_BUDGET_MS: 'invalid' }), 45_000)
    assert.equal(resolveDelegateMcpBudgetMs({ OPENCLAUDE_DELEGATE_MCP_BUDGET_MS: '1' }), 1)
  })
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

  it('crosses 45 seconds and receives terminal inside one tool invocation', async () => {
    let now = 0
    let starts = 0
    const polls: boolean[] = []
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 45_000,
      deadlineAtMs: 180_000,
      now: () => now,
      label: 'coding-assistant',
      transport: {
        start: async () => { starts++; return response({ status: 'running', jobId: 'dlgjob-slow' }) },
        wait: async (_id, ms, handoff) => {
          polls.push(handoff === true)
          now += ms
          return response(polls.length < 3
            ? { status: 'running', jobId: 'dlgjob-slow' }
            : { status: 'done', jobId: 'dlgjob-slow', output: '最终结果', ok: true })
        },
      },
    })
    assert.equal(starts, 1)
    assert.deepEqual(polls, [false, false, false])
    assert.equal(now, 135_000)
    assert.equal(r.kind, 'ok')
    assert.match(r.text, /最终结果/)
    assert.doesNotMatch(r.text, /delegate-wait|status=running/)
  })

  it('shares a deadline across fan-out and waits for each terminal without a Bash round', async () => {
    const deadlineAtMs = 180_000
    const completed = await Promise.all([1, 2, 3].map(async (count) => {
      let now = 0
      let polls = 0
      return runCursorDelegateFastPath({
        fastWaitMs: 45_000, deadlineAtMs, now: () => now, label: `member-${count}`,
        transport: {
          start: async () => response({ status: 'queued', jobId: `dlgjob-${count}` }),
          wait: async (_id, ms) => {
            now += ms
            polls++
            return response(polls < count
              ? { status: 'queued', jobId: `dlgjob-${count}` }
              : { status: count === 2 ? 'failed' : 'done', output: `result-${count}`, ...(count === 2 ? { error: 'child failed' } : {}) })
          },
        },
      })
    }))
    assert.deepEqual(completed.map((r) => r.kind), ['ok', 'error', 'ok'])
    assert.ok(completed.every((r) => !/delegate-wait/.test(r.text)))
  })

  it('hands the job to the gateway before the budget, including time spent starting', async () => {
    let now = 0
    const polls: Array<{ ms: number; handoff?: boolean }> = []
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 45_000, deadlineAtMs: 60_000, now: () => now, label: 'main',
      transport: {
        start: async () => { now += 15_000; return response({ status: 'running', jobId: 'dlgjob-defer' }) },
        wait: async (_id, ms, handoff) => {
          polls.push({ ms, handoff })
          now += ms
          return response({ status: 'deferred', jobId: 'dlgjob-defer' })
        },
      },
    })
    assert.deepEqual(polls, [{ ms: 42_000, handoff: true }])
    assert.equal(r.kind, 'deferred')
    assert.match(r.text, /自动把结果送回本会话/)
    assert.doesNotMatch(r.text, /delegate-wait|Bash/)
    assert.ok(now < 60_000)
  })

  it('unavailable handoff remains healthy and bounded, without a Bash instruction', async () => {
    let now = 0
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 45_000, deadlineAtMs: 1_000, now: () => now,
      sleep: async (ms) => { now += ms }, label: 'main',
      transport: {
        start: async () => response({ status: 'running', jobId: 'dlgjob-live' }),
        wait: async () => response({ status: 'running', jobId: 'dlgjob-live' }),
      },
    })
    assert.equal(r.kind, 'running')
    assert.doesNotMatch(r.text, /delegate-wait|Bash|委派失败/)
  })

  it('still attempts a bounded handoff when job admission used the entire budget', async () => {
    let now = 0
    let waits = 0
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 45_000, deadlineAtMs: 1_000, now: () => now, label: 'main',
      transport: {
        start: async () => { now = 1_500; return response({ status: 'running', jobId: 'dlgjob-admitted' }) },
        wait: async (_id, ms, handoff) => {
          waits++
          assert.equal(ms, 250)
          assert.equal(handoff, true)
          return response({ status: 'deferred', jobId: 'dlgjob-admitted' })
        },
      },
    })
    assert.equal(waits, 1)
    assert.equal(r.kind, 'deferred')
  })

  it('gateway recovery HTTP 503 is retried but a failed job remains terminal', async () => {
    let polls = 0
    let now = 0
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 45_000, deadlineAtMs: 180_000, now: () => now,
      sleep: async (ms) => { now += ms }, label: 'main',
      transport: {
        start: async () => response({ status: 'running', jobId: 'dlgjob-recovery' }),
        wait: async () => ++polls === 1
          ? { statusCode: 503, body: JSON.stringify({ error: 'reconciling' }) }
          : response({ status: 'failed', jobId: 'dlgjob-recovery', error: 'child failed' }),
      },
    })
    assert.equal(polls, 2)
    assert.equal(r.kind, 'error')
    assert.match(r.text, /child failed/)
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
  it('lists handed-off members without asking the model to start a wait tool', () => {
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
        deferred: true,
        jobId: 'dlgjob-a',
      },
      {
        label: 'office',
        goal: 'also slow',
        isError: false,
        text: '',
        running: true,
        deferred: true,
        jobId: 'dlgjob-b',
      },
    ])
    assert.match(text, /1 已完成 \/ 2 仍在运行/)
    assert.doesNotMatch(text, /delegate-wait|Bash/)
    assert.match(text, /网关已接管等待/)
    assert.match(text, /dlgjob-a/)
    assert.match(text, /dlgjob-b/)
    assert.match(text, /✅ coder/)
  })
})

describe('runCursorDelegateFastPath — transport blips stay inside the tool call', () => {
  const started = async () => response({ status: 'running', jobId: 'dlgjob-blip' })

  for (const error of [
    Object.assign(new Error('delegate client timeout after 60s'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('restarting gateway'), { code: 'ECONNREFUSED' }),
    new Error('socket hang up'),
  ]) {
    it(`retries ${error.message} and returns the final result`, async () => {
      let polls = 0
      let now = 0
      const r = await runCursorDelegateFastPath({
        fastWaitMs: 45_000, deadlineAtMs: 180_000, now: () => now,
        sleep: async (ms) => { now += ms }, label: 'main',
        transport: {
          start: started,
          wait: async () => {
            if (++polls === 1) throw error
            return response({ status: 'done', jobId: 'dlgjob-blip', output: 'recovered' })
          },
        },
      })
      assert.equal(polls, 2)
      assert.equal(r.kind, 'ok')
      assert.match(r.text, /recovered/)
    })
  }

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
