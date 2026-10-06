import * as assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GROK_VISION_PATH } from '@openclaude/protocol'

const home = mkdtempSync(join(tmpdir(), 'oc-vision-grok-'))
process.env.OPENCLAUDE_HOME = home
// 锁域按测试进程隔离(与 mcpVisionMinimaxBackend.test.ts 同理)。
process.env.OPENCLAUDE_VISION_LOCK_DIR = mkdtempSync(join(tmpdir(), 'oc-vision-grok-lock-'))

const vision = await import('../mcpVisionServer.js')

const uploads = join(home, 'uploads')
mkdirSync(uploads, { recursive: true })
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])

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

const ENV = {
  OPENCLAUDE_VISION_BACKEND: undefined,
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.bearer',
  OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
  // 故意指向别处:grok backend 不走 anthropic proxy,不能拿它当 master 地址。
  ANTHROPIC_BASE_URL: 'http://wrong.invalid:1',
}

type Captured = { url: string; init: { method?: string; headers?: any; body?: string } }

async function withFetch<T>(
  respond: (c: Captured) => Response | Promise<Response>,
  fn: (calls: Captured[]) => Promise<T>,
): Promise<T> {
  const calls: Captured[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const c = { url: String(url), init: (init ?? {}) as Captured['init'] }
    calls.push(c)
    return respond(c)
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = orig
  }
}

function image(name: string, bytes: Buffer): string {
  const p = join(uploads, name)
  writeFileSync(p, bytes)
  return p
}

describe('runGrokVision(默认识图后端 = Grok 4.7,经 master)', () => {
  it('把图片和问题 POST 给 master 的 grok-vision,返回识图文本', async () => {
    const p = image('g1.png', PNG)
    await withEnv(ENV, () =>
      withFetch(
        () => Response.json({ text: ' 785941\n', model: 'grok-build' }),
        async (calls) => {
          const input = vision.resolveVisionInput({ image_file: p, question: '图片上写的数字是什么？' })
          assert.equal(await vision.runVision(input), '785941')
          assert.equal(calls.length, 1)
          const call = calls[0]!
          assert.equal(call.url, `http://172.30.0.1:18791${GROK_VISION_PATH}`)
          assert.equal(call.url, 'http://172.30.0.1:18791/internal/v3/grok-vision')
          assert.equal(call.init.method, 'POST')
          assert.equal(call.init.headers.authorization, 'Bearer oc-v3.bearer')
          const body = JSON.parse(call.init.body as string)
          assert.deepEqual(Object.keys(body).sort(), ['image', 'prompt'])
          assert.deepEqual(body.image, { mediaType: 'image/png', data: PNG.toString('base64') })
          assert.match(body.prompt, /User question: 图片上写的数字是什么？/)
          // 模型由 master 决定;容器不选模型,也不带 anthropic proxy 的凭据头。
          assert.equal('model' in body, false)
          assert.equal(call.init.headers['x-oc-local-catalog'], undefined)
        },
      ),
    )
  })

  it('JPEG 按真实字节声明 media type', async () => {
    const p = image('g2.jpg', JPEG)
    await withEnv(ENV, () =>
      withFetch(
        () => Response.json({ text: 'ok' }),
        async (calls) => {
          await vision.runGrokVisionForTest(vision.resolveVisionInput({ image_file: p }))
          assert.equal(JSON.parse(calls[0]!.init.body as string).image.mediaType, 'image/jpeg')
        },
      ),
    )
  })

  it('master 的业务错误原样报出,不回退到别的后端', async () => {
    const p = image('g3.png', PNG)
    await withEnv(ENV, () =>
      withFetch(
        () =>
          new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_CREDITS', message: 'insufficient credits' } }), {
            status: 402,
          }),
        async (calls) => {
          await assert.rejects(
            () => vision.runVision(vision.resolveVisionInput({ image_file: p })),
            /grok vision upstream 402: .*INSUFFICIENT_CREDITS/,
          )
          assert.equal(calls.length, 1, '只打一次 master,不重试、不换后端')
        },
      ),
    )
  })

  it('200 但没有文本 / 不是 JSON → 报错', async () => {
    const p = image('g4.png', PNG)
    await withEnv(ENV, async () => {
      await withFetch(
        () => Response.json({ text: '   ' }),
        () => assert.rejects(() => vision.runGrokVisionForTest(vision.resolveVisionInput({ image_file: p })), /empty vision response/),
      )
      await withFetch(
        () => new Response('<html>', { status: 200 }),
        () => assert.rejects(() => vision.runGrokVisionForTest(vision.resolveVisionInput({ image_file: p })), /invalid JSON/),
      )
    })
  })

  it('容器没有 master 地址或 token → 不发请求', async () => {
    const p = image('g5.png', PNG)
    await withEnv(
      { ...ENV, OPENCLAUDE_V3_MASTER_BASE_URL: undefined, OPENCLAUDE_V3_CONTAINER_TOKEN: undefined, HOME: home },
      () =>
        withFetch(
          () => Response.json({ text: 'x' }),
          async (calls) => {
            await assert.rejects(
              () => vision.runGrokVisionForTest(vision.resolveVisionInput({ image_file: p })),
              /grok vision backend unavailable: container endpoint unavailable/,
            )
            assert.equal(calls.length, 0)
          },
        ),
    )
  })

  it('超时 → 明确的超时错误', async () => {
    const p = image('g6.png', PNG)
    await withEnv({ ...ENV, OPENCLAUDE_VISION_TIMEOUT_MS: '10000' }, () =>
      withFetch(
        (c) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = (c.init as { signal?: AbortSignal }).signal
            signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
        async () => {
          const input = { ...vision.resolveVisionInput({ image_file: p }), timeoutMs: 50 }
          await assert.rejects(() => vision.runGrokVisionForTest(input), /grok vision timed out after 50ms/)
        },
      ),
    )
  })

  it('OPENCLAUDE_VISION_BACKEND=minimax 仍走静态模型后端(不打 grok-vision)', async () => {
    await withEnv({ ...ENV, OPENCLAUDE_VISION_BACKEND: 'minimax' }, () => {
      assert.equal(vision.visionBackend(), 'minimax')
      assert.equal(vision.visionBackendLabel(), vision.STATIC_VISION_MODEL)
    })
  })
})
