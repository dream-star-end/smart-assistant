import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { getDefaultAppState } from '../../state/AppStateStore.ts'
import { enableConfigs } from '../../utils/config.ts'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.ts'
import { compactConversation, partialCompactConversation } from './compact.ts'

delete process.env.NODE_ENV
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.CLAUDE_CODE_MAX_RETRIES = '0'
enableConfigs()

type Mode = '403' | '429' | '500' | 'quote' | 'quoted_ptl' | 'transient' | 'ptl_then_ok' | 'abort'

function context() {
  const appState = getDefaultAppState()
  const readFileState = createFileStateCacheWithSizeLimit(100)
  readFileState.set('/tmp/kept.ts', {
    content: 'cache-sentinel',
    timestamp: 1,
    offset: undefined,
    limit: undefined,
  })
  return {
    abortController: new AbortController(),
    readFileState,
    messages: [],
    setAppState: () => {},
    setResponseLength: () => {},
    setInProgressToolUseIDs: () => {},
    getAppState: () => appState,
    options: {
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [],
      mcpClients: [],
      commands: [],
      thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
  }
}

function sse(res: import('node:http').ServerResponse, text: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_q","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
  res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
  res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`)
  res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n')
  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  res.end()
}

const ABORT_HANG_MS = 8000
const ABORT_REPEATS = 5

async function listen(
  mode: Mode,
  onRequest?: () => void,
): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    hits += 1
    req.resume()
    if (mode === 'abort') {
      onRequest?.()
      return
    }
    if (mode === 'transient' && hits === 1) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'status 403' } }))
      return
    }
    if (mode === 'ptl_then_ok' && hits === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'prompt is too long: 200000 tokens > 100000 maximum' },
      }))
      return
    }
    if (mode === '403' || mode === '429' || mode === '500') {
      res.writeHead(Number(mode), { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `status ${mode}` } }))
      return
    }
    const text = mode === 'quoted_ptl'
      ? 'Prompt is too long: this is a quoted error; preserve the user goal.'
      : 'The log says API Error: 403 but the goal remains.'
    sse(res, text)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

const messages = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'keep the goal' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'continue the goal' } },
] as never

async function run(mode: Mode, kind: 'full' | 'partial', history: typeof messages = messages) {
  const ctx = context()
  const listener = await listen(mode, () => {
    if (mode === 'abort') ctx.abortController.abort()
  })
  delete process.env.NODE_ENV
  process.env.ANTHROPIC_BASE_URL = listener.url
  const params = {
    systemPrompt: [] as never,
    userContext: {},
    systemContext: {},
    toolUseContext: ctx as never,
    forkContextMessages: history as never,
  }
  let hang: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = kind === 'full'
      ? compactConversation(history, ctx as never, params, false, 'preserve goal', true)
      : partialCompactConversation(history, 1, ctx as never, params, 'preserve goal', 'from')
    const summary = mode === 'abort'
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            hang = setTimeout(
              () => reject(new Error('abort fixture hung waiting for the request')),
              ABORT_HANG_MS,
            )
          }),
        ])
      : await pending
    return { summary, hits: listener.hits(), error: undefined as unknown, cached: ctx.readFileState.has('/tmp/kept.ts') }
  } catch (error) {
    return { summary: undefined, hits: listener.hits(), error, cached: ctx.readFileState.has('/tmp/kept.ts') }
  } finally {
    if (hang) clearTimeout(hang)
    listener.close()
  }
}

function textOf(summary: { summaryMessages?: { message?: { content?: unknown } }[] } | undefined) {
  return String(summary?.summaryMessages?.[0]?.message?.content ?? '')
}

describe('ordinary compact rejects a typed error before a boundary', () => {
  test('full compact keeps a quoted error and rejects 403, 429, and 500 in one request', async () => {
    const quote = await run('quote', 'full')
    expect(quote.error).toBeUndefined()
    expect(textOf(quote.summary as never)).toContain('goal remains')
    expect((quote.summary as { boundaryMarker?: { subtype?: string } }).boundaryMarker?.subtype).toBe('compact_boundary')

    for (const mode of ['403', '429', '500'] as const) {
      const result = await run(mode, 'full')
      expect(result.hits).toBe(1)
      expect(result.summary).toBeUndefined()
      expect(result.cached).toBe(true)
      expect(String(result.error)).toContain('IDLE_SUMMARY_REJECTED')
    }

    const transient = await run('transient', 'full')
    expect(transient.hits).toBe(1)
    expect(transient.summary).toBeUndefined()
    expect(String(transient.error)).toContain('IDLE_SUMMARY_REJECTED')
    expect(transient.cached).toBe(true)
  })

  test('partial compact has the same gate', async () => {
    const quote = await run('quote', 'partial')
    expect(quote.error).toBeUndefined()
    expect(textOf(quote.summary as never)).toContain('API Error: 403')
    const failed = await run('403', 'partial')
    expect(failed.hits).toBe(1)
    expect(failed.summary).toBeUndefined()
    expect(failed.cached).toBe(true)
    expect(String(failed.error)).toContain('IDLE_SUMMARY_REJECTED')
  })

  test('a quoted prompt-too-long line is a summary, a typed one retries once', async () => {
    const quoted = await run('quoted_ptl', 'full')
    expect(quoted.error).toBeUndefined()
    expect(quoted.hits).toBe(1)
    expect(textOf(quoted.summary as never)).toContain('quoted error')
    const rounds = [
      { type: 'user', uuid: 'p1', message: { role: 'user', content: 'round one' } },
      { type: 'assistant', uuid: 'p2', message: { id: 'round-a', role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
      { type: 'user', uuid: 'p3', message: { role: 'user', content: 'round two' } },
      { type: 'assistant', uuid: 'p4', message: { id: 'round-b', role: 'assistant', content: [{ type: 'text', text: 'b' }] } },
    ] as never
    const retried = await run('ptl_then_ok', 'full', rounds)
    expect(retried.error).toBeUndefined()
    expect(retried.hits).toBe(2)
    expect(textOf(retried.summary as never)).toContain('goal remains')
  })

  test('abort does not compact or send a second summary', async () => {
    for (let attempt = 0; attempt < ABORT_REPEATS; attempt++) {
      const result = await run('abort', 'full')
      expect(result.hits).toBe(1)
      expect(result.summary).toBeUndefined()
      expect(result.cached).toBe(true)
      expect(String(result.error)).toContain('aborted')
    }
  })
})
