/**
 * present_task_approval:只投递 backlog / waiting_human,子 agent skipped,不代点 /done。
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/presentTaskApproval.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  handlePresentTaskApproval,
  normalizePresentTaskApproval,
  shouldListPresentTaskApproval,
} from '../presentTaskApproval.js'
import { createPresentOptionsCallBudget } from '../presentOptions.js'

const MCP_ENV: NodeJS.ProcessEnv = {
  OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:sess-9',
  OPENCLAUDE_AGENT_ID: 'main',
  OPENCLAUDE_GATEWAY_PORT: '18790',
  OPENCLAUDE_GATEWAY_TOKEN: 'tok',
}

type Captured = { url: string; method: string }

function jsonFetch(handler: (req: Captured) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
    }
    calls.push(captured)
    const { status, body } = handler(captured)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('normalizePresentTaskApproval', () => {
  it('接受 id,丢掉空白 prompt', () => {
    assert.deepEqual(normalizePresentTaskApproval({ id: 'OCV5-42', prompt: '  ' }), { id: 'OCV5-42' })
    assert.deepEqual(normalizePresentTaskApproval({ identifier: 'OCV5-42', prompt: '请过站' }), {
      id: 'OCV5-42',
      prompt: '请过站',
    })
  })
  it('拒绝空 id / 过长 prompt', () => {
    assert.equal(normalizePresentTaskApproval({ id: '  ' }), null)
    assert.equal(normalizePresentTaskApproval({ id: 'OCV5-42', prompt: 'x'.repeat(2001) }), null)
    assert.equal(normalizePresentTaskApproval({}), null)
  })
})

describe('shouldListPresentTaskApproval', () => {
  it('仅主会话列出,子 agent 隐藏', () => {
    assert.equal(shouldListPresentTaskApproval(0), true)
    assert.equal(shouldListPresentTaskApproval(1), false)
  })
})

describe('handlePresentTaskApproval', () => {
  it('waiting_human 投递审批卡并 GET 单据,不 POST /approve 或 /done', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 200,
      body: {
        ticket: {
          identifier: 'OCV5-42',
          title: '登录 500',
          status: 'waiting_human',
          version: 6,
          type: 'bug',
          priority: 'P1',
        },
      },
    }))
    const result = await handlePresentTaskApproval(
      { id: 'OCV5-42', prompt: '请确认可以过站' },
      { delegationDepth: 0 },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /已投递审批卡 `OCV5-42`/)
    assert.match(result.content[0]!.text, /waiting_human/)
    assert.match(result.content[0]!.text, /不要让用户去打开任务面板/)
    assert.match(result.content[0]!.text, /"kind":"task_approval"/)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.url, /\/tickets\/OCV5-42$/)
    assert.equal(calls[0]!.method, 'GET')
  })

  it('backlog 也可投递立项批准卡', async () => {
    const { fetchImpl } = jsonFetch(() => ({
      status: 200,
      body: { ticket: { identifier: 'OCV5-7', title: '新需求', status: 'backlog', version: 1 } },
    }))
    const result = await handlePresentTaskApproval(
      { id: 'OCV5-7' },
      { delegationDepth: 0 },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /批准开工/)
  })

  it('running / ready 拒绝投递,避免绕过面板状态机', async () => {
    for (const status of ['running', 'ready', 'done', 'blocked']) {
      const { fetchImpl, calls } = jsonFetch(() => ({
        status: 200,
        body: { ticket: { identifier: 'OCV5-9', title: 'x', status, version: 2 } },
      }))
      const result = await handlePresentTaskApproval(
        { id: 'OCV5-9' },
        { delegationDepth: 0 },
        MCP_ENV,
        fetchImpl,
      )
      assert.equal(result.isError, true, status)
      assert.match(result.content[0]!.text, /只有 backlog/)
      assert.equal(calls.every((c) => c.method === 'GET'), true)
    }
  })

  it('子 agent 直接 skipped,不打 board API', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({ status: 500, body: {} }))
    const result = await handlePresentTaskApproval(
      { id: 'OCV5-42' },
      { delegationDepth: 1 },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /"status":"skipped"/)
    assert.equal(calls.length, 0)
  })

  it('404 透传,不假装已贴卡', async () => {
    const { fetchImpl } = jsonFetch(() => ({
      status: 404,
      body: { error: 'not found', code: 'not_found' },
    }))
    const result = await handlePresentTaskApproval(
      { id: 'OCV5-missing' },
      { delegationDepth: 0 },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /读取任务单失败/)
  })

  it('每回合预算与 present_options 相同:第 5 次拒绝', () => {
    const consume = createPresentOptionsCallBudget(4)
    assert.equal(consume(), true)
    assert.equal(consume(), true)
    assert.equal(consume(), true)
    assert.equal(consume(), true)
    assert.equal(consume(), false)
  })
})
