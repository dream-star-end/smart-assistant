import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  delegateBackgroundCapability,
  readDelegateBackgroundHandle,
} from '../delegateBackground.js'
import {
  formatDelegateFanoutRunning,
  formatDelegateSuccess,
  interpretDelegateStartBody,
  runCursorDelegateFastPath,
  type FanoutCursorItem,
} from '../delegateCursorFastPath.js'
import { buildDelegateStartBody, requestReviewArgs, runDelegateStartAndWait } from '../delegateStartCli.js'

const response = (body: Record<string, unknown>) => ({ statusCode: 200, body: JSON.stringify(body) })
const background = (jobId: string, status: 'queued' | 'running' = 'running') => ({
  resultDelivery: 'background' as const,
  status,
  jobId,
  agentId: 'coding-assistant',
  sessionKey: `agent:coding-assistant:delegate:main:${jobId}`,
})

describe('background delegate capability and acknowledgement', () => {
  it('advertises support for ordinary starts without making review asynchronous', () => {
    assert.deepEqual(delegateBackgroundCapability(), { resultDelivery: 'background' })
    assert.equal(buildDelegateStartBody({ agentId: 'coding-assistant', goal: '实现' }).resultDelivery, 'background')
    for (const mode of ['execution', 'deliberation']) {
      const body = buildDelegateStartBody(requestReviewArgs('完整草稿', undefined, undefined, mode))
      assert.equal(body.reviewMode, mode)
      assert.equal(Object.hasOwn(body, 'resultDelivery'), false)
    }
  })

  it('recognizes only an explicit successful live background acknowledgement', () => {
    for (const status of ['running', 'queued'] as const) {
      const receipt = background('dlgjob-bg', status)
      assert.deepEqual(interpretDelegateStartBody(200, JSON.stringify(receipt)), receipt)
    }
    for (const resultDelivery of [undefined, true, 'stdout-wait', 'Background']) {
      const receipt = { ...background('dlgjob-legacy'), resultDelivery }
      assert.deepEqual(interpretDelegateStartBody(200, JSON.stringify(receipt)), {
        jobId: receipt.jobId, sessionKey: receipt.sessionKey,
      })
    }
    assert.equal(readDelegateBackgroundHandle(429, background('dlgjob-capacity')), undefined)
    assert.equal(readDelegateBackgroundHandle(200, { ...background('dlgjob-done'), status: 'done' }), undefined)
    assert.equal(readDelegateBackgroundHandle(200, { ...background(''), jobId: ' ' }), undefined)
  })

  it('does not copy unrecognized context or control data into a model-visible handle', () => {
    const receipt = background('dlgjob-bg')
    assert.deepEqual(readDelegateBackgroundHandle(200, {
      ...receipt,
      parentSessionKey: 'agent:main:webchat:dm:web-1',
      parentTurnKey: 'owner-turn',
      token: 'not-a-model-field',
      credential: 'not-a-model-field',
    }), { ...receipt, parentSessionKey: 'agent:main:webchat:dm:web-1', parentTurnKey: 'owner-turn' })
  })
})

describe('background delegate tools release the parent', () => {
  it('MCP returns a structured handle after one start and never polls or hands off', async () => {
    let starts = 0
    let waits = 0
    const receipt = background('dlgjob-bg', 'queued')
    const result = await runCursorDelegateFastPath({
      fastWaitMs: 45_000,
      label: 'coding-assistant',
      transport: {
        start: async () => { starts++; return response(receipt) },
        wait: async () => { waits++; throw new Error('background must not wait') },
      },
    })
    assert.equal(starts, 1)
    assert.equal(waits, 0)
    assert.equal(result.kind, 'background')
    if (result.kind !== 'background') return
    assert.deepEqual(result.handle, receipt)
    assert.match(result.text, /结果会自动写回本会话，可继续与用户对话/)
    assert.deepEqual(JSON.parse(result.text.split('\n')[1]), receipt)
    assert.doesNotMatch(result.text, /delegate-wait|请结束当前回合|不要结束当前回合|origin-inject/)
  })

  it('CLI returns on the explicit acknowledgement without entering its foreground loop', async () => {
    let starts = 0
    let waits = 0
    const receipt = background('dlgjob-cli')
    const result = await runDelegateStartAndWait({
      args: { agentId: 'coding-assistant', goal: '实现功能' },
      contextToken: 'signed-context',
      pollWaitMs: 20,
      start: async (_agent, body) => {
        starts++
        assert.equal(JSON.parse(body).resultDelivery, 'background')
        return response(receipt)
      },
      waitOnce: async () => { waits++; throw new Error('background must not wait') },
    })
    assert.equal(starts, 1)
    assert.equal(waits, 0)
    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n')[1]), receipt)
    assert.doesNotMatch(result.stdout, /delegate-wait|TaskOutput/)
  })

  it('flag-off / older gateway receipts retain the existing MCP and CLI wait results', async () => {
    let mcpWaits = 0
    let cliWaits = 0
    const started = response({ status: 'running', jobId: 'dlgjob-legacy' })
    const done = response({ status: 'done', jobId: 'dlgjob-legacy', ok: true, output: '原有结果' })
    const mcp = await runCursorDelegateFastPath({
      fastWaitMs: 45_000,
      label: 'coding-assistant',
      transport: {
        start: async () => started,
        wait: async (_jobId, _waitMs, handoff) => {
          mcpWaits++
          assert.equal(handoff, undefined)
          return done
        },
      },
    })
    assert.deepEqual(mcp, { kind: 'ok', text: formatDelegateSuccess('coding-assistant', '原有结果') })
    const cli = await runDelegateStartAndWait({
      args: { agentId: 'coding-assistant', goal: '实现功能' }, contextToken: 'signed-context', pollWaitMs: 20,
      start: async () => started,
      waitOnce: async () => { cliWaits++; return done },
    })
    assert.equal(mcpWaits, 1)
    assert.equal(cliWaits, 1)
    assert.equal(cli.exitCode, 0)
    assert.equal(cli.stdout, `${formatDelegateSuccess('dlgjob-legacy', '原有结果')}\n`)
  })

  it('fan-out mixes background, ordinary and failed starts without polling background jobs', async () => {
    const starts: string[] = []
    const waits: string[] = []
    const results = await Promise.all(['bg-a', 'ordinary', 'failed', 'bg-b'].map(async (name) => {
      return runCursorDelegateFastPath({
        fastWaitMs: 45_000, label: name,
        transport: {
          start: async () => {
            starts.push(name)
            if (name === 'failed') return { statusCode: 429, body: JSON.stringify({ error: 'capacity full' }) }
            return response(name.startsWith('bg-') ? background(name) : { status: 'queued', jobId: name })
          },
          wait: async (jobId) => {
            waits.push(jobId)
            return response({ status: 'done', jobId, ok: true, output: '普通任务完成' })
          },
        },
      })
    }))
    assert.deepEqual(starts, ['bg-a', 'ordinary', 'failed', 'bg-b'])
    assert.deepEqual(waits, ['ordinary'])
    assert.deepEqual(results.map((result) => result.kind), ['background', 'ok', 'error', 'background'])
    const items: FanoutCursorItem[] = results.map((result, index) => ({
      label: `member-${index}`, goal: `任务-${index}`, isError: result.kind === 'error', text: result.text,
      ...(result.kind === 'background' ? { running: true, jobId: result.jobId, backgroundHandle: result.handle } : {}),
    }))
    const text = formatDelegateFanoutRunning(items)
    assert.match(text, /2 已完成 \/ 2 后台运行 \/ 0 仍在等待/)
    assert.match(text, /普通任务完成/)
    assert.match(text, /capacity full/)
    assert.doesNotMatch(text, /delegate-wait|请结束当前回合|不要结束当前回合/)
  })

  it('unfinished ordinary fan-out members keep one aggregate wait excluding all background IDs', () => {
    const receipt = background('dlgjob-bg')
    const text = formatDelegateFanoutRunning([
      { label: 'bg', goal: '后台', isError: false, text: '', running: true, jobId: receipt.jobId, backgroundHandle: receipt },
      { label: 'first', goal: '旧路径 A', isError: false, text: '', running: true, jobId: 'dlgjob-first' },
      { label: 'second', goal: '旧路径 B', isError: false, text: '', running: true, jobId: 'dlgjob-second' },
    ])
    assert.equal(text.match(/oc-memory delegate-wait/g)?.length, 1)
    assert.match(text, /oc-memory delegate-wait dlgjob-first dlgjob-second/)
    assert.doesNotMatch(text, /oc-memory delegate-wait[^\n]*dlgjob-bg/)
  })
})
