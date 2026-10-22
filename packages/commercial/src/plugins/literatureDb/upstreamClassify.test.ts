/**
 * Upstream page / status classification (OCV5-585 F3/F4).
 *
 * Page markers come from read-only samples taken on 2026-10-22 through the production egress
 * (ocv5-308/g585-upstream-samples.md): Springer zero results carry data-test="no-results", hits
 * carry data-test="results-data" + app-card-open cards, a Wanfang gRPC error is HTTP 200 with a
 * `grpc-status` header and an empty body, and an unsubscribed Springer PDF answers 200 text/html
 * with `<meta name="access" content="No">` and a buy box.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
} from './accountState.js'
import { LiteratureArtifactStore } from './artifactStore.js'
import { LiteratureError } from './errors.js'
import {
  type DownstreamHttpRequester,
  type RawDownstreamResponse,
  SPRINGER_WEBVPN_PREFIX,
  WANFANG_WEBVPN_DOWNLOAD_PREFIX,
  WANFANG_WEBVPN_FULLTEXT_PREFIX,
  WANFANG_WEBVPN_GRPC_PATH,
  WanfangLiteratureHttpExecutor,
  mintScopedDocumentId,
} from './httpExecutor.js'
import { LITERATURE_SITE } from './policy.js'

const SECRET = Buffer.alloc(32, 9)

function authState() {
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, 'ecmsmluserid=101; Path=/', LITERATURE_SITE, Date.now())
  acceptJieyouCookie(jar, 'ecmsmlauth=token101; Path=/', LITERATURE_SITE, Date.now())
  return exportJieyouAccountState(jar)
}

const html = (body: string, status = 200): RawDownstreamResponse => ({
  statusCode: status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(
    `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`,
  ),
})

const SPRINGER_HIT = `<div data-test="results-data"><ol>
  <li class="app-card-open" data-test="search-result-item">
    <div data-test="entitlements">Full access</div>
    <h3 class="app-card-open__heading" data-test="title">
      <a href="${SPRINGER_WEBVPN_PREFIX}/article/10.1038/s41598-026-44184-2"><span>Entangled photons</span></a>
    </h3>
  </li></ol></div>`
const SPRINGER_ZERO =
  '<div class="app-search-message"><h2 data-test="no-results">Sorry, No results were found</h2><p>Please check the spelling of the keywords in your query</p></div>'
const SPRINGER_RESULTS_SHELL_WITHOUT_CARDS =
  '<div data-test="results-data"><h2 class="u-visually-hidden">Search Results</h2><ol><li class="app-card-v2">renamed card</li></ol></div>'
const SPRINGER_NO_ACCESS =
  '<meta name="access" content="No"><div data-test="buy-box-desktop"><h2>Buy Now</h2></div><a data-test="access-via-institution">Access via your institution</a>'
const RATE_LIMIT_PAGE = '<h1>Too Many Requests</h1><p>访问过于频繁，请稍后再试</p>'
const CHALLENGE_PAGE =
  '<h1>安全验证</h1><p>请完成验证码后继续访问</p><form><img src="/captcha.php"></form>'
const MEMBER_LOGIN_PAGE =
  '<p>您还未登录，请先登录</p><form action="/e/member/doaction.php"><input name="username"><input type="password" name="password"></form>'
const UNKNOWN_PAGE = '<h1>Welcome</h1><p>Maintenance notice</p>'

function grpc(status: string | null, body: Buffer = Buffer.alloc(0)): RawDownstreamResponse {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/grpc-web+proto',
      ...(status === null ? {} : { 'grpc-status': status }),
    },
    body,
  }
}

function trailerFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'latin1')
  const head = Buffer.alloc(5)
  head[0] = 0x80
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

function executorWith(requester: DownstreamHttpRequester, store = new LiteratureArtifactStore()) {
  return new WanfangLiteratureHttpExecutor({
    artifactStore: store,
    tokenSecret: SECRET,
    verifyMemberSession: async (s) => s,
    requester,
  })
}

const base = {
  userId: 21,
  ownerUserId: '21',
  accountInstanceId: 'inst-21',
  storageState: authState(),
  signal: new AbortController().signal,
}

function search(requester: DownstreamHttpRequester, query: string) {
  return executorWith(requester).executeRead({
    ...base,
    actionId: 'search',
    params: { query, pageSize: 5 },
  })
}

function download(requester: DownstreamHttpRequester, paperId: string) {
  return executorWith(requester).executeRead({
    ...base,
    actionId: 'download',
    params: {
      documentId: mintScopedDocumentId(SECRET, {
        ownerUserId: '21',
        accountInstanceId: 'inst-21',
        paperId,
      }),
    },
  })
}

const isCode = (code: string) => (err: unknown) =>
  err instanceof LiteratureError && err.code === code

const springerSearch =
  (res: RawDownstreamResponse): DownstreamHttpRequester =>
  async ({ url }) => {
    if (url.pathname === `${SPRINGER_WEBVPN_PREFIX}/search`) return res
    throw new Error(`unexpected ${url.pathname}`)
  }

test('English search: real zero results stay an empty success', async () => {
  const out = await search(springerSearch(html(SPRINGER_ZERO)), 'zzqxvbnmplk')
  assert.deepEqual(out.data.items, [])
  const hit = await search(springerSearch(html(SPRINGER_HIT)), 'entangled photons')
  assert.equal((hit.data.items as unknown[]).length, 1)
})

test('English search: 200 login / no-access / rate-limit / challenge / changed pages are errors, not zero results', async () => {
  await assert.rejects(
    search(springerSearch(html(MEMBER_LOGIN_PAGE)), 'graphene'),
    isCode('SESSION_EXPIRED'),
  )
  await assert.rejects(
    search(springerSearch(html(SPRINGER_NO_ACCESS)), 'graphene'),
    isCode('LITERATURE_NO_ACCESS'),
  )
  await assert.rejects(
    search(springerSearch(html(RATE_LIMIT_PAGE)), 'graphene'),
    isCode('LITERATURE_UPSTREAM_RATE_LIMITED'),
  )
  await assert.rejects(
    search(springerSearch(html(CHALLENGE_PAGE)), 'graphene'),
    isCode('LITERATURE_UPSTREAM_CHALLENGE'),
  )
  await assert.rejects(
    search(springerSearch(html(SPRINGER_RESULTS_SHELL_WITHOUT_CARDS)), 'graphene'),
    isCode('LITERATURE_UPSTREAM_CHANGED'),
  )
  await assert.rejects(
    search(springerSearch(html(UNKNOWN_PAGE)), 'graphene'),
    isCode('LITERATURE_UPSTREAM_CHANGED'),
  )
})

test('English search: 401/403/429 statuses are classified and only a login page re-logins', async () => {
  await assert.rejects(
    search(springerSearch(html(UNKNOWN_PAGE, 403)), 'graphene'),
    isCode('LITERATURE_NO_ACCESS'),
  )
  await assert.rejects(
    search(springerSearch(html(MEMBER_LOGIN_PAGE, 403)), 'graphene'),
    isCode('SESSION_EXPIRED'),
  )
  await assert.rejects(
    search(springerSearch(html(UNKNOWN_PAGE, 429)), 'graphene'),
    isCode('LITERATURE_UPSTREAM_RATE_LIMITED'),
  )
  await assert.rejects(
    search(springerSearch(html(UNKNOWN_PAGE, 401)), 'graphene'),
    isCode('LITERATURE_NO_ACCESS'),
  )
})

const wanfangSearch =
  (res: RawDownstreamResponse): DownstreamHttpRequester =>
  async ({ url }) => {
    if (`${url.pathname}${url.search}` === WANFANG_WEBVPN_GRPC_PATH) return res
    throw new Error(`unexpected ${url.pathname}`)
  }

test('Chinese gRPC search: non-zero grpc-status in header or trailer is an error, grpc-status 0 empty stays empty', async () => {
  await assert.rejects(search(wanfangSearch(grpc('2')), '深度学习'), isCode('RESPONSE_INVALID'))
  await assert.rejects(search(wanfangSearch(grpc('7')), '深度学习'), isCode('LITERATURE_NO_ACCESS'))
  await assert.rejects(
    search(wanfangSearch(grpc('8')), '深度学习'),
    isCode('LITERATURE_UPSTREAM_RATE_LIMITED'),
  )
  await assert.rejects(
    search(
      wanfangSearch(grpc(null, trailerFrame('grpc-status:13\r\ngrpc-message:boom\r\n'))),
      '深度学习',
    ),
    isCode('RESPONSE_INVALID'),
  )
  await assert.rejects(
    search(wanfangSearch(html(CHALLENGE_PAGE)), '深度学习'),
    isCode('LITERATURE_UPSTREAM_CHALLENGE'),
  )
  const empty = await search(wanfangSearch(grpc('0')), '深度学习')
  assert.deepEqual(empty.data.items, [])
  const emptyTrailer = await search(
    wanfangSearch(grpc(null, trailerFrame('grpc-status:0\r\n'))),
    '深度学习',
  )
  assert.deepEqual(emptyTrailer.data.items, [])
})

test('Springer PDF: unsubscribed article page is LITERATURE_NO_ACCESS, never SESSION_EXPIRED', async () => {
  const pdfPath = `${SPRINGER_WEBVPN_PREFIX}/content/pdf/10.1007/s12551-025-01281-2.pdf`
  const req =
    (res: RawDownstreamResponse): DownstreamHttpRequester =>
    async ({ url }) => {
      if (url.pathname === pdfPath) return res
      throw new Error(`unexpected ${url.pathname}`)
    }
  await assert.rejects(
    download(req(html(SPRINGER_NO_ACCESS)), 'sp_10.1007_s12551-025-01281-2'),
    isCode('LITERATURE_NO_ACCESS'),
  )
  await assert.rejects(
    download(req(html(UNKNOWN_PAGE)), 'sp_10.1007_s12551-025-01281-2'),
    isCode('RESPONSE_INVALID'),
  )
  await assert.rejects(
    download(req(html(MEMBER_LOGIN_PAGE)), 'sp_10.1007_s12551-025-01281-2'),
    isCode('SESSION_EXPIRED'),
  )
  await assert.rejects(
    download(req(html(RATE_LIMIT_PAGE)), 'sp_10.1007_s12551-025-01281-2'),
    isCode('LITERATURE_UPSTREAM_RATE_LIMITED'),
  )
  await assert.rejects(
    download(req(html(UNKNOWN_PAGE, 403)), 'sp_10.1007_s12551-025-01281-2'),
    isCode('LITERATURE_NO_ACCESS'),
  )
})

test('Wanfang download: 401/403/429 without Location on the first and middle hops keep their meaning', async () => {
  const hop1 = `${WANFANG_WEBVPN_DOWNLOAD_PREFIX}dlx202601001.aspx`
  const middle = '/middle/hop'
  const run = (hop1Res: RawDownstreamResponse, middleRes?: RawDownstreamResponse) =>
    download(async ({ url }) => {
      if (url.pathname === hop1) return hop1Res
      if (url.pathname === middle && middleRes) return middleRes
      if (url.pathname === WANFANG_WEBVPN_FULLTEXT_PREFIX)
        throw new Error('must not reach fulltext')
      throw new Error(`unexpected ${url.pathname}`)
    }, 'dlx202601001')
  const redirectToMiddle: RawDownstreamResponse = {
    statusCode: 302,
    headers: { location: middle },
    body: Buffer.alloc(0),
  }
  for (const [label, first, mid] of [
    ['first', html(UNKNOWN_PAGE, 429), undefined],
    ['middle', redirectToMiddle, html(UNKNOWN_PAGE, 429)],
  ] as const) {
    await assert.rejects(run(first, mid), isCode('LITERATURE_UPSTREAM_RATE_LIMITED'), label)
  }
  await assert.rejects(run(html(UNKNOWN_PAGE, 403)), isCode('LITERATURE_NO_ACCESS'))
  await assert.rejects(
    run(redirectToMiddle, html(UNKNOWN_PAGE, 401)),
    isCode('LITERATURE_NO_ACCESS'),
  )
  await assert.rejects(
    run(redirectToMiddle, html(MEMBER_LOGIN_PAGE, 403)),
    isCode('SESSION_EXPIRED'),
  )
  await assert.rejects(run(html(CHALLENGE_PAGE)), isCode('LITERATURE_UPSTREAM_CHALLENGE'))
  // Unknown 200 page without a transaction keeps the historical "no usable PDF" meaning.
  await assert.rejects(run(html(UNKNOWN_PAGE)), isCode('RESPONSE_INVALID'))
})

test('member entry check: only an explicit login signal is SESSION_EXPIRED', async () => {
  const { classifyMemberEntryResponse } = await import('./upstreamClassify.js')
  const page = (
    status: number,
    body: string,
    url = `${LITERATURE_SITE}/e/action/ShowInfo.php`,
  ) => ({
    status,
    url,
    contentType: 'text/html',
    body: Buffer.from(body),
  })
  assert.equal(classifyMemberEntryResponse(page(200, '<a href="ShowInfo.php">会员专区</a>')), null)
  assert.equal(
    classifyMemberEntryResponse(page(200, '', `${LITERATURE_SITE}/e/member/login/`))?.code,
    'SESSION_EXPIRED',
  )
  assert.equal(classifyMemberEntryResponse(page(200, MEMBER_LOGIN_PAGE))?.code, 'SESSION_EXPIRED')
  assert.equal(classifyMemberEntryResponse(page(401, ''))?.code, 'SESSION_EXPIRED')
  assert.equal(classifyMemberEntryResponse(page(429, ''))?.code, 'LITERATURE_UPSTREAM_RATE_LIMITED')
  assert.equal(
    classifyMemberEntryResponse(page(403, CHALLENGE_PAGE))?.code,
    'LITERATURE_UPSTREAM_CHALLENGE',
  )
  assert.equal(classifyMemberEntryResponse(page(502, ''))?.code, 'RESPONSE_INVALID')
})
