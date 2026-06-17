import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-vision-mm-'))
process.env.OPENCLAUDE_HOME = home

const vision = await import('../mcpVisionServer.js')

const uploads = join(home, 'uploads')
mkdirSync(uploads, { recursive: true })
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('shouldEnableOpenClaudeVision gating', () => {
  it('纯文本静态模型(deepseek/glm-5.1/glm-5.2)→ true', () => {
    assert.equal(vision.shouldEnableOpenClaudeVision('deepseek', 'deepseek-v4-pro'), true)
    assert.equal(vision.shouldEnableOpenClaudeVision('ark', 'glm-5.1'), true)
    assert.equal(vision.shouldEnableOpenClaudeVision('ark', 'glm-5.2'), true)
    assert.equal(vision.shouldEnableOpenClaudeVision(undefined, 'GLM-5.2'), true)
  })
  it('MiniMax-M3(原生多模态)→ false(它直接识图,不注入工具)', () => {
    assert.equal(vision.shouldEnableOpenClaudeVision('minimax', 'MiniMax-M3'), false)
    assert.equal(vision.shouldEnableOpenClaudeVision('minimax', 'minimax-m3'), false)
  })
  it('多模态/未知模型 → false', () => {
    assert.equal(
      vision.shouldEnableOpenClaudeVision('claude-subscription', 'claude-opus-4-7'),
      false,
    )
    assert.equal(vision.shouldEnableOpenClaudeVision('codex-native', 'gpt-5.5'), false)
  })
  it('OPENCLAUDE_VISION_MCP_DISABLED=1 → 全 false', async () => {
    await withEnv({ OPENCLAUDE_VISION_MCP_DISABLED: '1' }, () => {
      assert.equal(vision.shouldEnableOpenClaudeVision('ark', 'glm-5.2'), false)
    })
  })
})

describe('vision backend cap/timeout(默认 minimax)', () => {
  it('默认 minimax → cap 5MB / 60s', () => {
    const p = join(uploads, 'a.png')
    writeFileSync(p, PNG)
    const r = vision.resolveVisionInput({ image_file: p })
    assert.equal(r.maxImageBytes, 5 * 1024 * 1024)
    assert.equal(r.timeoutMs, 60_000)
  })
  it('OPENCLAUDE_VISION_BACKEND=codex → cap 20MB / 120s', async () => {
    await withEnv({ OPENCLAUDE_VISION_BACKEND: 'codex' }, () => {
      const p = join(uploads, 'b.png')
      writeFileSync(p, PNG)
      const r = vision.resolveVisionInput({ image_file: p })
      assert.equal(r.maxImageBytes, 20 * 1024 * 1024)
      assert.equal(r.timeoutMs, 120_000)
    })
  })
})

describe('runMinimaxVision', () => {
  it('经 anthropic proxy 发 MiniMax-M3 + image,解析 SSE text_delta', async () => {
    const p = join(uploads, 'c.png')
    writeFileSync(p, PNG)
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}',
      '',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    let captured: { url?: string; init?: { headers?: any; body?: string } } = {}
    await withEnv(
      {
        ANTHROPIC_BASE_URL: 'http://172.30.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.bearer',
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
      },
      async () => {
        const orig = globalThis.fetch
        globalThis.fetch = (async (url: unknown, init: unknown) => {
          captured = { url: String(url), init: init as { headers?: any; body?: string } }
          return new Response(sse, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        }) as typeof fetch
        try {
          const input = vision.resolveVisionInput({ image_file: p, question: 'q' })
          const text = await vision.runMinimaxVisionForTest(input)
          assert.equal(text, 'hello world')
        } finally {
          globalThis.fetch = orig
        }
      },
    )
    assert.equal(captured.url, 'http://172.30.0.1:18791/v1/messages')
    assert.equal(captured.init?.headers.authorization, 'Bearer oc-v3.bearer')
    const body = JSON.parse(captured.init?.body as string)
    assert.equal(body.model, 'MiniMax-M3')
    assert.ok(typeof body.max_tokens === 'number' && body.max_tokens > 0)
    const content = body.messages[0].content
    assert.equal(content[0].type, 'image')
    assert.equal(content[0].source.media_type, 'image/png')
    assert.ok(typeof content[0].source.data === 'string' && content[0].source.data.length > 0)
    assert.equal(content[1].type, 'text')
  })

  it('上游非 2xx → 抛错(不 fallback)', async () => {
    const p = join(uploads, 'd.png')
    writeFileSync(p, PNG)
    await withEnv(
      {
        ANTHROPIC_BASE_URL: 'http://x',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'b',
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
      },
      async () => {
        const orig = globalThis.fetch
        globalThis.fetch = (async () =>
          new Response('{"error":"nope"}', { status: 403 })) as typeof fetch
        try {
          const input = vision.resolveVisionInput({ image_file: p })
          await assert.rejects(() => vision.runMinimaxVisionForTest(input), /upstream 403/)
        } finally {
          globalThis.fetch = orig
        }
      },
    )
  })

  it('SSE 含 error 事件 → 抛错(即使已有 partial text,不当成功返回)', async () => {
    const p = join(uploads, 'f.png')
    writeFileSync(p, PNG)
    const sse = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
      '',
      'data: {"type":"error","error":{"message":"upstream boom"}}',
      '',
    ].join('\n')
    await withEnv(
      {
        ANTHROPIC_BASE_URL: 'http://x',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'b',
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
      },
      async () => {
        const orig = globalThis.fetch
        globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch
        try {
          await assert.rejects(
            () => vision.runMinimaxVisionForTest(vision.resolveVisionInput({ image_file: p })),
            /upstream error: upstream boom/,
          )
        } finally {
          globalThis.fetch = orig
        }
      },
    )
  })

  it('bearer 优先 token file(不用 raw env)', async () => {
    const p = join(uploads, 'e.png')
    writeFileSync(p, PNG)
    const tf = join(home, 'tok')
    writeFileSync(tf, 'file-bearer\n')
    let auth = ''
    await withEnv(
      {
        ANTHROPIC_BASE_URL: 'http://x',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'raw-should-not-win',
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: tf,
      },
      async () => {
        const orig = globalThis.fetch
        globalThis.fetch = (async (_u: unknown, init: { headers?: any }) => {
          auth = init.headers.authorization
          return new Response(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
            { status: 200 },
          )
        }) as unknown as typeof fetch
        try {
          await vision.runMinimaxVisionForTest(vision.resolveVisionInput({ image_file: p }))
        } finally {
          globalThis.fetch = orig
        }
      },
    )
    assert.equal(auth, 'Bearer file-bearer')
  })
})
