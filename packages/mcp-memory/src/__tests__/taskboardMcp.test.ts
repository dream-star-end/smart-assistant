/**
 * taskboard MCP: originSessionKey 从上下文注入,args 不收 userId/identifier。
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/taskboardMcp.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCreateTicketBody, currentSessionKey, handleTaskCreate } from '../taskboardMcp.js'

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
    let posted: unknown
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body ?? '{}'))
      return new Response(
        JSON.stringify({
          ok: true,
          ticket: {
            identifier: 'OCV5-42',
            version: 1,
            status: 'backlog',
            originSessionKey: 'agent:main:webchat:sess-9',
          },
        }),
        { status: 201 },
      )
    }) as typeof fetch

    const result = await handleTaskCreate(
      { projectId: 'OCV5', type: 'bug', title: '登录 500' },
      {
        OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:sess-9',
        OPENCLAUDE_AGENT_ID: 'main',
        OPENCLAUDE_GATEWAY_PORT: '18790',
        OPENCLAUDE_GATEWAY_TOKEN: 'tok',
      },
      fetchImpl,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /OCV5-42/)
    const body = posted as Record<string, unknown>
    assert.equal(body.originSessionKey, 'agent:main:webchat:sess-9')
    assert.equal('userId' in body, false)
    assert.equal('identifier' in body, false)
  })
})
