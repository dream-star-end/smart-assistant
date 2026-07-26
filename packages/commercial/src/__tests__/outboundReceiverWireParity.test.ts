/**
 * 容器出站 adapter × 宿主 receiver schema **对称契约**(#199 根治)。
 *
 * ── 它红了,用户会看到什么 ────────────────────────────────────────────────────
 * 容器侧只有**一个**出站 adapter(`makeV3WechatOutboundAdapter`,qqbot 复用同一实现),
 * 它对所有渠道拍出同一套 wire 字段;宿主侧每个渠道各写一份 `.strict()` zod schema。
 * 生产者多吐一个字段而某个 receiver 的 schema 没收 → 400 INVALID_BODY → 容器把这条
 * 回复丢回 durable retry queue 无限重试。**用户侧就是"AI 不回消息"**,而且是永久性的:
 * 队列里那条消息每次重试都吃同一个 400。
 * 2026-07-23 #199 就是这个形态:共享 adapter 恒带 `createdAt`,QQ schema 没收。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────────────
 *   ① 对每个渠道:用**真实 adapter**产出一条"字段最全"的 wire payload(所有可选字段
 *      都在),喂给该渠道**真实的 receiver handler**,响应不得是 400 INVALID_BODY。
 *   ② 负向对照(自检):同一条 payload 加一个 receiver 一定不认识的字段,必须真的拿到
 *      400 INVALID_BODY —— 证明 ① 的绿不是因为 harness 根本没走到 schema 那一步。
 *   ③ 渠道自动纳入:扫 commercial 源码里所有 `*_OUTBOUND_PATH` 导出,新增渠道 receiver
 *      不接进本文件的对照表即红。
 *
 * 不锁字段名、不锁字段顺序、不锁 schema 写法 —— 只锁"生产者吐得出的,消费者收得下"。
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import type { OutboundMessage } from '@openclaude/protocol'
import {
  makeV3QqbotOutboundAdapter,
  makeV3WechatOutboundAdapter,
  readV3WechatOutboundConfig,
} from '@openclaude/gateway'

import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { makeQqOutboundReceiver, QQ_OUTBOUND_PATH } from '../qqbot/receiver.js'
import {
  makeOutboundReceiverHandler,
  WECHAT_OUTBOUND_PATH,
} from '../wechat/outboundReceiver.js'
import type { RateLimiter } from '../wechat/rateLimiter.js'

// ── 容器身份夹具(两个 receiver 共用同一套 verifyContainerIdentity)────────────

const SECRET = 'a'.repeat(64)
const BEARER = `oc-v3.7.${SECRET}`
const HOST_UUID = 'host-1'
const BOUND_IP = '172.31.0.7'
const CTX = { hostUuid: HOST_UUID, boundIp: BOUND_IP }

const SESSION_ID = 'wsess-0123456789abcdef'
const SENDER_ID = 'sender-abc'
const TRACE_ID = '0123456789abcdef0123456789abcdef'

function makeIdentityRepo(): ContainerIdentityRepo {
  const secretHash = createHash('sha256').update(Buffer.from(SECRET, 'hex')).digest()
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      if (h !== HOST_UUID || ip !== BOUND_IP) return null
      return { id: 7, user_id: 42, bound_ip: BOUND_IP, host_uuid: HOST_UUID, secret_hash: secretHash }
    },
  }
}

/**
 * 宽容 pool 桩:本门只关心"schema 收不收",不关心入库结果。
 * schema 校验在任何 DB 访问之前,所以入库这一段随便答什么都不影响判定;真正防假绿的是
 * 负向对照 ②(它证明 400 这条路径确实可达)。
 */
function makePermissivePool(): Pool {
  const query = async (sql: string) => {
    if (/FROM qq_bot_bindings/i.test(sql)) {
      return {
        rows: [
          {
            user_id: '42',
            bot_openid: SENDER_ID,
            binding_version: 'b'.repeat(32),
            bound_at: '1',
            last_interaction_at: '1',
          },
        ],
        rowCount: 1,
      }
    }
    if (/INSERT INTO/i.test(sql)) return { rows: [{ id: '9' }], rowCount: 1 }
    // 出站入队路径读回行状态;答一条通用的 queued 行让两个 receiver 都能走完。
    if (/SELECT/i.test(sql)) {
      return { rows: [{ id: '9', status: 'queued', attempts: 0 }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  const client = { query, release() {} }
  return { query, async connect() { return client } } as unknown as Pool
}

const permissiveRateLimiter: RateLimiter = { checkInbound: () => true, checkOutbound: () => true }

// ── HTTP 收发桩 ───────────────────────────────────────────────────────────────

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage
  req.method = 'POST'
  req.headers = { authorization: `Bearer ${BEARER}` }
  return req
}

interface Recorded {
  status: number | undefined
  body: string
}

function makeRes(): { res: ServerResponse; rec: Recorded } {
  const rec: Recorded = { status: undefined, body: '' }
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(this: { headersSent: boolean }, status: number) {
      rec.status = status
      this.headersSent = true
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += chunk
    },
  } as unknown as ServerResponse
  return { res, rec }
}

function errCodeOf(rec: Recorded): string | null {
  if (!rec.body) return null
  try {
    const parsed = JSON.parse(rec.body) as { error?: { code?: string }; code?: string }
    return parsed.error?.code ?? parsed.code ?? null
  } catch {
    return null
  }
}

// ── 生产者:用真实 adapter 拍出"字段最全"的 wire payload ─────────────────────

/**
 * 让 adapter 把 payload 交给我们而不是真的入盘/发网。retryQueue 是 adapter 声明的官方
 * 测试注入点(V3WechatOutboundDeps 里标了 "Override only for tests")。
 */
function captureWirePayload(
  make: typeof makeV3WechatOutboundAdapter | typeof makeV3QqbotOutboundAdapter,
): Promise<Record<string, unknown>> {
  const captured: Record<string, unknown>[] = []
  const queue = {
    enqueueDurable: async (entry: { payload: unknown }) => {
      captured.push(entry.payload as Record<string, unknown>)
    },
    kick: () => {},
    startPeriodic: () => {},
    stopPeriodic: () => {},
  }
  // config 走**生产用的同一个 loader**,喂给它 v3supervisor 真正注入进容器的那两个 env
  // (见 packages/commercial/src/agent-sandbox/v3supervisor.ts 的容器 env 数组)。
  // 这样"生产者会吐哪些字段"是从真实接线推导出来的,而不是测试自己编一套 config。
  const config = readV3WechatOutboundConfig({
    OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
    OPENCLAUDE_V3_CONTAINER_TOKEN: BEARER,
  } as NodeJS.ProcessEnv)
  assert.ok(config, 'readV3WechatOutboundConfig 对容器必备 env 返回 null —— 生产者夹具失效')
  const adapter = make({
    config,
    retryQueue: queue as unknown as Parameters<typeof makeV3WechatOutboundAdapter>[0]['retryQueue'],
  })
  const out: OutboundMessage = {
    type: 'outbound.message',
    sessionKey: `k:${SESSION_ID}`,
    // 'webchat' 被两个 adapter 都接受(见 send() 的 channel 判定),这样同一条消息可以
    // 分别喂给 wechat / qqbot adapter,产出各自渠道的 payload。
    channel: 'webchat',
    peer: { id: SESSION_ID, kind: 'dm', displayName: SENDER_ID },
    blocks: [{ kind: 'text', text: 'AI 的回复', partial: false }],
    isFinal: true,
    traceId: TRACE_ID,
  } as unknown as OutboundMessage

  return adapter
    .send!(out)
    .then(() => {
      assert.equal(captured.length, 1, 'adapter 未产出 wire payload —— 生产者侧夹具失效')
      return captured[0]!
    })
}

// ── 渠道对照表 ────────────────────────────────────────────────────────────────

interface ChannelUnderTest {
  /** 该渠道的 internal 路径常量,同时作为 ③ 自动纳入检查的键。 */
  readonly outboundPath: string
  readonly makeAdapter: typeof makeV3WechatOutboundAdapter
  readonly makeHandler: () => (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string },
  ) => Promise<void>
}

const CHANNELS: readonly ChannelUnderTest[] = [
  {
    outboundPath: WECHAT_OUTBOUND_PATH,
    makeAdapter: makeV3WechatOutboundAdapter,
    makeHandler: () =>
      makeOutboundReceiverHandler({
        identityRepo: makeIdentityRepo(),
        pool: makePermissivePool(),
        rateLimiter: permissiveRateLimiter,
      }),
  },
  {
    outboundPath: QQ_OUTBOUND_PATH,
    makeAdapter: makeV3QqbotOutboundAdapter as typeof makeV3WechatOutboundAdapter,
    makeHandler: () =>
      makeQqOutboundReceiver({ pool: makePermissivePool(), identityRepo: makeIdentityRepo() }),
  },
]

describe('出站 adapter × receiver schema 对称契约(#199)', () => {
  for (const channel of CHANNELS) {
    test(`① ${channel.outboundPath}:receiver 收得下 adapter 吐得出的全部字段`, async () => {
      const payload = await captureWirePayload(channel.makeAdapter)
      const { res, rec } = makeRes()
      await channel.makeHandler()(makeReq(payload), res, CTX)

      assert.notEqual(
        errCodeOf(rec),
        'INVALID_BODY',
        `${channel.outboundPath} 的 schema 拒绝了共享 adapter 产出的 payload` +
          `(字段集 = ${Object.keys(payload).sort().join(', ')})。\n` +
          '后果:该渠道用户收不到 AI 回复 —— 容器把消息丢回 durable retry queue,' +
          '每次重试都吃同一个 400,永远送不出去。\n' +
          '修法:让该渠道的 receiver schema 接受这些字段(或让 adapter 别对该渠道吐)。\n' +
          `实际响应:${rec.status} ${rec.body}`,
      )
      // 同时确认真的走过了 method / identity 两道前置门(否则 ① 的绿没有意义)。
      assert.ok(
        rec.status !== 401 && rec.status !== 405,
        `未通过前置门(status=${rec.status}),身份夹具失效 —— 本轮 ① 不构成证据`,
      )
    })

    test(`② ${channel.outboundPath}:负向对照 —— 未知字段确实会被 400 拒`, async () => {
      const payload = await captureWirePayload(channel.makeAdapter)
      const { res, rec } = makeRes()
      await channel
        .makeHandler()(makeReq({ ...payload, __definitely_unknown_field__: 1 }), res, CTX)

      assert.equal(
        errCodeOf(rec),
        'INVALID_BODY',
        `${channel.outboundPath} 对未知字段没有返回 400 INVALID_BODY —— 说明 ① 的断言` +
          `根本没走到 schema 校验那一步(假绿)。实际响应:${rec.status} ${rec.body}`,
      )
    })
  }

  /**
   * ①② 的覆盖面 = "容器**真的**会发出的字段集",而那取决于 v3supervisor 往容器里注了
   * 哪些 env。adapter 还有一条 env 驱动的可选字段通道 `agentId`(OPENCLAUDE_AGENT_ID):
   * 一旦打开,**每条** outbound 都会多带 `agentId`。WeChat schema 收了它,
   * **QQ schema 没收**(`.strict()`)—— 也就是说打开那个 env 的当天,QQ 用户就会一条
   * 回复都收不到(400 INVALID_BODY → durable retry queue 无限重试)。
   *
   * 这条 gap 今天不可达(v3supervisor 不注入该 env),所以不是线上故障;但它就是 #199
   * 的同型残留。这里把"不可达"本身钉成断言:谁要打开这条通道,先在这里被拦下,
   * 而不是等 QQ 用户发现没人回。
   */
  test('④ 容器不注入 OPENCLAUDE_AGENT_ID —— 打开它会让 QQ 侧重演 #199', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const supervisor = await readFile(
      join(here, '..', 'agent-sandbox', 'v3supervisor.ts'),
      'utf8',
    )
    // 锚点自检:读到的确实是那份容器 env 装配代码。
    assert.ok(
      supervisor.includes('OPENCLAUDE_V3_CONTAINER_TOKEN='),
      'v3supervisor.ts 里找不到容器必备 env 装配锚点 —— 本条断言失去意义,请更新锚点',
    )

    assert.ok(
      !/OPENCLAUDE_AGENT_ID=/.test(supervisor),
      'v3supervisor 开始往容器注入 OPENCLAUDE_AGENT_ID 了。共享出站 adapter 会因此给' +
        '**每条** outbound 都加上 agentId 字段,而 QQ receiver 的 QqOutboundSchema 是' +
        '.strict() 且没有声明 agentId —— QQ 用户会一条 AI 回复都收不到(400 INVALID_BODY,' +
        '消息卡在容器 durable retry queue 里无限重试)。\n' +
        '修法:先在 packages/commercial/src/qqbot/receiver.ts 的 QqOutboundSchema 补上' +
        "`agentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()`(与 WeChat 侧对称)," +
        '再放开这条 env。',
    )
  })

  test('③ 新增渠道 receiver 自动纳入(不接进对照表即红)', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const srcRoot = join(here, '..')

    const found = new Map<string, string>()
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        const source = await readFile(full, 'utf8')
        for (const m of source.matchAll(
          /export const ([A-Z0-9_]*OUTBOUND_PATH)\s*=\s*['"]([^'"]+)['"]/g,
        )) {
          found.set(m[2]!, `${m[1]} @ ${full}`)
        }
      }
    }
    await walk(srcRoot)

    assert.ok(
      found.size >= 2,
      `只扫到 ${found.size} 个 *_OUTBOUND_PATH 导出(低于历史下界 2),扫描器可能失效`,
    )

    const covered = new Set(CHANNELS.map((c) => c.outboundPath))
    const missing = [...found.entries()]
      .filter(([path]) => !covered.has(path))
      .map(([path, where]) => `${path} (${where})`)

    assert.deepEqual(
      missing,
      [],
      '以下渠道有 outbound receiver,但没接进本文件的 CHANNELS 对照表 —— 它的 schema 从未' +
        `与共享 adapter 的产出对照过(#199 会在这个渠道上重演):\n  ${missing.join('\n  ')}\n` +
        '修法:在 CHANNELS 里补一条(adapter + handler 工厂),让对称门覆盖到它。',
    )
  })
})
