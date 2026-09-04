/**
 * fetchFulltext 单测(R5 Phase A):六策略链序、结构化失败、内容校验、
 * proxy 只在显式配置时使用、编排器(下载→blob→ingest→membership)。
 * 全部 mock HTTP,不打真网。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  FETCH_FAIL_REASONS,
  type FetchRecordInput,
  _resetProxyCache,
  arxivIdFromDoi,
  downloadFulltext,
} from '../research/fetchFulltext.js'
import { vetFetchTarget } from '../research/fetchUrlGuard.js'
import { fetchRecordIntoLibrary } from '../research/researchHandlers.js'
import type { FetchAttemptRowInput } from '../research/store.js'

// ── helpers ──────────────────────────────────────────────────────────

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, 0x61)])

function pdfResponse(bytes: Buffer = PDF_BYTES): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  })
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

type Route = { match: string | RegExp; respond: (url: string) => Response | Promise<Response> }

function mockFetch(routes: Route[], log: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    log.push(u)
    const r = routes.find((x) =>
      typeof x.match === 'string' ? u.includes(x.match) : x.match.test(u),
    )
    if (!r) return new Response('nf', { status: 404 })
    return r.respond(u)
  }) as unknown as typeof fetch
}

function record(over: Partial<FetchRecordInput> = {}): FetchRecordInput {
  return { id: 'r1', title: 'A paper', ...over }
}

/** 测试 host(publisher.example 等)不打真 DNS:一律解到公网地址,让 SSRF 门放行。 */
const PUBLIC_DNS = {
  resolve4: async () => ['93.184.216.34'],
  resolve6: async () => [] as string[],
}

// ── arxivIdFromDoi ───────────────────────────────────────────────────

describe('fetchFulltext: arxivIdFromDoi', () => {
  it('10.48550/arxiv.<id> → id;其它 DOI → undefined', () => {
    assert.equal(arxivIdFromDoi('10.48550/arxiv.2301.01234'), '2301.01234')
    assert.equal(arxivIdFromDoi('10.48550/arxiv.2301.01234v2'), undefined)
    assert.equal(arxivIdFromDoi('10.1038/nature12373'), undefined)
    assert.equal(arxivIdFromDoi(undefined), undefined)
  })
})

// ── 策略链 ───────────────────────────────────────────────────────────

describe('fetchFulltext: 策略链', () => {
  it('known_oa:record.oa.url 直接命中 PDF', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [{ match: 'publisher.example', respond: () => pdfResponse() }],
      urls,
    )
    const r = await downloadFulltext(
      record({ oa: { url: 'https://publisher.example/oa/paper.pdf' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.strategy, 'known_oa')
      assert.equal(r.attempts.length, 1)
      assert.equal(r.attempts[0].code, 'ok')
    }
    assert.deepEqual(urls, ['https://publisher.example/oa/paper.pdf'])
  })

  it('known_oa:arXiv abs 链接改写为 /pdf/', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch([{ match: 'arxiv.org', respond: () => pdfResponse() }], urls)
    const r = await downloadFulltext(
      record({ arxivId: undefined, oa: { url: 'https://arxiv.org/abs/2301.01234' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    assert.deepEqual(urls, ['https://arxiv.org/pdf/2301.01234'])
  })

  it('arxiv:arxivId 命中 → arxiv.org/pdf/<id>;DOI 10.48550/arxiv.* 同样成立', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch([{ match: 'arxiv.org', respond: () => pdfResponse() }], urls)
    const r1 = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r1.ok && r1.strategy, 'arxiv')
    const r2 = await downloadFulltext(
      record({ doi: '10.48550/arxiv.2301.01234' }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r2.ok && r2.strategy, 'arxiv')
    assert.deepEqual(urls, [
      'https://arxiv.org/pdf/2301.01234',
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI%3A%2210.48550%2Farxiv.2301.01234%22&format=json&resultType=core',
      'https://arxiv.org/pdf/2301.01234',
    ])
  })

  it('unpaywall_pdf:有 DOI+email → Unpaywall best_oa_location.url_for_pdf;链序正确', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        {
          match: 'api.unpaywall.org',
          respond: () =>
            new Response(
              JSON.stringify({
                is_oa: true,
                best_oa_location: {
                  url_for_pdf: 'https://plos.example/article/file',
                  url: 'https://plos.example/landing',
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        { match: 'plos.example/article/file', respond: () => pdfResponse() },
        { match: 'plos.example', respond: () => htmlResponse('<html>landing</html>') },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ doi: '10.1371/journal.pone.0026140', arxivId: undefined }),
      { unpaywallEmail: 'research@example.org' },
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.strategy, 'unpaywall_pdf')
    // 只查 unpaywall + EPMC(无命中)+ 下载 pdf 一次;landing(publisher_oa)未触达(命中即停)
    assert.deepEqual(urls, [
      'https://api.unpaywall.org/v2/10.1371%2Fjournal.pone.0026140?email=research%40example.org',
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI%3A%2210.1371%2Fjournal.pone.0026140%22&format=json&resultType=core',
      'https://plos.example/article/file',
    ])
  })

  it('pmc_oa:Europe PMC fullTextUrlList 的 OA pdf 条目命中', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        {
          match: 'ebi.ac.uk',
          respond: () =>
            new Response(
              JSON.stringify({
                resultList: {
                  result: [
                    {
                      isOpenAccess: 'Y',
                      pmcid: 'PMC3203868',
                      fullTextUrlList: {
                        fullTextUrl: [
                          {
                            documentStyle: 'doi',
                            availabilityCode: 'S',
                            url: 'https://doi.org/10.1371/x',
                          },
                          {
                            documentStyle: 'pdf',
                            availabilityCode: 'OA',
                            site: 'Europe_PMC',
                            url: 'https://europepmc.org/articles/PMC3203868?pdf=render',
                          },
                        ],
                      },
                    },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        },
        { match: 'europepmc.org', respond: () => pdfResponse() },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ doi: '10.1371/journal.pone.0026140', arxivId: undefined }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.strategy, 'pmc_oa')
    assert.ok(urls[0].startsWith('https://www.ebi.ac.uk/europepmc/webservices/rest/search?'))
    assert.ok(
      urls[0].includes('DOI%3A%2210.1371%2Fjournal.pone.0026140%22') || urls[0].includes('10.1371'),
    )
  })

  it('链式回退:known_oa 404 → arxiv 命中(顺序可观测)', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        { match: 'publisher.example', respond: () => new Response('gone', { status: 404 }) },
        { match: 'arxiv.org', respond: () => pdfResponse() },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234', oa: { url: 'https://publisher.example/oa/x.pdf' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.strategy, 'arxiv')
      assert.deepEqual(
        r.attempts.map((a) => [a.source, a.code]),
        [
          ['known_oa', 'fetch_error_4xx'],
          ['arxiv', 'ok'],
        ],
      )
      assert.equal(r.attempts[0].httpStatus, 404)
    }
  })

  it('publisher_oa:unpaywall 无 pdf url、landing 返回真 PDF 才收', async () => {
    const fetchImpl = mockFetch([
      {
        match: 'api.unpaywall.org',
        respond: () =>
          new Response(
            JSON.stringify({
              is_oa: true,
              best_oa_location: { url_for_pdf: null, url: 'https://pub.example/direct.pdf' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
      { match: 'pub.example', respond: () => pdfResponse() },
    ])
    const r = await downloadFulltext(
      record({ doi: '10.1/x', arxivId: undefined }),
      { unpaywallEmail: 'research@example.org' },
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.strategy, 'publisher_oa')
  })
})

// ── 结构化失败 ───────────────────────────────────────────────────────

describe('fetchFulltext: 结构化失败', () => {
  it('no_identifier:无 doi/arxiv/oa/title', async () => {
    const r = await downloadFulltext(
      { id: 'r1' },
      {},
      { fetchImpl: mockFetch([]), guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'no_identifier')
      assert.deepEqual(r.attempts, [])
    }
  })

  it('paywalled:unpaywall 明确 is_oa=false 且全链无命中', async () => {
    const fetchImpl = mockFetch([
      {
        match: 'api.unpaywall.org',
        respond: () =>
          new Response(JSON.stringify({ is_oa: false, best_oa_location: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ])
    const r = await downloadFulltext(
      record({ doi: '10.1/closed', arxivId: undefined }),
      { unpaywallEmail: 'research@example.org' },
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'paywalled')
  })

  it('blocked_robot:HTML 挑战页 → 终态,不再走 proxy', async () => {
    const proxyCalls: string[] = []
    const fetchImpl = mockFetch([
      {
        match: 'arxiv.org',
        respond: () =>
          htmlResponse('<html>Please complete the CAPTCHA challenge to continue</html>'),
      },
    ])
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      { proxyUrl: 'http://proxy.example:3128' },
      {
        fetchImpl,
        guardResolver: PUBLIC_DNS,
        proxyFetchImpl: (async (u: string | URL | Request) => {
          proxyCalls.push(String(u))
          return pdfResponse()
        }) as unknown as typeof fetch,
      },
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'blocked_robot')
    assert.equal(proxyCalls.length, 0, '验证码页不可绕过,proxy 不得重试')
  })

  it('not_pdf:landing HTML(无 captcha 特征)→ not_pdf;最终 reason=not_pdf', async () => {
    const fetchImpl = mockFetch([
      {
        match: 'arxiv.org',
        respond: () => htmlResponse('<html><body>article landing page</body></html>'),
      },
    ])
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'not_pdf')
      assert.equal(r.attempts[0].code, 'not_pdf')
      assert.match(r.attempts[0].detail ?? '', /not a PDF/)
    }
  })

  it('too_large:content-length 超上限 → 中止不下载', async () => {
    const fetchImpl = mockFetch([
      {
        match: 'arxiv.org',
        respond: () =>
          new Response(new Uint8Array(32), {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(30 * 1024 * 1024),
            },
          }),
      },
    ])
    // mock 返回小 body 但 content-length 声明超限 → 预检即拒
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      { fetchImpl, maxBytes: 1024 * 1024, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'too_large')
  })

  it('timeout:abort → reason=timeout;瞬时 500 重试一次后成功不记失败', async () => {
    let n = 0
    const fetchImpl = mockFetch([
      {
        match: 'arxiv.org',
        respond: () => {
          n++
          if (n === 1) return new Response('err', { status: 500 })
          return pdfResponse()
        },
      },
    ])
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      { fetchImpl, retryDelayMs: 0, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    assert.equal(n, 2, '瞬时 5xx 有界重试')

    const hang: typeof fetch = ((url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal
        if (sig && !(sig as AbortSignal).aborted) {
          ;(sig as AbortSignal).addEventListener('abort', () => {
            const e = new Error('This operation was aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })) as unknown as typeof fetch
    const r2 = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      { fetchImpl: hang, timeoutMs: 40, retryDelayMs: 0, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.reason, 'timeout')
  })

  it('no_oa_location:无 unpaywall 配置、无 arxiv、EPMC 无命中 → 无候选', async () => {
    const fetchImpl = mockFetch([
      {
        match: 'ebi.ac.uk',
        respond: () =>
          new Response(JSON.stringify({ resultList: { result: [] } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    ])
    const r = await downloadFulltext(
      record({ doi: '10.1/x', arxivId: undefined }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'no_oa_location')
  })

  it('失败枚举完备:attempts 里出现的 code 都在 FETCH_FAIL_REASONS 或 ok', () => {
    assert.deepEqual([...FETCH_FAIL_REASONS].sort(), [
      'blocked_robot',
      'blocked_target',
      'fetch_error_4xx',
      'fetch_error_5xx',
      'no_identifier',
      'no_oa_location',
      'not_pdf',
      'paywalled',
      'proxy_unavailable',
      'timeout',
      'too_large',
    ])
  })
})

// ── SSRF 边界(auditor W3)────────────────────────────────────────────

describe('fetchFulltext: SSRF 边界', () => {
  const blockedIps = ['127.0.0.1', '172.31.0.1', '10.8.0.5', '169.254.169.254', '[::1]']

  for (const ip of blockedIps) {
    it(`known_oa 指向 ${ip} → blocked_target,且 fetch 不发出`, async () => {
      const urls: string[] = []
      const fetchImpl = mockFetch([{ match: ip, respond: () => pdfResponse() }], urls)
      const r = await downloadFulltext(
        record({ oa: { url: `http://${ip}:18892/x.pdf` } }),
        {},
        { fetchImpl, guardResolver: PUBLIC_DNS },
      )
      assert.equal(r.ok, false)
      if (!r.ok) {
        assert.equal(r.reason, 'blocked_target')
        const a = r.attempts.find((x) => x.source === 'known_oa')
        assert.equal(a?.code, 'blocked_target')
        assert.match(String(a?.detail), /target rejected/)
      }
      assert.equal(urls.filter((u) => u.includes(ip)).length, 0)
    })
  }

  it('域名解析到私网地址 → blocked_target', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch([{ match: 'evil.example', respond: () => pdfResponse() }], urls)
    const r = await downloadFulltext(
      record({ oa: { url: 'https://evil.example/paper.pdf' } }),
      {},
      {
        fetchImpl,
        guardResolver: {
          resolve4: async () => ['93.184.216.34', '172.31.0.9'],
          resolve6: async () => [],
        },
      },
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'blocked_target')
    assert.equal(urls.length, 0)
  })

  it('redirect 某跳指回内网 → blocked_target,detail 带 hop 序号,该跳不发出', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        {
          match: 'publisher.example/landing',
          respond: () =>
            new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:5432/' } }),
        },
        { match: '127.0.0.1', respond: () => pdfResponse() },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ oa: { url: 'https://publisher.example/landing' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'blocked_target')
      const a = r.attempts.find((x) => x.source === 'known_oa')
      assert.match(String(a?.detail), /redirect hop 1 rejected/)
    }
    assert.equal(urls.filter((u) => u.includes('127.0.0.1')).length, 0)
  })

  it('公网 redirect 正常跟随(相对 Location 亦可)→ 命中 PDF', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        {
          match: 'publisher.example/landing',
          respond: () =>
            new Response(null, { status: 301, headers: { location: '/files/paper.pdf' } }),
        },
        {
          match: 'publisher.example/files/paper.pdf',
          respond: () =>
            new Response(null, { status: 307, headers: { location: 'https://cdn.example/p.pdf' } }),
        },
        { match: 'cdn.example', respond: () => pdfResponse() },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ oa: { url: 'https://publisher.example/landing' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS },
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.strategy, 'known_oa')
    assert.deepEqual(urls, [
      'https://publisher.example/landing',
      'https://publisher.example/files/paper.pdf',
      'https://cdn.example/p.pdf',
    ])
  })

  it('redirect 超过 5 跳 → fetch_error_4xx(too many redirects),不无限跟随', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch(
      [
        {
          match: 'loop.example',
          respond: (u) => {
            const n = Number(new URL(u).searchParams.get('n') ?? '0')
            return new Response(null, {
              status: 302,
              headers: { location: `https://loop.example/?n=${n + 1}` },
            })
          },
        },
      ],
      urls,
    )
    const r = await downloadFulltext(
      record({ oa: { url: 'https://loop.example/?n=0' } }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS, retryDelayMs: 0 },
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'fetch_error_4xx')
      const a = r.attempts.find((x) => x.source === 'known_oa')
      assert.match(String(a?.detail), /too many redirects/)
    }
    assert.equal(urls.length, 6)
  })

  it('blocked_target 不重试(非 transient),且不影响后续策略继续', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch([{ match: 'arxiv.org', respond: () => pdfResponse() }], urls)
    const r = await downloadFulltext(
      record({ oa: { url: 'http://10.0.0.1/x.pdf' }, arxivId: '2301.01234' }),
      {},
      { fetchImpl, guardResolver: PUBLIC_DNS, retryDelayMs: 0 },
    )
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.strategy, 'arxiv')
      const blocked = r.attempts.filter((x) => x.source === 'known_oa')
      assert.equal(blocked.length, 1)
      assert.equal(blocked[0]?.code, 'blocked_target')
    }
    assert.equal(urls.filter((u) => u.includes('10.0.0.1')).length, 0)
  })

  it('非 http(s) scheme / userinfo:候选期已被 safeCandidateUrl 剔除(no_oa_location),门内再拒一层', async () => {
    const urls: string[] = []
    const fetchImpl = mockFetch([], urls)
    for (const url of ['file:///etc/passwd', 'https://user:pw@publisher.example/x.pdf']) {
      const r = await downloadFulltext(
        record({ oa: { url } }),
        {},
        { fetchImpl, guardResolver: PUBLIC_DNS },
      )
      assert.equal(r.ok, false)
      if (!r.ok) assert.equal(r.reason, 'no_oa_location')
    }
    assert.equal(urls.length, 0)
    // 门自身(redirect Location 不经 safeCandidateUrl,靠这层兜底)
    for (const url of ['file:///etc/passwd', 'ftp://x.example/a', 'https://u:p@x.example/a']) {
      const v = await vetFetchTarget(url, PUBLIC_DNS)
      assert.equal(v.ok, false)
    }
    assert.equal((await vetFetchTarget('https://x.example/a', PUBLIC_DNS)).ok, true)
    assert.equal((await vetFetchTarget('http://localhost/a', PUBLIC_DNS)).ok, false)
    assert.equal((await vetFetchTarget('http://db.local/a', PUBLIC_DNS)).ok, false)
  })
})

// ── proxy pass ───────────────────────────────────────────────────────

describe('fetchFulltext: 机构 proxy', () => {
  it('直接链失败 + proxyUrl 配置 → 候选经 proxy 重放成功(strategy=arxiv:proxy)', async () => {
    const directUrls: string[] = []
    const proxyUrls: string[] = []
    const direct = mockFetch(
      [{ match: 'arxiv.org', respond: () => new Response('denied', { status: 403 }) }],
      directUrls,
    )
    _resetProxyCache()
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      { proxyUrl: 'http://proxy.example:3128' },
      {
        fetchImpl: direct,
        guardResolver: PUBLIC_DNS,
        proxyFetchImpl: (async (u: string | URL | Request) => {
          proxyUrls.push(String(u))
          return pdfResponse()
        }) as unknown as typeof fetch,
      },
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.strategy, 'arxiv:proxy')
    assert.deepEqual(
      proxyUrls,
      directUrls.filter((u) => u.includes('arxiv.org')),
    )
  })

  it('未配置 proxyUrl → proxyFetchImpl 绝不被调用', async () => {
    let proxyCalls = 0
    const direct = mockFetch([
      { match: 'arxiv.org', respond: () => new Response('nf', { status: 404 }) },
    ])
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      {},
      {
        fetchImpl: direct,
        guardResolver: PUBLIC_DNS,
        proxyFetchImpl: (async () => {
          proxyCalls++
          return pdfResponse()
        }) as unknown as typeof fetch,
      },
    )
    assert.equal(r.ok, false)
    assert.equal(proxyCalls, 0)
  })

  it('全部候选代理后仍失败 → reason 取最后失败码', async () => {
    _resetProxyCache()
    const r = await downloadFulltext(
      record({ arxivId: '2301.01234' }),
      { proxyUrl: 'http://proxy.example:3128' },
      {
        guardResolver: PUBLIC_DNS,
        fetchImpl: mockFetch([
          { match: 'arxiv.org', respond: () => new Response('x', { status: 404 }) },
        ]),
        proxyFetchImpl: mockFetch([
          { match: 'arxiv.org', respond: () => new Response('y', { status: 404 }) },
        ]) as unknown as typeof fetch,
      },
    )
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.reason, 'fetch_error_4xx')
      assert.deepEqual(
        r.attempts.map((a) => a.source),
        ['arxiv', 'arxiv:proxy'],
      )
    }
  })
})

// ── 编排器 fetchRecordIntoLibrary ────────────────────────────────────

function makeStoreDeps() {
  const blobs = new Map<string, Buffer>()
  const docs: unknown[] = []
  const attempts: FetchAttemptRowInput[] = []
  const memberships: Array<[string, string, string]> = []
  return {
    blobs,
    docs,
    attempts,
    memberships,
    deps: {
      http: {
        guardResolver: PUBLIC_DNS,
        fetchImpl: mockFetch([{ match: 'arxiv.org', respond: () => pdfResponse() }]),
      },
      putBlob: async (p: { blobId: string; mime?: string }) => {
        blobs.set(p.blobId, Buffer.alloc(0))
      },
      getBlob: async (_u: number, blobId: string) => ({
        storagePath: `/tmp/x-${blobId}`,
        mime: 'application/pdf',
      }),
      readBlobBytes: async (p: string) =>
        Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(2048, 0x62)]),
      putDocument: async (_u: number, doc: unknown) => {
        docs.push(doc)
      },
      writeBlobBytes: async (_p: string, _b: Buffer) => {},
      blobDir: '/tmp/test-blobs',
      recordAttempt: async (row: FetchAttemptRowInput) => {
        attempts.push(row)
      },
      addMembership: async (uid: string, docId: string, pid: string) => {
        memberships.push([uid, docId, pid])
      },
      extract: {
        pdfImpl: async () => ({ text: 'x'.repeat(200), info: { Title: 'A paper' } }),
      },
    } as Parameters<typeof fetchRecordIntoLibrary>[2],
  }
}

describe('fetchRecordIntoLibrary 编排器', () => {
  it('下载成功 → blob+ingest+attempts+membership,status=fetched', async () => {
    const s = makeStoreDeps()
    const outcome = await fetchRecordIntoLibrary(
      {
        userId: 42,
        record: record({ arxivId: '2301.01234' }),
        projectId: 'proj-1',
        ingest: true,
        engine: 'local',
      },
      {},
      s.deps,
    )
    assert.equal(outcome.status, 'fetched')
    assert.ok(outcome.docId)
    assert.ok(outcome.blobId)
    assert.equal(outcome.strategy, 'arxiv')
    assert.equal(outcome.projectAdded, true)
    assert.equal(s.attempts.length, 1)
    assert.equal(s.attempts[0].ok, true)
    assert.equal(s.attempts[0].docId, outcome.docId)
    assert.equal(s.memberships.length, 1)
  })

  it('needs_ocr:下载成功但无文字层 → 合法成功态', async () => {
    const s = makeStoreDeps()
    s.deps.extract = { pdfImpl: async () => ({ text: '   ' }) }
    const outcome = await fetchRecordIntoLibrary(
      { userId: 42, record: record({ arxivId: '2301.01234' }), ingest: true, engine: 'local' },
      {},
      s.deps,
    )
    assert.equal(outcome.status, 'needs_ocr')
    assert.equal(outcome.reason, 'needs_ocr')
    assert.ok(outcome.blobId)
    assert.equal(outcome.docId, undefined)
  })

  it('ingest=false → 只落 blob 不铸造文档', async () => {
    const s = makeStoreDeps()
    const outcome = await fetchRecordIntoLibrary(
      { userId: 42, record: record({ arxivId: '2301.01234' }), ingest: false, engine: 'local' },
      {},
      s.deps,
    )
    assert.equal(outcome.status, 'fetched')
    assert.ok(outcome.blobId)
    assert.equal(outcome.docId, undefined)
    assert.equal(s.docs.length, 0)
  })

  it('membership 失败 fail-soft:下载仍成功', async () => {
    const s = makeStoreDeps()
    s.deps.addMembership = async () => {
      throw new Error('db down')
    }
    const outcome = await fetchRecordIntoLibrary(
      {
        userId: 42,
        record: record({ arxivId: '2301.01234' }),
        projectId: 'p',
        ingest: true,
        engine: 'local',
      },
      {},
      s.deps,
    )
    assert.equal(outcome.status, 'fetched')
    assert.equal(outcome.projectAdded, false)
  })

  it('下载失败 → 结构化 failed,attempts 全记录,不动 blob', async () => {
    const s = makeStoreDeps()
    s.deps.http = {
      guardResolver: PUBLIC_DNS,
      fetchImpl: mockFetch([
        { match: 'arxiv.org', respond: () => new Response('nf', { status: 404 }) },
      ]),
    }
    const outcome = await fetchRecordIntoLibrary(
      { userId: 42, record: record({ arxivId: '2301.01234' }), ingest: true, engine: 'local' },
      {},
      s.deps,
    )
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.reason, 'fetch_error_4xx')
    assert.equal(s.attempts.length, 1)
    assert.equal(s.attempts[0].ok, false)
    assert.equal(s.attempts[0].strategy, 'arxiv')
    assert.equal(s.blobs.size, 0)
  })
})
