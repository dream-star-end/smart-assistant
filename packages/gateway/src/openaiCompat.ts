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
import type { RunLog } from './runLog.js'
import type { SessionManager } from './sessionManager.js'

export interface OpenAICompatDeps {
  config: OpenClaudeConfig
  agentsConfig: AgentsConfig
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
  const models = deps.agentsConfig.agents.map((a) => ({
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
  const agentId = parsed.model || deps.agentsConfig.default || 'main'
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
  const session = await deps.sessions.getOrCreate({
    sessionKey,
    agent,
    channel: 'openai-compat',
    peerId: 'openai-client',
    title: lastUser.content.slice(0, 40),
  })

  const requestId = `chatcmpl-${Date.now().toString(36)}`
  const _oaiRun = deps.runLog.start({ agentId, sessionKey, taskType: 'openai-compat' })

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
      })
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
      await deps.sessions.submit(session, prompt, (e) => {
        if (e.kind === 'block' && e.block.kind === 'text') output += (e.block as any).text
        if (e.kind === 'error') error = e.error
      })
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
