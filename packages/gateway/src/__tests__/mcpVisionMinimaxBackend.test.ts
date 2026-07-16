import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { STATIC_KEY_PROVIDERS } from '@openclaude/protocol'
import {
  LOCAL_CATALOG_HEADER,
  ModelCatalogUnavailableError,
  _setModelCatalogClientForTests,
  type ModelCatalogClient,
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

describe('shouldEnableOpenClaudeVision gating', () => {
  it('catalog supportsVision override 是最高权威(动态 model id 不查 baked 表)', () => {
    assert.equal(vision.shouldEnableOpenClaudeVision('unknown', 'dynamic-model', false), true)
    assert.equal(vision.shouldEnableOpenClaudeVision('deepseek', 'deepseek-v4-pro', true), false)
  })
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
    assert.equal(vision.shouldEnableOpenClaudeVision('codex-native', 'gpt-5.6-sol'), false)
  })
  it('OPENCLAUDE_VISION_MCP_DISABLED=1 → 全 false', async () => {
    await withEnv({ OPENCLAUDE_VISION_MCP_DISABLED: '1' }, () => {
      assert.equal(vision.shouldEnableOpenClaudeVision('ark', 'glm-5.2'), false)
    })
  })
  it('纯文本静态新成员(qwen3.7-max/plus / kimi-k2.7-code,supportsVision=false)→ true', () => {
    // 派生自 protocol supportsVision,不再依赖 gateway 侧字面量 allowlist。
    assert.equal(vision.shouldEnableOpenClaudeVision('opencodego', 'qwen3.7-max'), true)
    assert.equal(vision.shouldEnableOpenClaudeVision('opencodego', 'qwen3.7-plus'), true)
    assert.equal(vision.shouldEnableOpenClaudeVision('kimi', 'kimi-k2.7-code'), true)
  })
  it('OPENCLAUDE_VISION_MCP_PROVIDERS opt-in → 非静态 provider 也注入', async () => {
    await withEnv({ OPENCLAUDE_VISION_MCP_PROVIDERS: 'customtext' }, () => {
      assert.equal(vision.shouldEnableOpenClaudeVision('customtext', 'some-text-model'), true)
      assert.equal(vision.shouldEnableOpenClaudeVision('otherprov', 'some-text-model'), false)
    })
  })
})

// 反漂移守护:gateway 的识图工具 gating 必须逐 spec 等于 protocol 的 supportsVision
// 权威(纯文本 supportsVision!==true → 注入)。新增静态模型只要在 protocol 登记,
// 本断言自动覆盖 —— 忘同步 gateway 字面量导致"发图无识图工具"的漂移不可能再发生。
describe('vision gating 派生自 protocol supportsVision(反漂移)', () => {
  it('每个静态 provider 的每个 inbound model:shouldEnable === (supportsVision !== true)', () => {
    for (const p of STATIC_KEY_PROVIDERS) {
      const expected = p.supportsVision !== true
      for (const modelId of p.inboundModelIds) {
        assert.equal(
          vision.shouldEnableOpenClaudeVision(p.id, modelId),
          expected,
          `${p.id}/${modelId}: shouldEnable 应 === supportsVision!==true (${expected})`,
        )
        // isTextOnlyStaticVisionModel 是 gating 的派生核心,单独锁一遍。
        assert.equal(vision.isTextOnlyStaticVisionModel(modelId), expected, `${modelId} textOnly`)
      }
    }
  })
  it('非静态模型(claude/codex/未注册)→ isTextOnlyStaticVisionModel false', () => {
    assert.equal(vision.isTextOnlyStaticVisionModel('claude-opus-4-8'), false)
    assert.equal(vision.isTextOnlyStaticVisionModel('gpt-5.6-sol'), false)
    assert.equal(vision.isTextOnlyStaticVisionModel('totally-unknown-model'), false)
    assert.equal(vision.isTextOnlyStaticVisionModel(undefined), false)
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
    // 模型权威凭据:vision 属本地路径,必须带 local catalog token,否则 enforce 后
    // 被 anthropic proxy 以 MODEL_AUTHORITY_INVALID 拒(2026-07-16 巡检根因)。
    assert.equal(captured.init?.headers[LOCAL_CATALOG_HEADER], 'cat-tok')
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
