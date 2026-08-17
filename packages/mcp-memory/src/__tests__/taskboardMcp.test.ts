/**
 * taskboard MCP: originSessionKey 从上下文注入,args 不收 userId/identifier。
 * 另锁:每个 task_* 正常路径、服务端强制规则透传、toolNames ↔ toolDefs 的 task_* 集合。
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/taskboardMcp.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildCreateTicketBody,
  currentSessionKey,
  handleTaskComment,
  handleTaskCreate,
  handleTaskGet,
  handleTaskList,
  handleTaskUpdate,
} from '../taskboardMcp.js'
import { TOOLS } from '../toolDefs.js'
import { MEMORY_MCP_TOOL_NAMES } from '../toolNames.js'

const MCP_ENV: NodeJS.ProcessEnv = {
  OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:sess-9',
  OPENCLAUDE_AGENT_ID: 'main',
  OPENCLAUDE_GATEWAY_PORT: '18790',
  OPENCLAUDE_GATEWAY_TOKEN: 'tok',
}

const SAMPLE_TICKET = {
  identifier: 'OCV5-42',
  version: 3,
  status: 'ready',
  type: 'bug',
  priority: 'P2',
  title: '登录 500',
  body: '复现步骤',
  assignee: null,
  originSessionKey: 'agent:main:webchat:sess-9',
}

type Captured = { url: string; method: string; body: Record<string, unknown> | null }

function jsonFetch(handler: (req: Captured) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch
  calls: Captured[]
} {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    }
    calls.push(captured)
    const { status, body } = handler(captured)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('originSessionKey 从 MCP 上下文注入', () => {
  it('currentSessionKey 读 OPENCLAUDE_SESSION_KEY,缺省为空串', () => {
    assert.equal(
      currentSessionKey({ OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:abc' }),
      'agent:main:webchat:abc',
    )
    assert.equal(currentSessionKey({}), '')
  })

  it('buildCreateTicketBody 写入 originSessionKey,且不含 userId/identifier', () => {
    const body = buildCreateTicketBody(
      { projectId: 'OCV5', type: 'bug', title: '登录 500' },
      {
        OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:sess-1',
        OPENCLAUDE_AGENT_ID: 'main',
      },
    )
    assert.equal(body.originSessionKey, 'agent:main:webchat:sess-1')
    assert.equal(body.reporter, 'agent:main')
    assert.equal(body.source, 'chat')
    assert.equal('userId' in body, false)
    assert.equal('identifier' in body, false)
    assert.equal('id' in body, false)
    assert.equal('version' in body, false)
  })

  it('handleTaskCreate POST body 带 originSessionKey,不带 userId', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 201,
      body: { ok: true, ticket: SAMPLE_TICKET },
    }))

    const result = await handleTaskCreate(
      { projectId: 'OCV5', type: 'bug', title: '登录 500' },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /OCV5-42/)
    assert.equal(calls.length, 1)
    const body = calls[0]!.body as Record<string, unknown>
    assert.equal(body.originSessionKey, 'agent:main:webchat:sess-9')
    assert.equal('userId' in body, false)
    assert.equal('identifier' in body, false)
  })
})

describe('每个 task_* 工具正常路径', () => {
  it('task_create 成功回 identifier/version', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 201,
      body: { ok: true, ticket: { ...SAMPLE_TICKET, status: 'backlog', version: 1 } },
    }))
    const result = await handleTaskCreate(
      { projectId: 'OCV5', type: 'bug', title: '登录 500' },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /OCV5-42/)
    assert.match(result.content[0]!.text, /v1/)
    assert.equal(calls[0]!.method, 'POST')
    assert.match(calls[0]!.url, /\/api\/board\/tickets$/)
  })

  it('task_update 成功回新 version', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 200,
      body: { ok: true, ticket: { ...SAMPLE_TICKET, version: 4, title: '登录 500 修过' } },
    }))
    const result = await handleTaskUpdate(
      { id: 'OCV5-42', expectedVersion: 3, title: '登录 500 修过' },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /OCV5-42/)
    assert.match(result.content[0]!.text, /v4/)
    assert.equal(calls[0]!.method, 'PATCH')
    assert.deepEqual(calls[0]!.body, { expectedVersion: 3, title: '登录 500 修过' })
  })

  it('task_comment 成功', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 200,
      body: { ok: true, comment: { id: 'c1', body: '已修' } },
    }))
    const result = await handleTaskComment({ id: 'OCV5-42', body: '已修' }, MCP_ENV, fetchImpl)
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /OCV5-42/)
    assert.equal(calls[0]!.method, 'POST')
    assert.match(calls[0]!.url, /\/tickets\/OCV5-42\/comment$/)
    assert.equal(calls[0]!.body?.body, '已修')
  })

  it('task_list 成功列出本页', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 200,
      body: { items: [SAMPLE_TICKET], total: 1 },
    }))
    const result = await handleTaskList({ projectId: 'OCV5', status: 'ready' }, MCP_ENV, fetchImpl)
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /共 1 张/)
    assert.match(result.content[0]!.text, /OCV5-42/)
    assert.equal(calls[0]!.method, 'GET')
    assert.match(calls[0]!.url, /projectId=OCV5/)
    assert.match(calls[0]!.url, /status=ready/)
  })

  it('task_get 成功拼 ticket + comments', async () => {
    const { fetchImpl } = jsonFetch((req) => {
      if (req.url.includes('/comments')) {
        return {
          status: 200,
          body: { items: [{ authorKind: 'human', author: 'user:default', body: '开工' }] },
        }
      }
      return { status: 200, body: { ticket: SAMPLE_TICKET } }
    })
    const result = await handleTaskGet({ id: 'OCV5-42' }, MCP_ENV, fetchImpl)
    assert.equal(result.isError, undefined)
    const text = result.content[0]!.text
    assert.match(text, /identifier: `OCV5-42`/)
    assert.match(text, /version: 3/)
    assert.match(text, /status: ready/)
    assert.match(text, /human\/user:default: 开工/)
  })
})

describe('服务端强制规则在 MCP 侧同样生效', () => {
  it('传入 identifier 不得进入 POST body(服务端编号)', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 201,
      body: { ok: true, ticket: SAMPLE_TICKET },
    }))
    const result = await handleTaskCreate(
      {
        projectId: 'OCV5',
        type: 'bug',
        title: '登录 500',
        identifier: 'OCV5-999',
        id: 'forged',
        userId: 'attacker',
      } as Parameters<typeof handleTaskCreate>[0],
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, true)
    assert.equal(calls.length, 0, '拒绝后不得发 POST')
    assert.match(result.content[0]!.text, /identifier/i)
    assert.match(result.content[0]!.text, /编号由服务端生成/)
  })

  // BUG-3: handleTaskCreate 对多余 identifier 静默剥离并仍 201,不返回 toolError。
  it('客户端传入 identifier 试图自造编号 → 被拒', async () => {
    const { fetchImpl } = jsonFetch(() => ({
      status: 201,
      body: { ok: true, ticket: SAMPLE_TICKET },
    }))
    const result = await handleTaskCreate(
      {
        projectId: 'OCV5',
        type: 'bug',
        title: '登录 500',
        identifier: 'OCV5-999',
      } as Parameters<typeof handleTaskCreate>[0],
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, true, 'MCP 应对 args.identifier 显式拒绝,不能静默建单')
    assert.match(result.content[0]!.text, /identifier/i)
  })

  it('task_update 带过期 expectedVersion,409 语义透传给调用方', async () => {
    const { fetchImpl } = jsonFetch(() => ({
      status: 409,
      body: {
        error: 'ticket t1 version conflict: expected 1, actual 3',
        code: 'version_conflict',
        expectedVersion: 1,
        actualVersion: 3,
      },
    }))
    const result = await handleTaskUpdate(
      { id: 'OCV5-42', expectedVersion: 1, title: '过期写' },
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, true)
    const text = result.content[0]!.text
    assert.match(text, /版本冲突\(409\)/)
    assert.match(text, /409/)
    assert.match(text, /version_conflict/)
    assert.match(text, /task_get/)
  })

  it('task_update 传入 status=done 不得写入 PATCH body(done 不属于 AI)', async () => {
    const { fetchImpl, calls } = jsonFetch(() => ({
      status: 200,
      body: { ok: true, ticket: SAMPLE_TICKET },
    }))
    const result = await handleTaskUpdate(
      {
        id: 'OCV5-42',
        expectedVersion: 3,
        title: '改标题',
        status: 'done',
      } as Parameters<typeof handleTaskUpdate>[0],
      MCP_ENV,
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    const body = calls[0]!.body as Record<string, unknown>
    assert.equal('status' in body, false)
    assert.equal(calls[0]!.method, 'PATCH')
    assert.equal(calls[0]!.url.includes('/done'), false)
  })

  it('MCP 无 task_done 入口,update 不打 /done(403 由 HTTP 状态机锁)', () => {
    const names = TOOLS.map((t) => t.name)
    assert.equal(names.includes('task_done'), false)
    const update = TOOLS.find((t) => t.name === 'task_update')
    const props =
      (update?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ??
      {}
    assert.equal('status' in props, false)
  })
})

describe('toolNames.ts ↔ toolDefs.ts 的 task_* 锁步', () => {
  it('两边的 task_* 集合一致(顺序即 TOOLS 声明顺序)', () => {
    const fromDefs = TOOLS.map((t) => t.name).filter((n) => n.startsWith('task_'))
    const fromNames = MEMORY_MCP_TOOL_NAMES.filter((n) => n.startsWith('task_'))
    assert.deepEqual(fromDefs, [...fromNames])
  })

  it('task_* schema 不含 identifier / userId / originSessionKey;写工具不含 status', () => {
    const taskTools = TOOLS.filter((t) => t.name.startsWith('task_'))
    assert.ok(taskTools.length > 0)
    for (const tool of taskTools) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      assert.equal('identifier' in props, false, `${tool.name} 不得收 identifier`)
      assert.equal('userId' in props, false, `${tool.name} 不得收 userId`)
      assert.equal('originSessionKey' in props, false, `${tool.name} 不得收 originSessionKey`)
    }
    // task_list.status 是列表筛选,合法;create/update/comment 不得收 status 走路状态机。
    for (const name of ['task_create', 'task_update', 'task_comment'] as const) {
      const tool = taskTools.find((t) => t.name === name)
      assert.ok(tool, name)
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      assert.equal('status' in props, false, `${name} 不得收 status`)
    }
    for (const tool of taskTools) {
      const schema = tool.inputSchema as { additionalProperties?: boolean }
      assert.equal(schema.additionalProperties, false, `${tool.name} 须 additionalProperties:false`)
    }
  })

  it('task_* 工具集不含 done/claim/ready/cancel/advance 等状态机动作', () => {
    const names = TOOLS.map((t) => t.name).filter((n) => n.startsWith('task_'))
    assert.deepEqual(names, ['task_create', 'task_update', 'task_comment', 'task_list', 'task_get'])
    for (const banned of [
      'task_done',
      'task_claim',
      'task_ready',
      'task_cancel',
      'task_advance',
      'task_approve',
    ]) {
      assert.equal(names.includes(banned), false, banned)
    }
  })
})
