import { describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { enableConfigs } from '../../utils/config.ts'
import { summarizeMessagesForIdle } from './compact.ts'

delete process.env.NODE_ENV
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.CLAUDE_CODE_MAX_RETRIES = '0'
enableConfigs()

function context() {
  const appState = {
    toolPermissionContext: { mode: 'default' },
    effortValue: undefined,
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    options: {
      mainLoopModel: 'claude-sonnet-4-5',
      tools: [],
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
  }
}

async function listen(mode: '403' | '429' | '500' | 'partial' | 'quote' | 'ptl'): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    if (mode === '403' || mode === '429' || mode === '500' || mode === 'ptl') {
      const status = mode === 'ptl' ? 400 : Number(mode)
      const message = mode === 'ptl' ? 'prompt is too long: 200000 tokens > 100000 maximum' : `status ${mode}`
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
      return
    }
    if (mode === 'partial') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial summary that must not be kept"}}\n\n')
      res.end()
      return
    }
    const text = 'The log says API Error: 403 but the goal remains.'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_q","type":"message","role":"assistant","content":[],"model":"claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n')
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
    res.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`)
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n')
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, url: `http://127.0.0.1:${address.port}`, hits: () => hits }
}

async function run(mode: '403' | '429' | '500' | 'partial' | 'quote' | 'ptl') {
  const listener = await listen(mode)
  delete process.env.NODE_ENV
  process.env.ANTHROPIC_BASE_URL = listener.url
  try {
    const summary = await summarizeMessagesForIdle(
      [{ type: 'user', uuid: 'u', message: { role: 'user', content: 'keep the goal' } }] as never,
      context() as never,
      {
        systemPrompt: [] as never,
        userContext: {},
        systemContext: {},
        toolUseContext: context() as never,
        forkContextMessages: [],
      },
    )
    return { summary, hits: listener.hits(), error: undefined as unknown }
  } catch (error) {
    return { summary: undefined as string | undefined, hits: listener.hits(), error }
  } finally {
    listener.server.close()
  }
}

describe('idle summary HTTP', () => {
  test('403, 429 and 500 are typed failures, not summary text', async () => {
    for (const mode of ['403', '429', '500'] as const) {
      const result = await run(mode)
      expect(result.hits).toBeGreaterThan(0)
      expect(result.summary).toBeUndefined()
      expect(String(result.error)).toContain('IDLE_SUMMARY_REJECTED')
    }
  })

  test('a partial stream is not accepted as the summary', async () => {
    const result = await run('partial')
    expect(result.hits).toBeGreaterThan(0)
    expect(result.summary).toBeUndefined()
    expect(String(result.error)).not.toContain('partial summary that must not be kept')
  })

  test('a finished summary may quote an API error', async () => {
    const result = await run('quote')
    expect(result.error).toBeUndefined()
    expect(result.summary).toContain('API Error: 403')
    expect(result.summary).toContain('goal remains')
  })

  test('a typed prompt-too-long response retries and then fails closed', async () => {
    const result = await run('ptl')
    expect(result.hits).toBeGreaterThan(0)
    expect(result.summary).toBeUndefined()
    expect(String(result.error)).toContain('Conversation too long to summarize')
  })
})
