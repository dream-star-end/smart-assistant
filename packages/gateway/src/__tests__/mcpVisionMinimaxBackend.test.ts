import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  LOCAL_CATALOG_HEADER,
  type ModelCatalogClient,
  ModelCatalogUnavailableError,
  _setModelCatalogClientForTests,
} from '../modelCatalogClient.js'

const home = mkdtempSync(join(tmpdir(), 'oc-vision-mm-'))
process.env.OPENCLAUDE_HOME = home
// 锁域按测试进程隔离(与 mcpVisionServer.test.ts 同理):否则并行文件抢同一把
// 宿主 /tmp slot 锁,偶发 "another image understanding request is already running"。
process.env.OPENCLAUDE_VISION_LOCK_DIR = mkdtempSync(join(tmpdir(), 'oc-vision-mm-lock-'))

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

describe('vision backend cap/timeout(商业版与 selfhost 默认 Grok 4.7)', () => {
  it('默认(无 env)→ grok backend,cap 5MB / 120s', async () => {
    await withEnv({ OPENCLAUDE_VISION_BACKEND: undefined }, () => {
      const p = join(uploads, 'a.png')
      writeFileSync(p, PNG)
      const r = vision.resolveVisionInput({ image_file: p })
      assert.equal(vision.visionBackend(), 'grok')
      assert.equal(vision.visionBackendLabel(), 'grok-build')
      assert.equal(r.maxImageBytes, 5 * 1024 * 1024)
      assert.equal(r.timeoutMs, 120_000)
    })
  })
  it('未知的 OPENCLAUDE_VISION_BACKEND 值不改变默认(仍是 grok)', async () => {
    await withEnv({ OPENCLAUDE_VISION_BACKEND: 'k3' }, () => {
      assert.equal(vision.visionBackend(), 'grok')
    })
  })
  it('OPENCLAUDE_VISION_BACKEND=minimax 显式固定 → cap 5MB / 60s', async () => {
    await withEnv({ OPENCLAUDE_VISION_BACKEND: 'minimax' }, () => {
      const p = join(uploads, 'a2.png')
      writeFileSync(p, PNG)
      const r = vision.resolveVisionInput({ image_file: p })
      assert.equal(vision.visionBackendLabel(), 'k3-256k')
      assert.equal(r.maxImageBytes, 5 * 1024 * 1024)
      assert.equal(r.timeoutMs, 60_000)
    })
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
  // 模型权威批次后 vision 走本地路径凭据:注入假 catalog client(真 client 会去打
  // master 的 /internal/v3/model-catalog,测试环境不可达)。
  before(() => {
    _setModelCatalogClientForTests({
      configured: true,
      getToken: async () => 'cat-tok',
      getView: async () => {
        throw new Error('view not used in vision tests')
      },
    } as unknown as ModelCatalogClient)
  })
  after(() => {
    _setModelCatalogClientForTests(null)
  })

  it('经 anthropic proxy 发 k3-256k + image,解析 SSE text_delta', async () => {
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
    // 模型权威凭据:vision 属本地路径,必须带 local catalog token,否则 enforce 后
    // 被 anthropic proxy 以 MODEL_AUTHORITY_INVALID 拒(2026-07-16 巡检根因)。
    assert.equal(captured.init?.headers[LOCAL_CATALOG_HEADER], 'cat-tok')
    const body = JSON.parse(captured.init?.body as string)
    assert.equal(body.model, 'k3-256k')
    assert.equal(vision.STATIC_VISION_MODEL, 'k3-256k')
    assert.ok(typeof body.max_tokens === 'number' && body.max_tokens > 0)
    const content = body.messages[0].content
    assert.equal(content[0].type, 'image')
    assert.equal(content[0].source.media_type, 'image/png')
    assert.ok(typeof content[0].source.data === 'string' && content[0].source.data.length > 0)
    assert.equal(content[1].type, 'text')
  })

  it('scrubbed Codex shell uses paired container-auth.json for proxy URL and bearer', async () => {
    const p = join(uploads, 'paired.png')
    writeFileSync(p, PNG)
    const authHome = join(home, 'paired-auth')
    mkdirSync(authHome, { recursive: true })
    writeFileSync(
      join(authHome, 'container-auth.json'),
      JSON.stringify({
        masterBaseUrl: 'http://paired.internal:18791',
        containerToken: 'oc-v5.paired',
      }),
      { mode: 0o600 },
    )
    let seenUrl = ''
    let seenAuthorization = ''
    await withEnv(
      {
        OPENCLAUDE_HOME: authHome,
        ANTHROPIC_BASE_URL: undefined,
        OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
        OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
      },
      async () => {
        const orig = globalThis.fetch
        globalThis.fetch = (async (url: unknown, init: RequestInit) => {
          seenUrl = String(url)
          seenAuthorization = String((init.headers as Record<string, string>).authorization)
          return new Response(
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }) as typeof fetch
        try {
          const input = vision.resolveVisionInput({ image_file: p })
          assert.equal(await vision.runMinimaxVisionForTest(input), 'ok')
        } finally {
          globalThis.fetch = orig
        }
      },
    )
    assert.equal(seenUrl, 'http://paired.internal:18791/v1/messages')
    assert.equal(seenAuthorization, 'Bearer oc-v5.paired')
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

  it('catalog token 拿不到 → fail-closed 报错(不发无凭据请求)', async () => {
    const p = join(uploads, 'g.png')
    writeFileSync(p, PNG)
    _setModelCatalogClientForTests({
      configured: true,
      getToken: async () => {
        throw new ModelCatalogUnavailableError('master unreachable')
      },
      getView: async () => {
        throw new Error('unused')
      },
    } as unknown as ModelCatalogClient)
    try {
      await withEnv(
        {
          ANTHROPIC_BASE_URL: 'http://x',
          OPENCLAUDE_V3_CONTAINER_TOKEN: 'b',
          OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
        },
        async () => {
          const orig = globalThis.fetch
          globalThis.fetch = (async () => {
            throw new Error('must not reach fetch without catalog token')
          }) as typeof fetch
          try {
            await assert.rejects(
              () => vision.runMinimaxVisionForTest(vision.resolveVisionInput({ image_file: p })),
              /model catalog token unavailable/,
            )
          } finally {
            globalThis.fetch = orig
          }
        },
      )
    } finally {
      // 恢复本套件默认的可用假 client(before 里那只)。
      _setModelCatalogClientForTests({
        configured: true,
        getToken: async () => 'cat-tok',
        getView: async () => {
          throw new Error('view not used in vision tests')
        },
      } as unknown as ModelCatalogClient)
    }
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
