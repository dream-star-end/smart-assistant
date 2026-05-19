/**
 * fetchPlatformSlotsFromMaster — gateway 容器 → master 平台 slot 拉取契约。
 *
 * 设计契约(改前先改测试):
 *   - env 不齐(URL 或 TOKEN 缺)→ null(信号:走 provider hook 路径)
 *   - env 齐 + 网络错 / abort → []  (fail-soft,**不**回退 hook)
 *   - env 齐 + 非 200 → []
 *   - env 齐 + JSON parse 失败 → []
 *   - env 齐 + 顶层 shape 不是 `{slots: [...]}` → []
 *   - 名字不在白名单(SKILLS_LITERATURE / MODEL_HINT)→ 该项被过滤
 *   - content 缺失 / 空白 → 该项被过滤
 *   - MODEL_HINT 缺 canonicalModelId → 该项被过滤(metric 防线)
 *   - 正常 200 + 合法 shape → trim 后的 RemotePlatformSlot[]
 *   - ?model query 正确 URL-encoded
 *   - Authorization: Bearer <token> 透传
 *   - 超时 abort 路径触发 fail-soft
 *
 * 不碰真实网络:fetcher 通过 deps 注入,env 通过 deps 注入。
 *
 * 跑法:npx tsx --test src/__tests__/fetchPlatformSlotsFromMaster.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Readable } from 'node:stream'
import {
  PLATFORM_PROMPT_SLOTS_PATH,
  fetchPlatformSlotsFromMaster,
} from '../promptSlots.js'

const MASTER = 'https://master.example.test'
const TOKEN = 'oc-v3.42.deadbeef'

interface FakeRes {
  statusCode: number
  body: AsyncIterable<Buffer>
}

function streamBody(text: string): AsyncIterable<Buffer> {
  return Readable.from([Buffer.from(text, 'utf-8')])
}

/** 测试 fetcher:固定回 200 + 提供的 JSON 文本。 */
function makeFetcher(opts: {
  status?: number
  body?: string
  capture?: { url?: string; headers?: Record<string, string> }
  throwErr?: unknown
}) {
  return async function fetcher(url: string | URL, init: any): Promise<FakeRes> {
    if (opts.capture) {
      opts.capture.url = String(url)
      opts.capture.headers = init?.headers ?? {}
    }
    if (opts.throwErr !== undefined) {
      throw opts.throwErr
    }
    return {
      statusCode: opts.status ?? 200,
      body: streamBody(opts.body ?? ''),
    }
  } as any
}

describe('fetchPlatformSlotsFromMaster — env gating', () => {
  it('env 全缺 → null', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      { env: {}, fetcher: makeFetcher({}) },
    )
    assert.equal(r, null)
  })

  it('只有 base url 缺 token → null', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: { OPENCLAUDE_V3_MASTER_BASE_URL: MASTER },
        fetcher: makeFetcher({}),
      },
    )
    assert.equal(r, null)
  })

  it('只有 token 缺 base url → null', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: { OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN },
        fetcher: makeFetcher({}),
      },
    )
    assert.equal(r, null)
  })
})

describe('fetchPlatformSlotsFromMaster — request shape', () => {
  it('URL 拼接 + Bearer 透传 + ?model encoded', async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {}
    const fetcher = makeFetcher({
      status: 200,
      body: '{"slots":[]}',
      capture: cap,
    })
    await fetchPlatformSlotsFromMaster(
      { agentId: 'a', model: 'claude-opus-4-7 special&chars' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.ok(cap.url, 'fetcher must be called')
    assert.ok(cap.url!.startsWith(`${MASTER}${PLATFORM_PROMPT_SLOTS_PATH}?model=`))
    // model param must be URI-encoded (space → %20, & → %26)
    assert.match(cap.url!, /model=claude-opus-4-7%20special%26chars/)
    assert.equal(cap.headers!.authorization, `Bearer ${TOKEN}`)
  })

  it('base url 带尾斜杠 → 自动归一化(不出现 //)', async () => {
    const cap: { url?: string } = {}
    await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: `${MASTER}/`,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: '{"slots":[]}', capture: cap }),
      },
    )
    assert.equal(cap.url, `${MASTER}${PLATFORM_PROMPT_SLOTS_PATH}`)
  })

  it('无 ctx.model → 不带 ?model 参数', async () => {
    const cap: { url?: string } = {}
    await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: '{"slots":[]}', capture: cap }),
      },
    )
    assert.equal(cap.url, `${MASTER}${PLATFORM_PROMPT_SLOTS_PATH}`)
  })
})

describe('fetchPlatformSlotsFromMaster — fail-soft paths', () => {
  it('fetcher 抛错 → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ throwErr: new Error('ECONNREFUSED') }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('非 200 (401) → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 401, body: '{"error":"x"}' }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('非 200 (500) → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 500, body: 'oops' }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('200 但 body 不是 JSON → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: 'not json {' }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('200 + JSON 但顶层非 {slots: []} shape → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: '{"foo":1}' }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('200 + null body → []', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: 'null' }),
      },
    )
    assert.deepEqual(r, [])
  })

  it('timeout abort → []', async () => {
    // fetcher 不返回直到 abort
    const fetcher = (async (_url: string, init: any) => {
      // 等到 signal abort 后抛 AbortError(undici 行为)
      return await new Promise<FakeRes>((_, reject) => {
        const s: AbortSignal = init.signal
        if (s.aborted) reject(new Error('AbortError'))
        s.addEventListener('abort', () => reject(new Error('AbortError')))
      })
    }) as any
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
        timeoutMs: 50,
      },
    )
    assert.deepEqual(r, [])
  })
})

describe('fetchPlatformSlotsFromMaster — slot whitelist + trim', () => {
  it('正常 SKILLS_LITERATURE + MODEL_HINT → 两条都通过', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [
          { name: 'SKILLS_LITERATURE', content: '  literature body  ' },
          {
            name: 'MODEL_HINT',
            content: '  hint body  ',
            canonicalModelId: 'deepseek-v4-pro',
          },
        ],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a', model: 'deepseek-v4-pro' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.ok(Array.isArray(r))
    assert.equal(r!.length, 2)
    const lit = r!.find((s) => s.name === 'SKILLS_LITERATURE')
    assert.ok(lit)
    assert.equal(lit!.content, 'literature body')
    assert.equal(lit!.canonicalModelId, undefined)
    const hint = r!.find((s) => s.name === 'MODEL_HINT')
    assert.ok(hint)
    assert.equal(hint!.content, 'hint body')
    assert.equal(hint!.canonicalModelId, 'deepseek-v4-pro')
  })

  it('未知 slot name → 被白名单过滤', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [
          { name: 'EVIL_NEW_SLOT', content: 'should be dropped' },
          { name: 'SKILLS_LITERATURE', content: 'good' },
        ],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.equal(r!.length, 1)
    assert.equal(r![0].name, 'SKILLS_LITERATURE')
  })

  it('content 缺失 / 非 string → 被过滤', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [
          { name: 'SKILLS_LITERATURE' },
          { name: 'SKILLS_LITERATURE', content: 42 },
          { name: 'SKILLS_LITERATURE', content: 'ok' },
        ],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.equal(r!.length, 1)
    assert.equal(r![0].content, 'ok')
  })

  it('content 仅空白 → 被过滤(trim 后空)', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [{ name: 'SKILLS_LITERATURE', content: '   \n\t   ' }],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.deepEqual(r, [])
  })

  it('MODEL_HINT 缺 canonicalModelId → 被过滤(metric 防线)', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [
          { name: 'MODEL_HINT', content: 'hint' }, // 缺 canonicalModelId
          { name: 'MODEL_HINT', content: 'hint2', canonicalModelId: '' }, // 空串
          { name: 'MODEL_HINT', content: 'good', canonicalModelId: 'm1' },
        ],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a', model: 'm1' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.equal(r!.length, 1)
    assert.equal(r![0].name, 'MODEL_HINT')
    assert.equal(r![0].canonicalModelId, 'm1')
  })

  it('slot 非对象 / null → 被过滤', async () => {
    const fetcher = makeFetcher({
      status: 200,
      body: JSON.stringify({
        slots: [
          null,
          'string slot',
          42,
          { name: 'SKILLS_LITERATURE', content: 'good' },
        ],
      }),
    })
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher,
      },
    )
    assert.equal(r!.length, 1)
    assert.equal(r![0].name, 'SKILLS_LITERATURE')
  })

  it('空 slots[] → 返回空数组(不是 null)', async () => {
    const r = await fetchPlatformSlotsFromMaster(
      { agentId: 'a' },
      {
        env: {
          OPENCLAUDE_V3_MASTER_BASE_URL: MASTER,
          OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
        },
        fetcher: makeFetcher({ status: 200, body: '{"slots":[]}' }),
      },
    )
    assert.deepEqual(r, [])
  })
})
