/**
 * Cursor delegate fast path: 45s-window complete vs timeout→jobId, plus wait
 * interpreting a later final result and TTL expiry. Uses short constants.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/delegateCursorFastPath.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS,
  delegateLeaderResultBudget,
  formatDelegateFanoutRunning,
  formatDelegateHttpResult,
  formatDelegateSuccess,
  interpretDelegateStartBody,
  interpretDelegateWaitBody,
  resolveCursorFastWaitMs,
  runCursorDelegateFastPath,
  truncateDelegateLeaderResult,
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
          body: JSON.stringify({
            status: 'running',
            jobId: 'dlgjob-1',
            agentId: 'coding-assistant',
          }),
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
          body: JSON.stringify({
            status: 'running',
            jobId: 'dlgjob-slow',
            agentId: 'coding-assistant',
          }),
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
      interpretDelegateWaitBody(429, JSON.stringify({ status: 'running', jobId: 'j1' })).kind,
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
        transport: {
          start: started,
          wait: async () => {
            throw mk()
          },
        },
      })
      assert.equal(r.kind, 'running')
    }
  })

  it('非传输类错误仍向上抛(不吞真实 bug)', async () => {
    await assert.rejects(
      runCursorDelegateFastPath({
        fastWaitMs: 40,
        label: 'x',
        transport: {
          start: started,
          wait: async () => {
            throw new TypeError('bad json path')
          },
        },
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
          start: async () => {
            throw Object.assign(new Error('delegate client timeout after 15s'), {
              code: 'ETIMEDOUT',
            })
          },
          wait: async () => ({ statusCode: 200, body: '{}' }),
        },
      }),
      /timeout/,
    )
  })
})

function listedArtifactPaths(out: string): string[] {
  const marker = '产物路径(完整文件仍在,请用 Read 打开):\n'
  const at = out.indexOf(marker)
  if (at < 0) return []
  const paths: string[] = []
  for (const line of out.slice(at + marker.length).split('\n')) {
    if (!line.startsWith('- ')) break
    paths.push(line.slice(2))
  }
  return paths
}

describe('truncateDelegateLeaderResult', () => {
  it('leaves short text, including the exact 6000-char boundary, unchanged', () => {
    assert.equal(truncateDelegateLeaderResult('修复完成'), '修复完成')
    assert.equal(truncateDelegateLeaderResult(''), '')
    const exact = 'x'.repeat(DELEGATE_LEADER_RESULT_ITEM_MAX_CHARS)
    assert.equal(truncateDelegateLeaderResult(exact), exact)
  })

  it('keeps the head and the tail and states how many characters were omitted', () => {
    const text = `${'A'.repeat(3000)}MIDDLE${'B'.repeat(3000)}`
    const out = truncateDelegateLeaderResult(text)
    assert.equal(text.length, 6006)
    assert.ok(out.startsWith('A'.repeat(3000)))
    assert.ok(out.endsWith('B'.repeat(3000)))
    assert.equal(out.includes('MIDDLE'), false)
    assert.match(out, /中间省略 6 字/)
    assert.match(out, /完整结果仍在该成员会话与产物文件,未删除/)
  })

  it('lists an artifact path that sits only in the omitted middle', () => {
    const path = '/home/agent/.openclaude/generated/trip-plan.md'
    const text = `${'A'.repeat(3000)}见 ${path} 全文${'B'.repeat(3000)}`
    const out = truncateDelegateLeaderResult(text)
    assert.equal(out.includes('见 '), false)
    assert.match(out, /产物路径\(完整文件仍在,请用 Read 打开\)/)
    assert.match(out, new RegExp(`- ${path.replace(/[.]/g, '\\.')}`))
  })

  it('lists a backtick-quoted path with a space from the omitted middle', () => {
    const path = '/home/agent/.openclaude/generated/trip plan.md'
    const text = `${'H'.repeat(3500)}\n产物：\`${path}\`\n${'T'.repeat(3500)}`
    const out = truncateDelegateLeaderResult(text)
    assert.equal(out.includes(path), true)
    assert.deepEqual(listedArtifactPaths(out), [path])
  })

  it('lists a backtick-quoted path that contains parentheses', () => {
    const path = '/home/agent/.openclaude/generated/trip(1).md'
    const text = `${'H'.repeat(3500)}\n产物：\`${path}\`\n${'T'.repeat(3500)}`
    const out = truncateDelegateLeaderResult(text)
    assert.equal(out.includes(path), true)
    assert.deepEqual(listedArtifactPaths(out), [path])
  })

  it('keeps a spaced path inside quotes, angle brackets, and corner brackets', () => {
    const quoted = '/home/agent/.openclaude/generated/trip plan.md'
    const angled = '/home/agent/.openclaude/generated/图表 (1).png'
    const cjk = '/home/agent/.openclaude/generated/行程 草案.md'
    const text = [
      'H'.repeat(3500),
      `双引号"${quoted}"`,
      `链接[下载](<${angled}>)`,
      `书名号「${cjk}」`,
      'T'.repeat(3500),
    ].join('\n')
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [quoted, angled, cjk])
  })

  it('drops sentence punctuation outside a bare or quoted path', () => {
    const bare = '/home/agent/.openclaude/generated/trip-plan.md'
    const gz = '/home/agent/.openclaude/generated/archive.tar.gz'
    const csv = '/home/agent/.openclaude/generated/sales.csv'
    const text = [
      'H'.repeat(3500),
      `见 ${bare}。以及 ${gz}。下一句 "${csv}",结束`,
      'T'.repeat(3500),
    ].join('')
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [bare, gz, csv])
  })

  it('keeps a parenthesized filename and still stops at a markdown link closer', () => {
    const file = '/home/agent/.openclaude/generated/trip(1).md'
    const link = '/home/agent/.openclaude/generated/sales.csv'
    const text = `${'H'.repeat(3500)}裸 ${file} 以及[下载](${link})。${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [file, link])
  })

  it('does not swallow the sentence after an unclosed parenthesis', () => {
    const head = 'H'.repeat(3500)
    const tail = 'T'.repeat(3500)
    const text = `${head}见 /home/agent/.openclaude/generated/trip(draft 还没写完。${tail}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [
      '/home/agent/.openclaude/generated/trip',
    ])
  })

  it('keeps dots and spaces inside one pair of backticks', () => {
    const file = '/home/agent/.openclaude/generated/file.name with space.md'
    const report = '/home/agent/.openclaude/generated/report.md'
    const notes = '/home/agent/.openclaude/generated/notes.md'
    const text = `${'H'.repeat(3500)}\`${file}\` 以及 \`${report}\` 和 \`${notes}\`${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [file, report, notes])
  })

  it('keeps a quoted filename with a version and a Chinese suffix', () => {
    const path = '/home/agent/.openclaude/generated/report.v1 最终版.md'
    const text = `${'H'.repeat(3500)}\n产物：\`${path}\`\n${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [path])
  })

  it('keeps an internal dot in a bare Chinese filename', () => {
    const path = '/home/agent/.openclaude/generated/report.最终版.md'
    const text = `${'H'.repeat(3500)}\n产物：${path}\n${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [path])
  })

  it('leaves punctuation outside a corner-bracketed path', () => {
    const path = '/home/agent/.openclaude/generated/图表 (1).png'
    const text = `${'H'.repeat(3500)}\n产物：「${path}」。请读取。\n${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [path])
  })

  it('leaves a Chinese period after a bare path outside the Read target', () => {
    const path = '/home/agent/.openclaude/generated/report.md'
    const text = `${'H'.repeat(3500)}\n产物：${path}。请读取。\n${'T'.repeat(3500)}`
    assert.deepEqual(listedArtifactPaths(truncateDelegateLeaderResult(text)), [path])
  })


  it('does not split a surrogate pair at the cut', () => {
    const text = `A\uD83D\uDE00${'C'.repeat(20)}`
    const out = truncateDelegateLeaderResult(text, 3)
    for (let i = 0; i < out.length; i++) {
      const cu = out.charCodeAt(i)
      if (cu >= 0xd800 && cu <= 0xdbff) {
        const next = out.charCodeAt(i + 1)
        assert.ok(next >= 0xdc00 && next <= 0xdfff)
        i++
      } else {
        assert.ok(cu < 0xdc00 || cu > 0xdfff)
      }
    }
    assert.match(out, /中间省略/)
  })

  it('shares the review budget: 1..4 items stay at 6000, more items split 24000', () => {
    assert.equal(delegateLeaderResultBudget(1), 6000)
    assert.equal(delegateLeaderResultBudget(3), 6000)
    assert.equal(delegateLeaderResultBudget(4), 6000)
    assert.equal(delegateLeaderResultBudget(5), 4800)
    assert.equal(delegateLeaderResultBudget(8), 3000)
    assert.equal(delegateLeaderResultBudget(100), 800)
    assert.equal(delegateLeaderResultBudget(0), 6000)
  })
})

describe('formatDelegateSuccess leader cap', () => {
  it('short success text and sessionKey stay byte-for-byte', () => {
    assert.equal(
      formatDelegateSuccess('coding-assistant', 'ok', 'sk'),
      '✅ 委派完成 (agent: coding-assistant)\n\nok\n\nsessionKey=sk\n下次同一成员续跑请传 resumeSessionKey。',
    )
    assert.equal(formatDelegateSuccess('a', ''), '✅ 委派完成 (agent: a)\n\n(无输出)')
  })

  it('long member output is capped before the sessionKey footer', () => {
    const text = `${'A'.repeat(3000)}MIDDLE${'B'.repeat(3000)}`
    const out = formatDelegateSuccess('coding-assistant', text, 'agent:coding:delegate:1')
    assert.match(out, /^✅ 委派完成 \(agent: coding-assistant\)/)
    assert.equal(out.includes('MIDDLE'), false)
    assert.match(out, /中间省略 6 字/)
    assert.match(out, /sessionKey=agent:coding:delegate:1/)
    assert.match(out, /resumeSessionKey/)
    assert.ok(out.trimEnd().endsWith('下次同一成员续跑请传 resumeSessionKey。'))
  })

  it('preserves quoted artifact paths in the tool result the leader reads', () => {
    const spaced = '/home/agent/.openclaude/generated/trip plan.md'
    const paren = '/home/agent/.openclaude/generated/trip(1).md'
    const spacedOut = formatDelegateSuccess(
      'member',
      `${'H'.repeat(3500)}\n产物：\`${spaced}\`\n${'T'.repeat(3500)}`,
      'child-session',
    )
    const parenOut = formatDelegateSuccess(
      'member',
      `${'H'.repeat(3500)}\n产物：\`${paren}\`\n${'T'.repeat(3500)}`,
      'child-session',
    )
    assert.equal(spacedOut.includes(spaced), true)
    assert.equal(parenOut.includes(paren), true)
    assert.deepEqual(listedArtifactPaths(spacedOut), [spaced])
    assert.deepEqual(listedArtifactPaths(parenOut), [paren])
    assert.match(spacedOut, /sessionKey=child-session/)
    assert.match(parenOut, /resumeSessionKey/)
  })

  it('fast path finished inside the wait window returns the capped text', async () => {
    const output = `${'H'.repeat(4000)}SECRET_MIDDLE${'T'.repeat(4000)}`
    const r = await runCursorDelegateFastPath({
      fastWaitMs: 40,
      label: 'research-assistant',
      transport: {
        start: async () => ({
          statusCode: 200,
          body: JSON.stringify({ status: 'running', jobId: 'dlgjob-long', sessionKey: 'sk-long' }),
        }),
        wait: async () => ({
          statusCode: 200,
          body: JSON.stringify({
            status: 'done',
            jobId: 'dlgjob-long',
            httpStatus: 200,
            ok: true,
            output,
            sessionKey: 'sk-long',
          }),
        }),
      },
    })
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok') return
    assert.equal(r.text.includes('SECRET_MIDDLE'), false)
    assert.match(r.text, /中间省略/)
    assert.match(r.text, /sessionKey=sk-long/)
    assert.equal(r.text, formatDelegateSuccess('research-assistant', output, 'sk-long'))
  })

  it('a long member error is capped, a short gateway error is not', () => {
    const short = formatDelegateHttpResult(500, { error: 'boom' }, 'main')
    assert.deepEqual(short, { kind: 'error', text: '委派失败: boom' })
    const huge = `API Error: 500 ${'E'.repeat(7000)}`
    const failed = formatDelegateHttpResult(200, { ok: true, output: huge }, 'main')
    assert.equal(failed.kind, 'error')
    if (failed.kind !== 'error') return
    assert.match(failed.text, /^子 agent 执行出错: /)
    assert.match(failed.text, /中间省略/)
    assert.equal(failed.text.includes('E'.repeat(7000)), false)
  })
})
