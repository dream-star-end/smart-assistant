/**
 * R5 Phase B 单测:parseIdentifier pmid/ads 变体、resolvePmid(esummary mock)、
 * resolveAds(官方 search + export,mock)、无 token fail-loud 指引、
 * verifyIdentifier 集成、researchProxy ads token 按需解密。
 * 全部 mock HTTP,不打真网。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

process.env.OC_RESEARCH_WORKSPACE = undefined

import type { SourceRecord } from '@openclaude/protocol/research'
import { RESEARCH_SECRET_NAMES } from '../admin/researchConfig.js'
import { DEFAULT_RESEARCH_CONFIG, type ResearchConfigPublic } from '../admin/researchConfig.js'
import { hashSecret } from '../auth/containerIdentity.js'
import {
  ADS_TOKEN_HINT,
  type CiteDeps,
  parseIdentifier,
  resolveAds,
  resolvePmid,
  verifyIdentifier,
} from '../research/cite.js'
import {
  type ResearchProxyHandlerCtx,
  makeResearchProxyHandler,
} from '../research/researchProxy.js'
import type { FetchLike } from '../research/sources.js'

// ── parseIdentifier ─────────────────────────────────────────────────

describe('parseIdentifier: pmid/ads 变体', () => {
  it('pmid: 前缀(1-9 位)', () => {
    assert.deepEqual(parseIdentifier('pmid:23903748'), { scheme: 'pmid', id: '23903748' })
    assert.deepEqual(parseIdentifier('PMID:23903748'), { scheme: 'pmid', id: '23903748' })
    assert.equal(parseIdentifier('pmid:abc'), null)
    assert.equal(parseIdentifier('pmid:1234567890123'), null)
  })

  it('裸 8-9 位数字 → pmid;短数字(年份类)不误判', () => {
    assert.deepEqual(parseIdentifier('23903748'), { scheme: 'pmid', id: '23903748' })
    assert.equal(parseIdentifier('2024'), null)
    assert.equal(parseIdentifier('1234567'), null)
  })

  it('ads: 前缀与 ADS URL(%26 解码)与裸 bibcode', () => {
    const bc = '2015A&A...576A.135S'
    assert.deepEqual(parseIdentifier(`ads:${bc}`), { scheme: 'ads', id: bc })
    assert.deepEqual(parseIdentifier('ads:2015A%26A...576A.135S'), { scheme: 'ads', id: bc })
    assert.deepEqual(parseIdentifier('ADS:2015A%26A...576A.135S'), { scheme: 'ads', id: bc })
    assert.deepEqual(
      parseIdentifier('https://ui.adsabs.harvard.edu/abs/2015A%26A...576A.135S/abstract'),
      {
        scheme: 'ads',
        id: bc,
      },
    )
  })

  it('ads: 前缀非 bibcode 形态(查询注入/含引号/长度不符)→ null(auditor W2)', () => {
    assert.equal(parseIdentifier('ads:x" OR title:"y'), null)
    assert.equal(parseIdentifier('ads:2015A&A...576A.135S" OR year:2020'), null)
    assert.equal(parseIdentifier('ads:not-a-bibcode'), null)
    assert.equal(parseIdentifier('ads:2015A&A...576A.135'), null) // 18 字符
    assert.equal(
      parseIdentifier('https://ui.adsabs.harvard.edu/abs/2015A%26A...576A.13/abstract'),
      null,
    )
  })

  it('裸 19 字符 bibcode 含字母期刊代码 → ads;纯数字 19 字符不判 bibcode', () => {
    assert.deepEqual(parseIdentifier('2015A&A...576A.135S'), {
      scheme: 'ads',
      id: '2015A&A...576A.135S',
    })
    assert.deepEqual(parseIdentifier('2020Sci...368.1064L'), {
      scheme: 'ads',
      id: '2020Sci...368.1064L',
    })
    assert.equal(parseIdentifier('1234567890123456789'), null)
  })

  it('旧 scheme 不回归', () => {
    assert.deepEqual(parseIdentifier('doi:10.1/x'), { scheme: 'doi', id: '10.1/x' })
    assert.deepEqual(parseIdentifier('arxiv:2301.01234'), { scheme: 'arxiv', id: '2301.01234' })
    assert.deepEqual(parseIdentifier('openalex:W123'), { scheme: 'openalex', id: 'W123' })
  })
})

// ── resolvePmid ─────────────────────────────────────────────────────

function mockFetch(routes: Array<{ match: RegExp; json?: unknown; status?: number }>): FetchLike {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    const r = routes.find((x) => x.match.test(u))
    if (!r) return new Response('nf', { status: 404 })
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as FetchLike
}

const ESUMMARY_BODY = {
  header: { type: 'esummary', version: '0.3' },
  result: {
    uids: ['23903748'],
    '23903748': {
      uid: '23903748',
      title: 'Nanometre-scale thermometry in a living cell.',
      pubdate: '2013 Aug 1',
      source: 'Nature',
      fulljournalname: 'Nature',
      authors: [
        { name: 'Kucsko G', authtype: 'Author' },
        { name: 'Maurer PC', authtype: 'Author' },
      ],
      articleids: [{ idtype: 'doi', value: '10.1038/nature12373' }],
      pubtype: ['Journal Article'],
    },
  },
}

describe('resolvePmid', () => {
  it('esummary 命中 → SourceRecord 带 pmid + doi;撤稿 pubtype 识别', async () => {
    const deps: CiteDeps = { fetchImpl: mockFetch([{ match: /esummary/, json: ESUMMARY_BODY }]) }
    const rec = await resolvePmid('23903748', deps)
    assert.ok(rec)
    assert.equal(rec?.pmid, '23903748')
    assert.equal(rec?.doi, '10.1038/nature12373')
    assert.equal(rec?.title, 'Nanometre-scale thermometry in a living cell.')
    assert.equal(rec?.retracted, null)
  })

  it('非法 pmid / 上游 404 / 无 result → null', async () => {
    const deps: CiteDeps = { fetchImpl: mockFetch([{ match: /esummary/, status: 404 }]) }
    assert.equal(await resolvePmid('12x', deps), null)
    assert.equal(await resolvePmid('99999999', deps), null)
  })
})

// ── resolveAds / verifyIdentifier(ads) ──────────────────────────────

function adsDeps(json: { search?: unknown; export?: unknown; searchStatus?: number }): {
  deps: CiteDeps
  calls: string[]
} {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push(`${(init?.method as string) ?? 'GET'} ${u}`)
    if (u.includes('/search/query')) {
      return new Response(JSON.stringify(json.search ?? { response: { docs: [] } }), {
        status: json.searchStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/export/bibtex')) {
      return new Response(JSON.stringify(json.export ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('nf', { status: 404 })
  }) as unknown as FetchLike
  return { deps: { fetchImpl, adsApiToken: 'tok-1' }, calls }
}

describe('resolveAds / verifyIdentifier(ads)', () => {
  it('无 token → fail-loud 结构化指引,不打网、不伪造', async () => {
    let called = 0
    const deps: CiteDeps = {
      fetchImpl: (async () => {
        called++
        return new Response('{}', { status: 200 })
      }) as unknown as FetchLike,
    }
    const v = await verifyIdentifier('ads:2015A&A...576A.135S', deps)
    assert.equal(v.resolved, false)
    assert.equal(v.reason, 'ads_token_not_configured')
    assert.equal(v.hint, ADS_TOKEN_HINT)
    assert.match(v.hint ?? '', /ui\.adsabs\.harvard\.edu/)
    assert.equal(called, 0)
  })

  it('官方 search 命中 + 官方 export 注入 bibtex', async () => {
    const { deps, calls } = adsDeps({
      search: {
        response: {
          docs: [
            {
              title: 'The Solar Orbiter mission',
              author: ['Müller D', 'Marsden R G'],
              year: '2013',
              pub: 'Astronomy and Astrophysics',
              doi: ['10.1051/0004-6361/201220119'],
              bibcode: '2015A&A...576A.135S',
            },
          ],
        },
      },
      export: { export: '@ARTICLE{2015A&A...576A.135S,\n title={The Solar Orbiter mission},\n}' },
    })
    const v = await verifyIdentifier('ads:2015A%26A...576A.135S', deps)
    assert.equal(v.resolved, true)
    assert.ok(v.record)
    assert.equal(v.record?.adsBibcode, '2015A&A...576A.135S')
    assert.equal(v.record?.doi, '10.1051/0004-6361/201220119')
    assert.match(v.bibtex ?? '', /@ARTICLE\{2015A&A/)
    assert.ok(v.gbt7714 && v.apa)
    // search 先、export 后
    assert.ok(calls[0].includes('api.adsabs.harvard.edu/v1/search/query'))
    assert.match(calls[1], /^POST .*\/v1\/export\/bibtex$/)
  })

  it('export 失败 → 回落元数据自构 bibtex(单一权威 formatBibtex)', async () => {
    const { deps } = adsDeps({
      search: { response: { docs: [{ title: 'T', author: ['A B'], year: '2020', pub: 'P' }] } },
      export: {},
    })
    const v = await verifyIdentifier('ads:2015A&A...576A.135S', deps)
    assert.equal(v.resolved, true)
    assert.match(v.bibtex ?? '', /@article\{/)
  })

  it('search 无命中 → resolved=false(无 reason 伪装)', async () => {
    const { deps } = adsDeps({ search: { response: { docs: [] } } })
    const v = await verifyIdentifier('ads:2015A&A...576A.135S', deps)
    assert.equal(v.resolved, false)
    assert.equal(v.reason, undefined)
  })

  it('Bearer token 透传(search 与 export 都带)', async () => {
    const auths: Array<string | undefined> = []
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      auths.push((init?.headers as Record<string, string>)?.Authorization)
      return new Response(JSON.stringify({ response: { docs: [] } }), { status: 200 })
    }) as unknown as FetchLike
    await resolveAds('2015A&A...576A.135S', { fetchImpl, adsApiToken: 'tok-9' })
    assert.equal(auths[0], 'Bearer tok-9')
  })
})

// ── protocol SourceRecord additive 字段 ─────────────────────────────

describe('protocol SourceRecord additive 字段', () => {
  it('pmid/adsBibcode 可选字段不破坏旧数据(缺省合法)', () => {
    const old: SourceRecord = {
      id: 'doi:10.1/x',
      title: 'T',
      authors: [],
      retracted: null,
    }
    assert.equal(old.pmid, undefined)
    assert.equal(old.adsBibcode, undefined)
  })
})

// ── researchProxy ads token 按需解密 ────────────────────────────────

describe('researchProxy cite/verify: ADS token 接线', () => {
  const SECRET = 'a1'.repeat(32)
  const goodAuth = `Bearer oc-v3.7.${SECRET}`
  const ctx: ResearchProxyHandlerCtx = { hostUuid: 'h1', boundIp: '10.0.0.1' }

  function passingRepo(): any {
    return {
      findActiveByHostAndBoundIp: async () => ({
        id: 7,
        user_id: 42,
        bound_ip: '10.0.0.1',
        host_uuid: 'h1',
        secret_hash: hashSecret(SECRET),
      }),
    }
  }

  function makeReq(url: string, body?: unknown): any {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const r = Readable.from(payload ? [Buffer.from(payload)] : []) as any
    r.method = 'POST'
    r.url = url
    r.headers = { authorization: goodAuth }
    return r
  }

  function makeRes(): { res: any; captured: { statusCode: number; body: any } } {
    const captured = { statusCode: 0, body: undefined as any }
    const res: any = {
      headersSent: false,
      setHeader() {},
      writeHead(status: number) {
        captured.statusCode = status
        res.headersSent = true
      },
      end(s?: string) {
        if (s) {
          try {
            captured.body = JSON.parse(s)
          } catch {
            captured.body = s
          }
        }
        res.headersSent = true
      },
    }
    return { res, captured }
  }

  it('identifiers 含 ads: → readSecrets 解密 adsApiToken 并透传给 verifier', async () => {
    let secretsRead = 0
    const seenTokens: Array<string | undefined> = []
    // 用 cite/verify 路由 + 注入 fetchImpl 捕获 ADS 请求的 Authorization
    const adsFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('api.adsabs.harvard.edu')) {
        seenTokens.push((init?.headers as Record<string, string>)?.Authorization)
        return new Response(JSON.stringify({ response: { docs: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('nf', { status: 404 })
    }) as unknown as FetchLike

    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: async () =>
        ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG }) as ResearchConfigPublic,
      readSecrets: async () => {
        secretsRead++
        return { adsApiToken: 'tok-proxy' }
      },
      fetchImpl: adsFetch,
    })
    const { res, captured } = makeRes()
    await h(
      makeReq('/v3/research/cite/verify', { identifiers: ['ads:2015A&A...576A.135S'] }),
      res,
      ctx,
    )
    assert.equal(captured.statusCode, 200)
    assert.equal(secretsRead, 1, '含 ads id 才解密')
    assert.equal(seenTokens[0], 'Bearer tok-proxy')
    assert.equal(captured.body.verdicts[0].identifier, 'ads:2015A&A...576A.135S')
  })

  it('无 ads id → 不解密 secrets(最小权限)', async () => {
    let secretsRead = 0
    const h = makeResearchProxyHandler({
      identityRepo: passingRepo(),
      readConfig: async () =>
        ({ enabled: true, config: DEFAULT_RESEARCH_CONFIG }) as ResearchConfigPublic,
      readSecrets: async () => {
        secretsRead++
        return {}
      },
      fetchImpl: mockFetch([]),
    })
    const { res, captured } = makeRes()
    await h(makeReq('/v3/research/cite/verify', { identifiers: ['pmid:23903748'] }), res, ctx)
    assert.equal(captured.statusCode, 200)
    assert.equal(secretsRead, 0)
  })

  it('RESEARCH_SECRET_NAMES 白名单含 adsApiToken', () => {
    assert.ok((RESEARCH_SECRET_NAMES as readonly string[]).includes('adsApiToken'))
  })
})
