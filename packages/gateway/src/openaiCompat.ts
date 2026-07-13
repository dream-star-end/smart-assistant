/**
 * OpenAI-compatible API layer.
 *
 * Provides `/v1/chat/completions` and `/v1/models` endpoints so that
 * OpenClaude can be used as a drop-in backend for Open WebUI, LobeChat,
 * and other OpenAI-compatible clients.
 *
 * Limitations (documented, not hidden):
 * - Only text messages are supported (no vision/audio in this layer)
 * - Tool calls in the response use a simplified mapping
 * - Function calling is not supported as input
 * - No embeddings or image generation endpoints
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentsConfig, OpenClaudeConfig } from '@openclaude/storage'
import { isHiddenSystemAgentId, userVisibleDefaultAgentId } from './agentVisibility.js'
import type { RunLog } from './runLog.js'
import type { SessionManager } from './sessionManager.js'
// 合成首帧执行模型解析:openai-compat 首帧绕过 master bridge 计费编排,落 codex 会被
// CODEX_BILLING_GUARD 拒 → 解析为非 codex 执行模型。server.ts 已 import 本文件,live
// binding 在运行期调用安全(同 cron.ts 沿用的既有循环容忍模式)。
import {
  localExecutionOverride,
  resolveLocalExecutionIfEnforced,
  resolveSyntheticTurnModel,
  type LocalExecutionDecision,
} from './server.js'
import { localExecutionRejectCode } from './modelCatalogClient.js'

export interface OpenAICompatDeps {
  config: OpenClaudeConfig
  /** 全量 agents 配置 —— 用于 /v1/chat/completions 的目标解析与拒绝(判定面)。 */
  agentsConfig: AgentsConfig
  /** 用户可见投影(隐藏系统 agent 已剔除)—— /v1/models 枚举面消费。 */
  agentsConfigUserView: AgentsConfig
  sessions: SessionManager
  runLog: RunLog
  readBody: (req: IncomingMessage) => Promise<string>
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  sendError: (res: ServerResponse, code: number, msg: string) => void
}

/**
 * Handle an OpenAI-compatible API request.
 * Returns true if the request was handled, false if it's not an OpenAI endpoint.
 */
export async function handleOpenAIRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: OpenAICompatDeps,
): Promise<boolean> {
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    await handleModels(res, deps)
    return true
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res, deps)
    return true
  }
  return false
}

// ── GET /v1/models ──

async function handleModels(res: ServerResponse, deps: OpenAICompatDeps): Promise<void> {
  // 枚举面:直接消费用户可见投影(隐藏系统 agent 已在 server 侧剔除)。
  const models = deps.agentsConfigUserView.agents.map((a) => ({
    id: a.id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'openclaude',
  }))
  deps.sendJson(res, 200, { object: 'list', data: models })
}

// ── POST /v1/chat/completions ──

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatRequest {
  model?: string // maps to agent ID
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpenAICompatDeps,
): Promise<void> {
  const body = await deps.readBody(req)
  let parsed: ChatRequest
  try {
    parsed = JSON.parse(body)
  } catch {
    return deps.sendError(res, 400, 'invalid JSON')
  }

  if (!parsed.messages || parsed.messages.length === 0) {
    return deps.sendError(res, 400, 'messages array required')
  }

  // Map model → agent (default to first agent or 'main')
  const agentId = parsed.model || userVisibleDefaultAgentId(deps.agentsConfig.default)
  if (isHiddenSystemAgentId(agentId)) {
    return deps.sendError(res, 404, `model/agent "${agentId}" not found`)
  }
  const agent = deps.agentsConfig.agents.find((a) => a.id === agentId)
  if (!agent) {
    return deps.sendError(res, 404, `model/agent "${agentId}" not found`)
  }

  // Extract the last user message as the prompt
  const userMessages = parsed.messages.filter((m) => m.role === 'user')
  const lastUser = userMessages[userMessages.length - 1]
  if (!lastUser) {
    return deps.sendError(res, 400, 'at least one user message required')
  }

  // Build context from system + previous messages
  const systemMsg = parsed.messages.find((m) => m.role === 'system')
  const contextParts: string[] = []
  if (systemMsg) contextParts.push(`[System] ${systemMsg.content}`)
  // Include conversation history (last 10 turns max)
  const history = parsed.messages.filter((m) => m.role !== 'system').slice(-20)
  for (const m of history.slice(0, -1)) {
    contextParts.push(`[${m.role === 'user' ? 'User' : 'Assistant'}] ${m.content}`)
  }

  const prompt =
    contextParts.length > 0
      ? `${contextParts.join('\n\n')}\n\n[User] ${lastUser.content}`
      : lastUser.content

  const sessionKey = `agent:${agentId}:openai:dm:${Date.now()}`
  const _oaiRoute = resolveSyntheticTurnModel(agent, deps.config.defaults?.model)
  // 模型权威 §3(无 envelope 的本地路径):flag 开 → 判定源换成 master catalog 投影
  // (归一/可用性/engine 全取投影;codex 意图仍按真值表降级)。拒 → 结构化 4xx/503,不 spawn。
  // flag 未开 → undefined → 沿用 baked 合成降级,零变化。
  let _oaiExec: LocalExecutionDecision | undefined
  try {
    _oaiExec = await resolveLocalExecutionIfEnforced({
      agent,
      kind: 'synthetic',
      model: _oaiRoute?.model,
      defaultModel: deps.config.defaults?.model,
    })
  } catch (err) {
    const code = localExecutionRejectCode(err)
    if (!code) throw err
    const status = code === 'MODEL_CATALOG_UNAVAILABLE' ? 503 : 403
    return deps.sendError(res, status, code)
  }
  const _oaiModel = _oaiExec?.canonicalModel ?? _oaiRoute?.model
  const session = await deps.sessions.getOrCreate({
    sessionKey,
    agent,
    ...(_oaiModel ? { model: _oaiModel } : {}),
    ...localExecutionOverride(_oaiExec),
    channel: 'openai-compat',
    peerId: 'openai-client',
    title: lastUser.content.slice(0, 40),
  })

  // MAJOR-2 透明化(API 客户端面):合成首帧解析为 codex 时被降级到非 codex 执行模型。
  // OpenAI `model` 字段是**客户端请求回显**(客户端发的是 agentId,非模型名),保持回显
  // agentId 以不破坏按 model 名匹配的 OpenAI 客户端契约;降级信息改用扩展字段
  // `x_openclaude_effective_model` 显式暴露(元数据级,不藏),并落 runLog(doctor 面)。
  const _oaiEffective = _oaiRoute ? { x_openclaude_effective_model: _oaiRoute.model } : {}
  const requestId = `chatcmpl-${Date.now().toString(36)}`
  const _oaiRun = deps.runLog.start({
    agentId,
    sessionKey,
    taskType: 'openai-compat',
    ...(_oaiRoute ? { effectiveModel: _oaiRoute.model } : {}),
  })

  if (parsed.stream) {
    // ── SSE streaming ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Request-Id': requestId,
    })

    try {
      await deps.sessions.submit(session, prompt, (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') {
          const chunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: agentId,
            choices: [
              {
                index: 0,
                delta: { content: (e.block as any).text },
                finish_reason: null,
              },
            ],
          }
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        if (e.kind === 'final') {
          deps.runLog.complete(_oaiRun, { status: 'completed' })
          const done = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: agentId,
            ..._oaiEffective,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }
          res.write(`data: ${JSON.stringify(done)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
        if (e.kind === 'error') {
          deps.runLog.complete(_oaiRun, { status: 'failed', error: e.error })
          const errChunk = {
            error: { message: e.error, type: 'server_error' },
          }
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`)
          res.end()
        }
      }, undefined, _oaiModel)
    } catch (err: any) {
      deps.runLog.complete(_oaiRun, { status: 'failed', error: String(err) })
      try {
        res.write(
          `data: ${JSON.stringify({ error: { message: String(err), type: 'server_error' } })}\n\n`,
        )
        res.end()
      } catch {}
    }
  } else {
    // ── Non-streaming ──
    let output = ''
    let error = ''
    try {
      await deps.sessions.submit(
        session,
        prompt,
        (e) => {
          if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
          if (e.kind === 'error') error = e.error
        },
        undefined,
        _oaiModel,
      )
    } catch (err: any) {
      error = error || String(err)
    }

    if (error) {
      deps.runLog.complete(_oaiRun, { status: 'failed', error })
      // If there's partial output, include it with a truncated finish_reason
      // so the client knows this response is incomplete.
      if (output) {
        deps.sendJson(res, 200, {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: agentId,
          ..._oaiEffective,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `${output}\n\n[error: ${error}]` },
              finish_reason: 'length',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      } else {
        deps.sendJson(res, 500, {
          error: { message: error, type: 'server_error', code: 'internal_error' },
        })
      }
      return
    }

    deps.runLog.complete(_oaiRun, { status: 'completed' })
    deps.sendJson(res, 200, {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: agentId,
      ..._oaiEffective,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: output },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }
}
