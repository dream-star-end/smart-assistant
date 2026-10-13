/**
 * OCV5-402 · 连接器 builtin 层(切片②)与官方市场连接器 `bili` 的单测(无需 PG、不出网)。
 *
 *   1. WBI 签名:与 B 站公开文档的固定向量逐字一致;过滤 `!'()*`;空格编码为 %20。
 *   2. 编译器:白名单 / 类别 / origin 范围 / operation 仍 fail-closed / staticQuery / authMode none 约束。
 *   3. 平台专用:官方工件精确 hash 才有特权;社区发布管线拒 builtin 与 none。
 *   4. 驱动:本地受控上游 —— 签名参数、匿名指纹 Cookie、静态 query;风控(-352 / 412)作废缓存只重试一次;
 *      缓存按 origin 单飞复用。
 *   5. 弹幕 XML:raw deflate / gzip / 明文;实体解码;均匀抽样;解压上限。
 *   6. 凭据袋:none 模式什么都不填、什么都不注入。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { fetch as undiciFetch } from 'undici'

import { BUILTIN_REGISTRY } from '../connectors/builtins/registry.js'
import {
  DM_MAX_ITEMS,
  __resetBilibiliWbiCacheForTests,
  implementedBuiltinIds,
  parseDanmakuXml,
  resultBuiltin,
  wbiMixinKey,
  wbiSignQuery,
} from '../connectors/builtins/runtime.js'
import { githubDefault } from '../connectors/defaults/github.js'
import {
  bagToResolvedCredentials,
  requiredBindSources,
  storedBagSources,
} from '../connectors/engine/credentialBag.js'
import { type EngineHttpDeps, engineHttpRequest } from '../connectors/engine/driver.js'
import { ConnectorError } from '../connectors/errors.js'
import { biliConnectorDecision, biliConnectorSpec } from '../connectors/official/bili.js'
import {
  contractNeedsOfficialArtifact,
  isOfficialConnectorArtifact,
} from '../connectors/official/index.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import {
  ConnectorSpecError,
  type ConnectorSpecT,
  type ExecContractT,
} from '../connectors/spec/types.js'
import { prepareConnectorPublish } from '../marketplace/publishConnectorPipeline.js'
import { seedOfficialMarketConnector } from '../marketplace/seedOfficialConnectors.js'

// ─── helpers ────────────────────────────────────────────────────────────────

const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'

function bili(): ConnectorSpecT {
  return structuredClone(biliConnectorSpec)
}

function compileBili(spec: ConnectorSpecT = bili()) {
  return compileSpec(spec, structuredClone(biliConnectorDecision))
}

function expectSpecError(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof ConnectorSpecError && e.code === code)
}

function okResolver(): DnsResolver {
  return {
    resolve4: async () => ['93.184.216.34'],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
}

interface Captured {
  path: string
  query: URLSearchParams
  rawQuery: string
  headers: Record<string, string | string[] | undefined>
}

type Handler = (req: Captured) => { status: number; body: string | Buffer; type?: string }

interface Upstream {
  port: number
  requests: Captured[]
  handler: Handler
  close(): Promise<void>
}

function startUpstream(): Promise<Upstream> {
  return new Promise((resolve) => {
    const state: Upstream = {
      port: 0,
      requests: [],
      handler: () => ({ status: 200, body: '{}' }),
      close: async () => {},
    }
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const cap: Captured = {
        path: u.pathname,
        query: u.searchParams,
        rawQuery: u.search.slice(1),
        headers: req.headers,
      }
      state.requests.push(cap)
      const out = state.handler(cap)
      res.statusCode = out.status
      res.setHeader('content-type', out.type ?? 'application/json')
      res.end(out.body)
    })
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port
      state.close = () => new Promise<void>((r) => server.close(() => r()))
      resolve(state)
    })
  })
}

function deps(port: number): EngineHttpDeps {
  return {
    resolver: okResolver(),
    fetchImpl: async (input, init) => {
      const u = new URL(input)
      u.protocol = 'http:'
      u.hostname = '127.0.0.1'
      u.port = String(port)
      return undiciFetch(u.toString(), {
        method: init.method as string,
        headers: init.headers as Record<string, string> | undefined,
        redirect: 'error',
        signal: init.signal as AbortSignal | undefined,
      }) as unknown as Promise<Response>
    },
  }
}

const NAV_BODY = JSON.stringify({
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
    },
  },
})
const SPI_BODY = JSON.stringify({
  code: 0,
  data: { b_3: 'AAAA1111-2222-3333-4444-555566667777infoc', b_4: 'BBBB-CCCC-DDDD%3D%3D' },
})

function action(contract: ExecContractT, id: string) {
  const a = contract.actions.find((x) => x.id === id)
  assert.ok(a, `action ${id}`)
  return a
}

// ─── 1. WBI 签名 ─────────────────────────────────────────────────────────────

describe('bilibili-wbi signing', () => {
  test('mixin key 与签名和 B 站公开文档的固定向量逐字一致', () => {
    const mixin = wbiMixinKey(IMG_KEY, SUB_KEY)
    assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8')
    const qs = wbiSignQuery(
      [
        ['foo', '114'],
        ['bar', '514'],
        ['zab', '1919810'],
      ],
      mixin,
      1702204169,
    )
    assert.equal(
      qs,
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    )
  })

  test("值里的 !'()* 被去掉,空格按前端规则编码为 %20,调用方传入的 wts/w_rid 被忽略", () => {
    const mixin = wbiMixinKey(IMG_KEY, SUB_KEY)
    const qs = wbiSignQuery(
      [
        ['keyword', "原神 2.0!(test)*'"],
        ['wts', '1'],
        ['w_rid', 'forged'],
      ],
      mixin,
      1702204169,
    )
    const body = `keyword=${encodeURIComponent('原神 2.0test')}&wts=1702204169`
    assert.ok(qs.startsWith(`${body}&w_rid=`))
    assert.ok(qs.includes('%20'))
    const rid = createHash('md5')
      .update(body + mixin)
      .digest('hex')
    assert.equal(qs, `${body}&w_rid=${rid}`)
  })
})

// ─── 2. 编译器 ───────────────────────────────────────────────────────────────

describe('compiler: builtin layer, staticQuery, authMode none', () => {
  test('bili 官方 spec 编译通过,builtin 与 staticQuery 签进 ExecAction', () => {
    const { execContract } = compileBili()
    assert.equal(execContract.authMode, 'none')
    assert.deepEqual(execContract.credentialAudiencePolicy.apiOrigins, [
      'https://api.bilibili.com:443',
    ])
    assert.ok(execContract.actions.every((a) => a.effect === 'read'))
    assert.ok(execContract.actions.every((a) => a.apiCredentialPlacements.length === 0))
    assert.equal(action(execContract, 'search').requestTransform, 'bilibili-wbi')
    assert.equal(action(execContract, 'danmaku').resultTransform, 'bilibili-dm-xml')
    assert.deepEqual(action(execContract, 'rank').request.staticQuery, {
      day: '3',
      type: '1',
      arc_type: '0',
    })
    assert.equal(Object.hasOwn(action(execContract, 'rank'), 'requestTransform'), false)
  })

  test('不用新能力的 spec:ExecAction 不出现 builtin 键(旧契约形状不变)', () => {
    const { execContract } = compileSpec(
      structuredClone(githubDefault.spec),
      structuredClone(githubDefault.decision),
    )
    for (const a of execContract.actions) {
      assert.equal(Object.hasOwn(a, 'requestTransform'), false)
      assert.equal(Object.hasOwn(a, 'resultTransform'), false)
    }
  })

  test('白名单外 / 类别不符 / operation → BUILTIN_NOT_ALLOWED', () => {
    const unknown = bili()
    unknown.actions[0]!.requestTransform = 'evil-signer'
    expectSpecError(() => compileBili(unknown), 'BUILTIN_NOT_ALLOWED')

    const wrongKind = bili()
    wrongKind.actions[0]!.requestTransform = 'bilibili-dm-xml'
    expectSpecError(() => compileBili(wrongKind), 'BUILTIN_NOT_ALLOWED')

    const op = bili()
    op.actions[0]!.operation = 'bilibili-wbi'
    expectSpecError(() => compileBili(op), 'BUILTIN_NOT_ALLOWED')
  })

  test('builtin 只能用于它写死的 origin:换 apiOrigins 即拒', () => {
    const decision = structuredClone(biliConnectorDecision)
    decision.audience!.apiOrigins = ['https://api.example.com']
    expectSpecError(() => compileSpec(bili(), decision), 'BUILTIN_NOT_ALLOWED')
    const both = structuredClone(biliConnectorDecision)
    both.audience!.apiOrigins = ['https://api.bilibili.com', 'https://api.example.com']
    expectSpecError(() => compileSpec(bili(), both), 'BUILTIN_NOT_ALLOWED')
  })

  test('staticQuery 不能与 params 映射的 query 重名,值禁控制符', () => {
    const dup = bili()
    dup.actions[0]!.request.staticQuery = { keyword: 'x' }
    expectSpecError(() => compileBili(dup), 'BAD_PATH_TEMPLATE')
    const ctl = bili()
    ctl.actions[0]!.request.staticQuery = { search_type: 'video\r\nX-Evil: 1' }
    expectSpecError(() => compileBili(ctl), 'BAD_PATH_TEMPLATE')
  })

  test('authMode none 不能有凭据流水线,也不能声明 identity probe', () => {
    const withNode = bili()
    withNode.credentialPipeline = {
      nodes: [{ id: 'api-token', authMode: 'none', subject: 'user', audience: 'api' }],
    }
    expectSpecError(() => compileBili(withNode), 'PIPELINE_INVALID')
    const withIdentity = bili()
    withIdentity.identity = { probeActionId: 'popular', accountKeyPointer: '/code' }
    expectSpecError(() => compileBili(withIdentity), 'IDENTITY_INVALID')
  })
})

// ─── 3. 平台专用 ─────────────────────────────────────────────────────────────

describe('official-only privileges', () => {
  test('官方工件精确 hash 才算官方;改一个字就失去特权', () => {
    const compiled = compileBili()
    assert.equal(contractNeedsOfficialArtifact(compiled.execContract), true)
    assert.equal(isOfficialConnectorArtifact('bili', compiled.specHash), true)
    const tampered = bili()
    tampered.description = `${tampered.description} `
    assert.equal(isOfficialConnectorArtifact('bili', canonicalSha256Hex(tampered)), false)
    assert.equal(isOfficialConnectorArtifact('bili-fork', compiled.specHash), false)
    const plain = compileSpec(
      structuredClone(githubDefault.spec),
      structuredClone(githubDefault.decision),
    )
    assert.equal(contractNeedsOfficialArtifact(plain.execContract), false)
  })

  test('白名单与实现一一对应', () => {
    assert.deepEqual([...BUILTIN_REGISTRY.keys()].sort(), implementedBuiltinIds().sort())
  })

  test('社区发布:带 builtin 的 spec → BUILTIN_PLATFORM_ONLY;none spec 被拒', () => {
    const spec = structuredClone(githubDefault.spec)
    spec.id = 'bili-community'
    for (const a of spec.actions) a.requestTransform = 'bilibili-wbi'
    const decision = structuredClone(githubDefault.decision)
    decision.audience!.apiOrigins = ['https://api.bilibili.com']
    const withBuiltin = prepareConnectorPublish({
      version: '1.0.0',
      spec,
      securityDecision: decision,
      category: 'daily-tools',
      useCases: ['查询公开视频数据'],
    })
    assert.equal(withBuiltin.ok, false)
    if (!withBuiltin.ok) assert.equal(withBuiltin.code, 'BUILTIN_PLATFORM_ONLY')

    const none = prepareConnectorPublish({
      version: '1.0.0',
      spec: { ...bili(), id: 'bili-copy' },
      securityDecision: structuredClone(biliConnectorDecision),
      category: 'daily-tools',
      useCases: ['查询公开视频数据'],
    })
    assert.equal(none.ok, false)
  })
})

// ─── 4. 驱动 ────────────────────────────────────────────────────────────────

describe('engine driver with bilibili builtins (local upstream)', () => {
  let up: Upstream
  const { execContract } = compileBili()

  before(async () => {
    up = await startUpstream()
  })
  after(async () => {
    await up.close()
  })
  beforeEach(() => {
    __resetBilibiliWbiCacheForTests()
    up.requests.length = 0
  })

  function run(id: string, params: Record<string, unknown>) {
    return engineHttpRequest({
      contract: execContract,
      action: action(execContract, id),
      credentialAudience: 'api',
      targetOrigin: 'https://api.bilibili.com:443',
      resolvedCreds: {},
      params,
      deps: deps(up.port),
    })
  }

  test('search:签名参数、匿名指纹 Cookie、静态 query、结果投影', async () => {
    up.handler = (req) => {
      if (req.path === '/x/web-interface/nav') return { status: 200, body: NAV_BODY }
      if (req.path === '/x/frontend/finger/spi') return { status: 200, body: SPI_BODY }
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          message: '0',
          data: {
            numResults: 1,
            result: [
              { bvid: 'BV1xx411c7mD', title: '<em class="keyword">AI</em>', play: 9, secret: 'x' },
            ],
          },
        }),
      }
    }
    const out = (await run('search', { keyword: 'AI 日报', order: 'click' })) as {
      code: number
      data: { result: Array<Record<string, unknown>> }
    }
    assert.equal(out.code, 0)
    assert.deepEqual(out.data.result[0], {
      bvid: 'BV1xx411c7mD',
      title: '<em class="keyword">AI</em>',
      play: 9,
    })
    const main = up.requests.find((r) => r.path === '/x/web-interface/wbi/search/type')
    assert.ok(main)
    assert.equal(main.query.get('search_type'), 'video')
    assert.equal(main.query.get('keyword'), 'AI 日报')
    assert.equal(main.query.get('order'), 'click')
    const wts = Number(main.query.get('wts'))
    assert.ok(Number.isInteger(wts) && wts > 1_700_000_000)
    const unsigned = main.rawQuery.slice(0, main.rawQuery.lastIndexOf('&w_rid='))
    const expected = createHash('md5')
      .update(unsigned + wbiMixinKey(IMG_KEY, SUB_KEY))
      .digest('hex')
    assert.equal(main.query.get('w_rid'), expected)
    assert.match(
      String(main.headers.cookie),
      /^buvid3=AAAA1111-[^;]+; buvid4=BBBB-CCCC-DDDD%3D%3D$/,
    )
    assert.equal(main.headers.referer, 'https://www.bilibili.com/')
    // nav / spi 也带同样的 UA / Referer,且不带 Cookie。
    const nav = up.requests.find((r) => r.path === '/x/web-interface/nav')
    assert.equal(nav?.headers.referer, 'https://www.bilibili.com/')
    assert.equal(nav?.headers.cookie, undefined)
  })

  test('签名材料按 origin 缓存:连续两次调用只取一次 nav / spi', async () => {
    up.handler = (req) => {
      if (req.path === '/x/web-interface/nav') return { status: 200, body: NAV_BODY }
      if (req.path === '/x/frontend/finger/spi') return { status: 200, body: SPI_BODY }
      return { status: 200, body: JSON.stringify({ code: 0, data: { bvid: 'BV1xx411c7mD' } }) }
    }
    await Promise.all([
      run('video', { bvid: 'BV1xx411c7mD' }),
      run('video', { bvid: 'BV1xx411c7mD' }),
    ])
    await run('video', { aid: 170001 })
    assert.equal(up.requests.filter((r) => r.path === '/x/web-interface/nav').length, 1)
    assert.equal(up.requests.filter((r) => r.path === '/x/frontend/finger/spi').length, 1)
  })

  test('业务码 -352(风控):作废缓存重取后重试一次,成功即返回', async () => {
    let mainHits = 0
    up.handler = (req) => {
      if (req.path === '/x/web-interface/nav') return { status: 200, body: NAV_BODY }
      if (req.path === '/x/frontend/finger/spi') return { status: 200, body: SPI_BODY }
      mainHits += 1
      return mainHits === 1
        ? { status: 200, body: JSON.stringify({ code: -352, message: '风控校验失败' }) }
        : { status: 200, body: JSON.stringify({ code: 0, data: { replies: [] } }) }
    }
    const out = (await run('comments', { oid: 170001, mode: 2 })) as { code: number }
    assert.equal(out.code, 0)
    assert.equal(mainHits, 2)
    assert.equal(up.requests.filter((r) => r.path === '/x/web-interface/nav').length, 2)
    const main = up.requests.filter((r) => r.path === '/x/v2/reply/wbi/main')
    assert.equal(main[0]?.query.get('type'), '1')
    assert.equal(main[0]?.query.get('mode'), '2')
  })

  test('连续风控(-352 两次 / HTTP 412 两次):只重试一次,报 UPSTREAM_RATE_LIMITED', async () => {
    for (const blocked of [
      () => ({ status: 200, body: JSON.stringify({ code: -352, message: '风控校验失败' }) }),
      () => ({ status: 412, body: '' }),
    ]) {
      __resetBilibiliWbiCacheForTests()
      let mainHits = 0
      up.handler = (req) => {
        if (req.path === '/x/web-interface/nav') return { status: 200, body: NAV_BODY }
        if (req.path === '/x/frontend/finger/spi') return { status: 200, body: SPI_BODY }
        mainHits += 1
        return blocked()
      }
      await assert.rejects(
        run('video', { bvid: 'BV1xx411c7mD' }),
        (e: unknown) => e instanceof ConnectorError && e.code === 'UPSTREAM_RATE_LIMITED',
      )
      assert.equal(mainHits, 2)
    }
  })

  test('nav 拿不到合法密钥 → 失败关闭,主请求不发出', async () => {
    up.handler = (req) => {
      if (req.path === '/x/web-interface/nav')
        return {
          status: 200,
          body: JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'x' } } }),
        }
      return { status: 200, body: SPI_BODY }
    }
    await assert.rejects(
      run('search', { keyword: 'x' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'UPSTREAM_ERROR',
    )
    assert.equal(up.requests.filter((r) => r.path === '/x/web-interface/wbi/search/type').length, 0)
  })

  test('官方 seed 实测(dry-run):全部动作真实返回才通过;弹幕返回 HTML 错误页则不通过(Codex r1 P1)', async () => {
    const archive = {
      aid: 170001,
      bvid: 'BV17x411w7KC',
      title: 't',
      owner: { name: 'u' },
      stat: { view: 1 },
    }
    const ok = (path: string, dm: { status: number; body: string | Buffer; type?: string }) => {
      switch (path) {
        case '/x/web-interface/nav':
          return { status: 200, body: NAV_BODY }
        case '/x/frontend/finger/spi':
          return { status: 200, body: SPI_BODY }
        case '/x/web-interface/popular':
        case '/x/web-interface/ranking':
          return { status: 200, body: JSON.stringify({ code: 0, data: { list: [archive] } }) }
        case '/x/web-interface/wbi/search/type':
          return { status: 200, body: JSON.stringify({ code: 0, data: { result: [archive] } }) }
        case '/x/web-interface/wbi/view':
          return {
            status: 200,
            body: JSON.stringify({ code: 0, data: { ...archive, cid: 279786 } }),
          }
        case '/x/v2/reply/wbi/main':
          return { status: 200, body: JSON.stringify({ code: 0, data: { replies: [] } }) }
        case '/x/v1/dm/list.so':
          return dm
        default:
          return { status: 404, body: '{}' }
      }
    }
    up.handler = (req) =>
      ok(req.path, {
        status: 200,
        type: 'text/xml',
        body: deflateRawSync(Buffer.from('<i><chatid>279786</chatid></i>')),
      })
    const good = await seedOfficialMarketConnector({
      slug: 'bili',
      dryRun: true,
      deps: deps(up.port),
    })
    assert.equal(good.outcome, 'dry-run')
    assert.ok(good.live.every((c) => c.ok))

    __resetBilibiliWbiCacheForTests()
    up.handler = (req) =>
      ok(req.path, { status: 200, type: 'text/html', body: '<!doctype html><title>error</title>' })
    await assert.rejects(
      seedOfficialMarketConnector({ slug: 'bili', dryRun: true, deps: deps(up.port) }),
      /danmaku/,
    )
  })

  test('rank / popular 不签名,只带静态 query', async () => {
    up.handler = () => ({ status: 200, body: JSON.stringify({ code: 0, data: { list: [] } }) })
    await run('rank', { rid: 36 })
    assert.equal(up.requests.length, 1)
    assert.equal(up.requests[0]?.path, '/x/web-interface/ranking')
    assert.equal(up.requests[0]?.query.get('day'), '3')
    assert.equal(up.requests[0]?.query.get('type'), '1')
    assert.equal(up.requests[0]?.query.get('rid'), '36')
    assert.equal(up.requests[0]?.query.has('w_rid'), false)
  })

  test('danmaku:deflate 压缩 XML 经 builtin 解析后再投影', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><i><chatid>12345</chatid>' +
      '<d p="12.5,1,25,16777215,1700000000,0,abc,1">前方高能 &amp; 名场面</d>' +
      '<d p="3.25,1,25,16777215,1700000001,0,abd,2">第一</d></i>'
    up.handler = () => ({ status: 200, body: deflateRawSync(Buffer.from(xml)), type: 'text/xml' })
    const out = (await run('danmaku', { cid: 12345 })) as {
      code: number
      cid: number
      total: number
      items: Array<{ t: number; text: string; sentAt: number }>
    }
    assert.equal(out.code, 0)
    assert.equal(out.cid, 12345)
    assert.equal(out.total, 2)
    assert.deepEqual(out.items[0], { t: 3.3, text: '第一', sentAt: 1700000001 })
    assert.equal(out.items[1]?.text, '前方高能 & 名场面')
    assert.equal(up.requests[0]?.query.get('oid'), '12345')
  })
})

// ─── 5. 弹幕 XML ────────────────────────────────────────────────────────────

describe('bilibili-dm-xml parsing', () => {
  function respond(body: Buffer): Response {
    return new Response(body, { status: 200 })
  }

  test('gzip / 明文都能读;非法实体与控制符被去掉', async () => {
    const xml = '<i><chatid>1</chatid><d p="1,1,25,1,1700000000">a&#0;b&#x1F600;c&bogus;</d></i>'
    for (const body of [gzipSync(Buffer.from(xml)), Buffer.from(xml)]) {
      const out = (await resultBuiltin('bilibili-dm-xml').read(respond(body), 't')) as {
        items: Array<{ text: string }>
      }
      assert.equal(out.items[0]?.text, 'ab😀c&bogus;')
    }
  })

  test('200 里不是弹幕文档(JSON 错误 / 风控 / HTML / 空 XML)一律报错,绝不当成 0 条弹幕(Codex r1 P1)', async () => {
    const cases: Array<[Buffer, string]> = [
      [deflateRawSync(Buffer.from('{"code":-400,"message":"请求错误"}')), 'UPSTREAM_ERROR'],
      [Buffer.from('{"code":-404,"message":"啥都木有"}'), 'UPSTREAM_ERROR'],
      [
        deflateRawSync(Buffer.from('{"code":-412,"message":"请求被拦截"}')),
        'UPSTREAM_RATE_LIMITED',
      ],
      [deflateRawSync(Buffer.from('{"code":-404,"message":"啥都木有"}')), 'UPSTREAM_NOT_FOUND'],
      [Buffer.from('<!doctype html><html><body>error</body></html>'), 'UPSTREAM_ERROR'],
      [deflateRawSync(Buffer.from('<?xml version="1.0"?><i></i>')), 'UPSTREAM_ERROR'],
      // Codex r2 P1:截断(根没闭合 / 条目残缺)也不算成功。
      [
        deflateRawSync(
          Buffer.from('<i><chatid>279786</chatid><d p="12.5,1,25,16777215,1700000000">'),
        ),
        'UPSTREAM_ERROR',
      ],
      [
        deflateRawSync(
          Buffer.from('<i><chatid>279786</chatid><d p="1,1,25,1,1">a</d><d p="2,1">b</i>'),
        ),
        'UPSTREAM_ERROR',
      ],
    ]
    for (const [body, code] of cases) {
      await assert.rejects(
        resultBuiltin('bilibili-dm-xml').read(respond(body), 't'),
        (e: unknown) => e instanceof ConnectorError && e.code === code,
        code,
      )
    }
    // 真弹幕文档、只是 0 条:合法,返回 total 0。
    const empty = (await resultBuiltin('bilibili-dm-xml').read(
      respond(deflateRawSync(Buffer.from('<i><chatid>7</chatid></i>'))),
      't',
    )) as { code: number; cid: number; total: number }
    assert.deepEqual([empty.code, empty.cid, empty.total], [0, 7, 0])
  })

  test('超过 200 条按时间均匀抽样,density 覆盖全程', () => {
    const rows = Array.from(
      { length: 1000 },
      (_, i) => `<d p="${i},1,25,1,${1700000000 + i}">m${i}</d>`,
    ).join('')
    const out = parseDanmakuXml(`<i><chatid>9</chatid>${rows}</i>`)
    assert.equal(out.total, 1000)
    assert.equal(out.sampled, true)
    assert.equal(out.items.length, DM_MAX_ITEMS)
    assert.equal(out.items[0]?.t, 0)
    assert.ok((out.items.at(-1)?.t ?? 0) > 990)
    assert.equal(out.density.length, 60)
    assert.equal(
      out.density.reduce((s, n) => s + n, 0),
      1000,
    )
  })

  test('解压炸弹:超过上限 → RESULT_TOO_LARGE', async () => {
    const bomb = deflateRawSync(Buffer.alloc(9 * 1024 * 1024, 0x61))
    await assert.rejects(
      resultBuiltin('bilibili-dm-xml').read(respond(bomb), 't'),
      (e: unknown) => e instanceof ConnectorError && e.code === 'RESULT_TOO_LARGE',
    )
  })
})

// ─── 6. 凭据袋 ──────────────────────────────────────────────────────────────

describe('authMode none credential bag', () => {
  test('什么都不填、什么都不存、什么都不注入', () => {
    const { execContract } = compileBili()
    assert.deepEqual(requiredBindSources(execContract), [])
    assert.deepEqual(storedBagSources(execContract), { required: [], optional: [] })
    assert.deepEqual(bagToResolvedCredentials('none', {}), {})
  })
})
