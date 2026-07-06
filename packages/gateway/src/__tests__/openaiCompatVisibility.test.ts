import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import {
  filterUserVisibleAgentsForManagement,
  filterUserVisibleRoutesForManagement,
  userVisibleDefaultAgentId,
} from '../agentVisibility.js'
import { handleOpenAIRequest, type OpenAICompatDeps } from '../openaiCompat.js'

function makeDeps(
  readBody: () => Promise<string> = async () => '',
  over: { defaultAgent?: string } = {},
) {
  let sent: { kind: 'json' | 'error'; code: number; body: unknown } | null = null
  let getOrCreateCalled = false
  let getOrCreateAgentId: string | null = null
  // 全量 agents(含 hidden-reviewer)—— /v1/chat/completions 判定面看的就是这份。
  const fullAgentsConfig: OpenAICompatDeps['agentsConfig'] = {
    default: over.defaultAgent ?? 'main',
    routes: [],
    agents: [
      { id: 'main' },
      { id: 'hidden-reviewer' },
      { id: 'market-writer', source: 'marketplace' },
    ],
  }
  const deps: OpenAICompatDeps = {
    config: {} as OpenAICompatDeps['config'],
    agentsConfig: fullAgentsConfig,
    // /v1/models 消费的用户可见投影(与 server._getAgentsConfigUserView 同投影 helper):
    // rig 用真投影 helper 从全量派生,故 models 断言仍真实验证隐藏 agent 被剔除。
    agentsConfigUserView: {
      default: userVisibleDefaultAgentId(fullAgentsConfig.default),
      routes: filterUserVisibleRoutesForManagement(fullAgentsConfig.routes),
      agents: filterUserVisibleAgentsForManagement(fullAgentsConfig.agents),
    },
    sessions: {
      async getOrCreate(args: { agent?: { id?: string } }) {
        getOrCreateCalled = true
        getOrCreateAgentId = args.agent?.id ?? null
        return {} as never
      },
      async submit(_session: unknown, _prompt: string, onEvent: (event: unknown) => void) {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'ok' } })
      },
    } as unknown as OpenAICompatDeps['sessions'],
    runLog: {
      start() { return {} },
      complete() {},
    } as unknown as OpenAICompatDeps['runLog'],
    readBody,
    sendJson(_res, code, body) {
      sent = { kind: 'json', code, body }
    },
    sendError(_res, code, msg) {
      sent = { kind: 'error', code, body: msg }
    },
  }
  return {
    deps,
    sent: () => sent,
    getOrCreateCalled: () => getOrCreateCalled,
    getOrCreateAgentId: () => getOrCreateAgentId,
  }
}

test('/v1/models hides hidden system agents', async () => {
  const rig = makeDeps()
  const handled = await handleOpenAIRequest(
    { method: 'GET' } as IncomingMessage,
    {} as ServerResponse,
    new URL('http://localhost/v1/models'),
    rig.deps,
  )

  assert.equal(handled, true)
  const sent = rig.sent()
  assert.equal(sent?.kind, 'json')
  assert.equal(sent?.code, 200)
  assert.deepEqual(
    ((sent?.body as { data: Array<{ id: string }> }).data).map((m) => m.id),
    ['main', 'market-writer'],
  )
})

test('/v1/chat/completions rejects hidden system agent model before session creation', async () => {
  const rig = makeDeps(async () =>
    JSON.stringify({
      model: 'hidden-reviewer',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  )
  const handled = await handleOpenAIRequest(
    { method: 'POST' } as IncomingMessage,
    {} as ServerResponse,
    new URL('http://localhost/v1/chat/completions'),
    rig.deps,
  )

  assert.equal(handled, true)
  assert.deepEqual(rig.sent(), {
    kind: 'error',
    code: 404,
    body: 'model/agent "hidden-reviewer" not found',
  })
  assert.equal(rig.getOrCreateCalled(), false)
})

test('/v1/chat/completions falls back to main when stored default is hidden', async () => {
  const rig = makeDeps(
    async () =>
      JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    { defaultAgent: 'hidden-reviewer' },
  )
  const handled = await handleOpenAIRequest(
    { method: 'POST' } as IncomingMessage,
    {} as ServerResponse,
    new URL('http://localhost/v1/chat/completions'),
    rig.deps,
  )

  assert.equal(handled, true)
  assert.equal(rig.getOrCreateAgentId(), 'main')
  assert.equal(rig.sent()?.kind, 'json')
  assert.equal(rig.sent()?.code, 200)
  assert.equal((rig.sent()?.body as { model: string }).model, 'main')
})
