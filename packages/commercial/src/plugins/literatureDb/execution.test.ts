import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import {
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
} from './accountState.js'
import {
  LiteratureArtifactStore,
  validatePdfInIsolatedWorker,
  validatePdfStructureSync,
} from './artifactStore.js'
import { LITERATURE_PLUGIN_CONTRACT } from './builtinContract.js'

const LITERATURE_SEARCH_OUTPUT_SCHEMA = LITERATURE_PLUGIN_CONTRACT.actions.find((a) => a.id === 'search')!.result
const LITERATURE_DOWNLOAD_OUTPUT_SCHEMA = LITERATURE_PLUGIN_CONTRACT.actions.find((a) => a.id === 'download')!.result
import { LiteratureError } from './errors.js'
import {
  SPRINGER_WEBVPN_PREFIX,
  WANFANG_WEBVPN_DOWNLOAD_PREFIX,
  WANFANG_WEBVPN_FULLTEXT_PREFIX,
  WANFANG_WEBVPN_GRPC_PATH,
  WanfangLiteratureHttpExecutor,
  createPinnedDownstreamRequester,
  mintScopedDocumentId,
  parseSpringerSearchHtml,
  verifyScopedDocumentId,
} from './httpExecutor.js'
import {
  classifyJieyouLoginPost,
  hasJieyouMemberAuthCookies,
  reloginJieyouAutomatically,
} from './jieyouLoginSession.js'
import { LITERATURE_SITE } from './policy.js'
import { validateRuntimePluginJson } from '../contracts.js'

const VALID_PDF = (() => {
  const header = '%PDF-1.4\n'
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
  const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'
  const o1 = header.length
  const o2 = o1 + obj1.length
  const o3 = o2 + obj2.length
  const xrefOffset = o3 + obj3.length
  const pad = (n: number) => String(n).padStart(10, '0')
  const xref = `xref\n0 4\n0000000000 65535 f \n${pad(o1)} 00000 n \n${pad(o2)} 00000 n \n${pad(o3)} 00000 n \n`
  const trailer = `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(header + obj1 + obj2 + obj3 + xref + trailer, 'latin1')
})()

function buildAuthenticatedState() {
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, 'ecmsmluserid=101; Path=/', LITERATURE_SITE, Date.now())
  acceptJieyouCookie(jar, 'ecmsmlusername=vipuser; Path=/', LITERATURE_SITE, Date.now())
  acceptJieyouCookie(jar, 'ecmsmlrnd=rnd101; Path=/', LITERATURE_SITE, Date.now())
  acceptJieyouCookie(jar, 'ecmsmlauth=token101; Path=/', LITERATURE_SITE, Date.now())
  return exportJieyouAccountState(jar)
}

function buildWanfangPeriodicalFixture(
  id: string,
  title: string,
  author: string,
  journal: string,
  year: number,
): Buffer {
  const encodeVarint = (val: number): Buffer => {
    const bytes: number[] = []
    let v = val >>> 0
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80)
      v >>>= 7
    }
    bytes.push(v)
    return Buffer.from(bytes)
  }
  const strField = (fn: number, s: string) => {
    const b = Buffer.from(s, 'utf8')
    return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(b.length), b])
  }
  const varintField = (fn: number, v: number) =>
    Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(v)])

  const perio = Buffer.concat([
    strField(1, id),
    strField(2, title),
    strField(3, author),
    strField(20, '中文摘要内容'),
    strField(23, journal),
    varintField(33, year),
    strField(74, 'FULLTEXT'),
  ])
  const marker = Buffer.from('\x0a\x0aPeriodical\xba\x06', 'latin1')
  return Buffer.concat([Buffer.alloc(5), marker, encodeVarint(perio.length), perio])
}

test('validatePdfStructureSync and validatePdfInIsolatedWorker accept valid PDFs and reject invalid buffers', async () => {
  const signal = new AbortController().signal
  assert.equal(validatePdfStructureSync(VALID_PDF), true)
  assert.equal(await validatePdfInIsolatedWorker(VALID_PDF, signal), true)

  assert.equal(validatePdfStructureSync(Buffer.from('<html>not a pdf</html>')), false)
  const fakeHtmlWithPdfMarkers = Buffer.from(
    '%PDF-1.7\n<!-- filler bytes over 64 chars --> /Type /Page /Count 1 \n%%EOF\n',
    'latin1',
  )
  assert.equal(validatePdfStructureSync(fakeHtmlWithPdfMarkers), false)
  assert.equal(await validatePdfInIsolatedWorker(fakeHtmlWithPdfMarkers, signal), false)
  assert.equal(
    await validatePdfInIsolatedWorker(
      Buffer.from('%PDF-1.4\nmissing eof marker without trailer'),
      signal,
    ),
    false,
  )
})

test('LiteratureArtifactStore enforces staged publish, user isolation, TTL, and cleanup', async () => {
  let now = 1_700_000_000_000
  const store = new LiteratureArtifactStore({ now: () => now, ttlMs: 60_000 })
  const signal = new AbortController().signal
  const staged = await store.stagePdf({
    userId: 7,
    filename: '论文: 深度学习/测试?.pdf',
    data: VALID_PDF,
    signal,
  })
  assert.equal(staged.result.bytes, VALID_PDF.length)
  // Unpublished artifact is invisible to read()
  assert.equal(store.read(7, staged.artifactId), null)

  staged.publish()
  assert.equal(staged.result.mimeType, 'application/pdf')

  // Wrong user cannot read
  assert.equal(store.read(8, staged.artifactId), null)
  // Correct user reads exact bytes
  const found = store.read(7, staged.artifactId)
  assert(found)
  assert.deepEqual(found.data, VALID_PDF)

  // Expired after TTL
  now += 61_000
  assert.equal(store.read(7, staged.artifactId), null)
})

test('mintScopedDocumentId and verifyScopedDocumentId enforce opaqueId schema, owner/instance binding, and expiry', () => {
  const secret = Buffer.alloc(32, 9)
  const now = 1_700_000_000_000
  const docId = mintScopedDocumentId(secret, {
    ownerUserId: '42',
    accountInstanceId: 'inst-42',
    paperId: 'sp_10.1007_s11128-026-05359-y',
    nowMs: now,
  })
  assert.match(docId, /^[A-Za-z0-9-]{16,128}$/)
  const verified = verifyScopedDocumentId(secret, docId, {
    ownerUserId: '42',
    accountInstanceId: 'inst-42',
    nowMs: now + 1000,
  })
  assert.equal(verified.paperId, 'sp_10.1007_s11128-026-05359-y')

  // Wrong user rejected
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '43',
        accountInstanceId: 'inst-42',
        nowMs: now + 1000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'INVALID_INPUT',
  )
  // Wrong account instance rejected
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '42',
        accountInstanceId: 'inst-other',
        nowMs: now + 1000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'INVALID_INPUT',
  )
  // Expired rejected
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '42',
        accountInstanceId: 'inst-42',
        nowMs: now + 3 * 60 * 60 * 1000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'INVALID_INPUT',
  )
})

test('jieyouLoginSession classifies responses and reloginJieyouAutomatically retries until authenticated', async () => {
  const authState = buildAuthenticatedState()
  assert.equal(hasJieyouMemberAuthCookies(authState), true)
  assert.equal(
    classifyJieyouLoginPost(
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from('<script>alert("验证码错误")</script>'),
      },
      exportJieyouAccountState(createJieyouCookieJar()),
    ),
    'captcha_invalid',
  )
  assert.equal(
    classifyJieyouLoginPost(
      {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from('<div>登录成功</div>'),
      },
      authState,
    ),
    'authenticated',
  )

  const png = await sharp({
    create: { width: 47, height: 20, channels: 3, background: '#666666' },
  })
    .png()
    .toBuffer()
  let attempts = 0
  let closed = 0
  const relogin = await reloginJieyouAutomatically({
    credentials: { schemaVersion: 1, username: 'u1', password: 'p1' },
    readers: [
      {
        provider: 'local-ocr',
        model: 'ddddocr-1.6.1-common-old',
        usageApproved: true,
        recognize: async () => 'abcd',
      },
    ],
    signal: new AbortController().signal,
    createSession: async () => ({
      challenge: async () => ({ mediaType: 'image/png', data: png }),
      submit: async () => {
        attempts++
        return attempts === 1 ? 'captcha_invalid' : 'authenticated'
      },
      probe: async () => true,
      snapshot: async () => authState,
      close: async () => {
        closed++
      },
    }),
  })
  assert.equal(attempts, 2)
  assert.equal(closed, 1)
  assert.deepEqual(relogin.storageState, authState)

  let unknownSubmits = 0
  let unknownProbes = 0
  const recovered = await reloginJieyouAutomatically({
    credentials: { schemaVersion: 1, username: 'u1', password: 'p1' },
    readers: [
      {
        provider: 'local-ocr',
        model: 'ddddocr-1.6.1-common-old',
        usageApproved: true,
        recognize: async () => 'abcd',
      },
    ],
    signal: new AbortController().signal,
    createSession: async () => ({
      challenge: async () => ({ mediaType: 'image/png', data: png }),
      submit: async () => {
        unknownSubmits++
        return 'unknown'
      },
      probe: async () => {
        unknownProbes++
        return true
      },
      snapshot: async () => authState,
      close: async () => {},
    }),
  })
  assert.equal(unknownSubmits, 1)
  assert.equal(unknownProbes, 1)
  assert.deepEqual(recovered.storageState, authState)
})

test('WanfangLiteratureHttpExecutor executes both Chinese (Wanfang) and English (Springer paid subscription) search + download', async () => {
  const store = new LiteratureArtifactStore()
  const state = buildAuthenticatedState()
  const springerHtml = `<ol>
    <li class="app-card-open" data-test="search-result-item">
      <div class="app-card-open__main">
        <div data-test="entitlements" class="app-entitlement__text">Full access</div>
        <h3 class="app-card-open__heading" data-test="title">
          <a href="${SPRINGER_WEBVPN_PREFIX}/article/10.1007/s11128-026-05359-y">
            <span>Delayed information and quantum entanglement in Cournot duopoly</span>
          </a>
        </h3>
        <div class="app-card-open__description" data-test="description"><p>Quantum duopoly summary.</p></div>
        <div class="app-card-open__authors">
          <span data-test="authors">Luca Guerrini, Stefania Ragni</span>
          in <a href="${SPRINGER_WEBVPN_PREFIX}/journal/11128" data-test="parent">Quantum Information Processing</a>
        </div>
        <div class="app-card-open__meta">
          <span class="c-meta__item" data-test="published">18 July 2026</span>
        </div>
      </div>
    </li>
  </ol>`

  const parsedSpringer = parseSpringerSearchHtml(springerHtml, 5)
  assert.equal(parsedSpringer.length, 1)
  assert.equal(parsedSpringer[0]!.id, 'sp_10.1007_s11128-026-05359-y')
  assert.equal(parsedSpringer[0]!.journal, 'Quantum Information Processing')
  assert.equal(parsedSpringer[0]!.year, 2026)

  const executor = new WanfangLiteratureHttpExecutor({
    artifactStore: store,
    tokenSecret: Buffer.alloc(32, 5),
    verifyMemberSession: async (initialState) => initialState,
    requester: async ({ url }) => {
      const pathAndQuery = `${url.pathname}${url.search}`
      if (pathAndQuery === WANFANG_WEBVPN_GRPC_PATH) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/grpc-web+proto' },
          body: buildWanfangPeriodicalFixture(
            'dlx202601001',
            '深度学习理论综述',
            '张三',
            '电工技术学报',
            2026,
          ),
        }
      }
      if (url.pathname === `${WANFANG_WEBVPN_DOWNLOAD_PREFIX}dlx202601001.aspx`) {
        return {
          statusCode: 302,
          headers: { location: '/Fulltext/Download?fileId=perio_dlx202601001&transaction=tx999' },
          body: Buffer.alloc(0),
        }
      }
      if (
        url.pathname === WANFANG_WEBVPN_FULLTEXT_PREFIX &&
        url.searchParams.get('transaction') === 'tx999'
      ) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/pdf' },
          body: VALID_PDF,
        }
      }
      if (url.pathname === `${SPRINGER_WEBVPN_PREFIX}/search`) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: Buffer.from(springerHtml, 'utf8'),
        }
      }
      if (
        url.pathname === `${SPRINGER_WEBVPN_PREFIX}/content/pdf/10.1007/s11128-026-05359-y.pdf`
      ) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/pdf' },
          body: VALID_PDF,
        }
      }
      throw new Error(`Unexpected downstream URL: ${url.toString()}`)
    },
  })

  // 1. Chinese Search + Download
  const cnSearch = await executor.executeRead({
    userId: 11,
    ownerUserId: '11',
    accountInstanceId: 'inst-11',
    storageState: state,
    actionId: 'search',
    params: { query: '深度学习', page: 1, pageSize: 5 },
    signal: new AbortController().signal,
  })
  validateRuntimePluginJson(LITERATURE_SEARCH_OUTPUT_SCHEMA, cnSearch.data, 'result')
  const cnDocId = (cnSearch.data.items as Array<{ documentId: string }>)[0]!.documentId
  const cnDl = await executor.executeRead({
    userId: 11,
    ownerUserId: '11',
    accountInstanceId: 'inst-11',
    storageState: state,
    actionId: 'download',
    params: { documentId: cnDocId },
    signal: new AbortController().signal,
  })
  cnDl.stagedArtifact?.publish()
  validateRuntimePluginJson(LITERATURE_DOWNLOAD_OUTPUT_SCHEMA, cnDl.data, 'result')
  assert(store.read(11, cnDl.data.artifactId as string))

  // 2. English Paid Subscription (Springer) Search + Download
  const enSearch = await executor.executeRead({
    userId: 11,
    ownerUserId: '11',
    accountInstanceId: 'inst-11',
    storageState: state,
    actionId: 'search',
    params: { query: 'quantum entanglement duopoly', page: 1, pageSize: 5 },
    signal: new AbortController().signal,
  })
  validateRuntimePluginJson(LITERATURE_SEARCH_OUTPUT_SCHEMA, enSearch.data, 'result')
  const enDocId = (enSearch.data.items as Array<{ documentId: string }>)[0]!.documentId
  const enDl = await executor.executeRead({
    userId: 11,
    ownerUserId: '11',
    accountInstanceId: 'inst-11',
    storageState: state,
    actionId: 'download',
    params: { documentId: enDocId },
    signal: new AbortController().signal,
  })
  enDl.stagedArtifact?.publish()
  validateRuntimePluginJson(LITERATURE_DOWNLOAD_OUTPUT_SCHEMA, enDl.data, 'result')
  assert(store.read(11, enDl.data.artifactId as string))
})

test('createPinnedDownstreamRequester aborts during DNS and enforces hop timeout', async () => {
  const ac = new AbortController()
  let resolveDns: ((ips: string[]) => void) | undefined
  const requester = createPinnedDownstreamRequester(
    async () =>
      await new Promise<string[]>((resolve) => {
        resolveDns = resolve
      }),
    80,
  )
  const pending = requester({
    url: new URL('http://webvpn.ustb.booktsg.com/search'),
    method: 'GET',
    headers: {},
    maxBytes: 1024,
    signal: ac.signal,
  })
  ac.abort()
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof LiteratureError && err.code === 'CANCELLED',
  )
  resolveDns?.(['8.8.8.8'])
})
