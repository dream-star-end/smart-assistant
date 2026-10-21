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

const LITERATURE_SEARCH_OUTPUT_SCHEMA = LITERATURE_PLUGIN_CONTRACT.actions.find(
  (a) => a.id === 'search',
)!.result
const LITERATURE_DOWNLOAD_OUTPUT_SCHEMA = LITERATURE_PLUGIN_CONTRACT.actions.find(
  (a) => a.id === 'download',
)!.result
import { validateRuntimePluginJson } from '../contracts.js'
import { LiteratureError } from './errors.js'
import {
  DOCUMENT_ID_TTL_MS,
  SPRINGER_WEBVPN_PREFIX,
  WANFANG_WEBVPN_DOWNLOAD_PREFIX,
  WANFANG_WEBVPN_FULLTEXT_PREFIX,
  WANFANG_WEBVPN_GRPC_PATH,
  WanfangLiteratureHttpExecutor,
  createPinnedDownstreamRequester,
  deriveLiteratureDocumentIdSecret,
  mintScopedDocumentId,
  normalizeSpringerDoi,
  normalizeSpringerPaperId,
  parseSpringerSearchHtml,
  verifyScopedDocumentId,
} from './httpExecutor.js'
import {
  DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT,
  classifyJieyouLoginPost,
  hasJieyouMemberAuthCookies,
  reloginJieyouAutomatically,
  resolveLiteratureCaptchaBundleRoot,
} from './jieyouLoginSession.js'
import { LITERATURE_SITE } from './policy.js'

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

  const buildCustomPdf = (catalogPagesRef: string, pagesDict: string) => {
    const header = '%PDF-1.4\n'
    const obj1 = `1 0 obj\n<< /Type /Catalog /Pages ${catalogPagesRef} >>\nendobj\n`
    const obj2 = `2 0 obj\n${pagesDict}\nendobj\n`
    const obj3 = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'
    const o1 = header.length
    const o2 = o1 + obj1.length
    const o3 = o2 + obj2.length
    const xrefOffset = o3 + obj3.length
    const pad = (n: number) => String(n).padStart(10, '0')
    const xref = `xref\n0 4\n0000000000 65535 f \n${pad(o1)} 00000 n \n${pad(o2)} 00000 n \n${pad(o3)} 00000 n \n`
    const trailer = `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return Buffer.from(header + obj1 + obj2 + obj3 + xref + trailer, 'latin1')
  }
  const compactPdf = buildCustomPdf('2 0 R', '<</Type/Pages/Count 1/Kids[3 0 R]>>')
  assert.equal(validatePdfStructureSync(compactPdf), true)
  assert.equal(await validatePdfInIsolatedWorker(compactPdf, signal), true)

  const fontNameWithEndobjSubstringPdf = (() => {
    const header = '%PDF-1.4\n'
    const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
    const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
    const obj3 =
      '3 0 obj\n<< /Resources << /Font << /Fendobject 4 0 R /endobj 4 0 R >> >> /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n'
    const obj4 = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
    const o1 = header.length
    const o2 = o1 + obj1.length
    const o3 = o2 + obj2.length
    const o4 = o3 + obj3.length
    const xrefOffset = o4 + obj4.length
    const pad = (n: number) => String(n).padStart(10, '0')
    const xref = `xref\n0 5\n0000000000 65535 f \n${pad(o1)} 00000 n \n${pad(o2)} 00000 n \n${pad(o3)} 00000 n \n${pad(o4)} 00000 n \n`
    const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + xref + trailer, 'latin1')
  })()
  assert.equal(validatePdfStructureSync(fontNameWithEndobjSubstringPdf), true)
  assert.equal(await validatePdfInIsolatedWorker(fontNameWithEndobjSubstringPdf, signal), true)

  const largeImageStreamPdf = (() => {
    const header = '%PDF-1.4\n'
    const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
    const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
    const obj3 =
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n'
    const imgData = 'A'.repeat(512 * 600)
    const obj4 = `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 512 /Height 600 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imgData.length} >>\nstream\n${imgData}\nendstream\nendobj\n`
    const contentData = 'q 512 0 0 600 0 0 cm /Im0 Do Q'
    const obj5 = `5 0 obj\n<< /Length ${contentData.length} >>\nstream\n${contentData}\nendstream\nendobj\n`
    const o1 = header.length
    const o2 = o1 + obj1.length
    const o3 = o2 + obj2.length
    const o4 = o3 + obj3.length
    const o5 = o4 + obj4.length
    const xrefOffset = o5 + obj5.length
    const pad = (n: number) => String(n).padStart(10, '0')
    const xref = `xref\n0 6\n0000000000 65535 f \n${pad(o1)} 00000 n \n${pad(o2)} 00000 n \n${pad(o3)} 00000 n \n${pad(o4)} 00000 n \n${pad(o5)} 00000 n \n`
    const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + obj5 + xref + trailer, 'latin1')
  })()
  assert.equal(validatePdfStructureSync(largeImageStreamPdf), true)
  assert.equal(await validatePdfInIsolatedWorker(largeImageStreamPdf, signal), true)
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

  assert.equal(DOCUMENT_ID_TTL_MS, 24 * 60 * 60 * 1000)
  // Valid at 12 hours (within 24h TTL)
  assert.equal(
    verifyScopedDocumentId(secret, docId, {
      ownerUserId: '42',
      accountInstanceId: 'inst-42',
      nowMs: now + 12 * 60 * 60 * 1000,
    }).paperId,
    'sp_10.1007_s11128-026-05359-y',
  )
  // Wrong user rejected with DOCUMENT_EXPIRED
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '43',
        accountInstanceId: 'inst-42',
        nowMs: now + 1000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'DOCUMENT_EXPIRED',
  )
  // Wrong account instance rejected with DOCUMENT_EXPIRED
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '42',
        accountInstanceId: 'inst-other',
        nowMs: now + 1000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'DOCUMENT_EXPIRED',
  )
  // Expired after 24h rejected with DOCUMENT_EXPIRED
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, docId, {
        ownerUserId: '42',
        accountInstanceId: 'inst-42',
        nowMs: now + 24 * 60 * 60 * 1000 + 1,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'DOCUMENT_EXPIRED',
  )
  // Deterministic HKDF derivation across restarts/deployments from OPENCLAUDE_KMS_KEY
  const kmsEnv = { OPENCLAUDE_KMS_KEY: Buffer.alloc(32, 0x3c).toString('base64') }
  const derivedA = deriveLiteratureDocumentIdSecret(kmsEnv)
  const derivedB = deriveLiteratureDocumentIdSecret(kmsEnv)
  assert.equal(derivedA.length, 32)
  assert.deepEqual(derivedA, derivedB)
  const crossRestartDocId = mintScopedDocumentId(derivedA, {
    ownerUserId: '4',
    accountInstanceId: 'inst-u4',
    paperId: 'zgkx-ec202602003',
    nowMs: now,
  })
  assert.equal(
    verifyScopedDocumentId(derivedB, crossRestartDocId, {
      ownerUserId: '4',
      accountInstanceId: 'inst-u4',
      nowMs: now + 6 * 60 * 60 * 1000,
    }).paperId,
    'zgkx-ec202602003',
  )
})

test('Springer 10.1186 DOI normalization preserves 10. prefix across HTML parsing, documentId mint/verify, and download', async () => {
  assert.equal(normalizeSpringerDoi('10.1186/s40623-026-02478-9'), '10.1186/s40623-026-02478-9')
  assert.equal(normalizeSpringerDoi('1186/s40623-026-02478-9'), '10.1186/s40623-026-02478-9')
  assert.equal(normalizeSpringerDoi('10.1186%2Fs43020-023-00122-5'), '10.1186/s43020-023-00122-5')
  assert.equal(normalizeSpringerDoi('10.1007/BF02525647(01):2'), '10.1007/BF02525647(01):2')
  assert.equal(normalizeSpringerDoi('10.1007/..%2Fadmin'), null)
  assert.equal(normalizeSpringerDoi('10.1007/a/b'), null)
  assert.equal(
    normalizeSpringerPaperId('sp_1186_s40623-026-02478-9'),
    'sp_10.1186_s40623-026-02478-9',
  )
  assert.equal(
    normalizeSpringerPaperId('sp.1186_s43020-023-00122-5'),
    'sp_10.1186_s43020-023-00122-5',
  )

  const html = `<ol>
    <li class="app-card-open" data-test="search-result-item">
      <div class="app-card-open__main">
        <div data-test="entitlements" class="app-entitlement__text">Open access</div>
        <h3 class="app-card-open__heading" data-test="title">
          <a href="${SPRINGER_WEBVPN_PREFIX}/article/10.1186/s40623-026-02478-9">
            Probing atmospheric turbulence with VLBI residuals: when theory meets observations
          </a>
        </h3>
        <div class="app-card-open__authors">
          <span data-test="authors">Benedikt Soja, Rohithori</span>
        </div>
        <div class="app-card-open__meta">
          <a data-test="parent" href="/journal/40623">Earth, Planets and Space</a>
          <span data-test="published">19 February 2026</span>
        </div>
      </div>
    </li>
    <li class="app-card-open" data-test="search-result-item">
      <div class="app-card-open__main">
        <div data-test="entitlements" class="app-entitlement__text">Open access</div>
        <h3 class="app-card-open__heading" data-test="title">
          <a href="${SPRINGER_WEBVPN_PREFIX}/articles/1186%2Fs43020-023-00122-5">
            Modeling and mitigating non-isotropic tropospheric delay in GNSS
          </a>
        </h3>
        <div class="app-card-open__meta">
          <a data-test="parent" href="/journal/43020">Satellite Navigation</a>
          <span data-test="published">2023</span>
        </div>
      </div>
    </li>
  </ol>`

  const parsed = parseSpringerSearchHtml(html, 10)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]!.id, 'sp_10.1186_s40623-026-02478-9')
  assert.equal(parsed[1]!.id, 'sp_10.1186_s43020-023-00122-5')

  const secret = Buffer.alloc(32, 0x24)
  const now = 1_792_547_293_000
  const minted = mintScopedDocumentId(secret, {
    ownerUserId: '4',
    accountInstanceId: 'inst-u4',
    paperId: 'sp_10.1186_s40623-026-02478-9',
    nowMs: now,
  })
  // Simulate LLM hex transcription dropping "31302e" ("10.") from "73705f31302e313138365f"
  const corruptedMissing10 = minted.replace('-73705f31302e313138365f', '-73705f313138365f')
  assert.notEqual(corruptedMissing10, minted)
  const recovered = verifyScopedDocumentId(secret, corruptedMissing10, {
    ownerUserId: '4',
    accountInstanceId: 'inst-u4',
    nowMs: now + 60_000,
  })
  assert.equal(recovered.paperId, 'sp_10.1186_s40623-026-02478-9')

  // Forged MAC on corrupted token is still rejected
  const forged = `${corruptedMissing10.slice(0, -4)}ffff`
  assert.throws(
    () =>
      verifyScopedDocumentId(secret, forged, {
        ownerUserId: '4',
        accountInstanceId: 'inst-u4',
        nowMs: now + 60_000,
      }),
    (err: unknown) => err instanceof LiteratureError && err.code === 'DOCUMENT_EXPIRED',
  )

  // Verify end-to-end download requests /content/pdf/10.1186/s40623-026-02478-9.pdf
  const store = new LiteratureArtifactStore()
  const requestedPaths: string[] = []
  const executor = new WanfangLiteratureHttpExecutor({
    artifactStore: store,
    tokenSecret: secret,
    now: () => now + 60_000,
    verifyMemberSession: async (s) => s,
    requester: async ({ url }) => {
      requestedPaths.push(url.pathname)
      if (url.pathname === `${SPRINGER_WEBVPN_PREFIX}/content/pdf/10.1186/s40623-026-02478-9.pdf`) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/pdf' },
          body: VALID_PDF,
        }
      }
      throw new Error(`Unexpected path: ${url.pathname}`)
    },
  })
  const dl = await executor.executeRead({
    userId: 4,
    ownerUserId: '4',
    accountInstanceId: 'inst-u4',
    storageState: buildAuthenticatedState(),
    actionId: 'download',
    params: { documentId: corruptedMissing10 },
    signal: new AbortController().signal,
  })
  dl.stagedArtifact?.publish()
  assert.deepEqual(requestedPaths, [
    `${SPRINGER_WEBVPN_PREFIX}/content/pdf/10.1186/s40623-026-02478-9.pdf`,
  ])
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
      if (url.pathname === `${SPRINGER_WEBVPN_PREFIX}/content/pdf/10.1007/s11128-026-05359-y.pdf`) {
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
  let dnsCalls = 0
  const requester = createPinnedDownstreamRequester(
    {
      resolve4: async () => {
        dnsCalls++
        return await new Promise<string[]>((resolve) => {
          resolveDns = resolve
        })
      },
      resolve6: async () => [],
    },
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
  assert.equal(dnsCalls, 1)
  resolveDns?.(['8.8.8.8'])
})

test('createPinnedDownstreamRequester keeps active byte stream alive past hopTimeoutMs, enforces total ceiling, and supports loopback proxy with direct fallback', async () => {
  const http = await import('node:http')
  let mode: 'progress' | 'trickle-cap' | 'stall' = 'progress'
  let stallBeforeHeadersOnce = false
  const srv = http.createServer((_req, res) => {
    if (stallBeforeHeadersOnce) {
      stallBeforeHeadersOnce = false
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    if (mode === 'stall') return
    let sent = 1
    res.write(Buffer.from('chunk-1;'))
    const iv = setInterval(() => {
      sent++
      res.write(Buffer.from(`chunk-${sent};`))
      if (mode === 'progress' && sent >= 3) {
        clearInterval(iv)
        res.end()
      }
    }, 25)
    res.on('close', () => clearInterval(iv))
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  const seenTargets: Array<{ hostname: string; port: number; path: string }> = []
  let failProxyWith502 = false
  const localRequest: typeof http.request = ((options: any, cb: any) => {
    seenTargets.push({ hostname: options.hostname, port: options.port, path: options.path })
    if (options.port === 29999 && failProxyWith502) {
      return http.request({ ...options, hostname: '127.0.0.1', port: 1 }, cb)
    }
    return http.request({ ...options, hostname: '127.0.0.1', port, lookup: undefined }, cb)
  }) as any
  const resolver = {
    resolve4: async () => ['8.8.8.8'],
    resolve6: async () => [],
  }
  try {
    // 1. Active stream (~90ms total) exceeds hopTimeoutMs (55ms) but resets on each 30ms chunk:
    mode = 'progress'
    const progressReq = createPinnedDownstreamRequester(resolver, 150, 1000, localRequest, '')
    const okRes = await progressReq({
      url: new URL('http://webvpn.ustb.booktsg.com/stream'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
    })
    assert.equal(okRes.statusCode, 200)
    assert.equal(okRes.body.toString('utf8'), 'chunk-1;chunk-2;chunk-3;')

    // 2. Loopback proxy succeeds on first try when healthy:
    seenTargets.length = 0
    const proxyReq = createPinnedDownstreamRequester(
      resolver,
      250,
      1000,
      localRequest,
      'http://127.0.0.1:29999',
    )
    const proxyRes = await proxyReq({
      url: new URL('http://webvpn.ustb.booktsg.com/stream'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
    })
    assert.equal(proxyRes.statusCode, 200)
    assert.equal(seenTargets.length, 1)
    assert.equal(seenTargets[0]?.port, 29999)
    assert.equal(seenTargets[0]?.path, 'http://webvpn.ustb.booktsg.com/stream')

    // 3. Loopback proxy failure automatically falls back to direct pinned connection:
    seenTargets.length = 0
    failProxyWith502 = true
    const fallbackRes = await proxyReq({
      url: new URL('http://webvpn.ustb.booktsg.com/stream'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
    })
    assert.equal(fallbackRes.statusCode, 200)
    assert.equal(seenTargets.length, 2)
    assert.equal(seenTargets[0]?.port, 29999)
    assert.equal(seenTargets[1]?.port, 80)
    assert.equal(seenTargets[1]?.path, '/stream')

    // 3b. Proxy pre-header stall (35ms < hopTimeoutMs 250ms) quickly falls back to direct,
    // while active proxy streaming past 35ms (total ~55ms) stays alive under 250ms hopTimeoutMs:
    failProxyWith502 = false
    seenTargets.length = 0
    stallBeforeHeadersOnce = true
    const fastHeaderProxyReq = createPinnedDownstreamRequester(
      resolver,
      250,
      1000,
      localRequest,
      'http://127.0.0.1:29999',
      35,
    )
    const preHeaderFallbackRes = await fastHeaderProxyReq({
      url: new URL('http://webvpn.ustb.booktsg.com/stream'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
    })
    assert.equal(preHeaderFallbackRes.statusCode, 200)
    assert.equal(seenTargets.length, 2)
    assert.equal(seenTargets[0]?.port, 29999)
    assert.equal(seenTargets[1]?.port, 80)

    seenTargets.length = 0
    const postHeaderStreamRes = await fastHeaderProxyReq({
      url: new URL('http://webvpn.ustb.booktsg.com/stream'),
      method: 'GET',
      headers: {},
      maxBytes: 1024,
      signal: new AbortController().signal,
    })
    assert.equal(postHeaderStreamRes.statusCode, 200)
    assert.equal(seenTargets.length, 1)
    assert.equal(seenTargets[0]?.port, 29999)

    // 4. Infinite trickle exceeds maxTotalTimeoutMs (95ms):
    mode = 'trickle-cap'
    const capReq = createPinnedDownstreamRequester(resolver, 55, 95, localRequest, '')
    await assert.rejects(
      capReq({
        url: new URL('http://webvpn.ustb.booktsg.com/stream'),
        method: 'GET',
        headers: {},
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      }),
      (err: unknown) => err instanceof LiteratureError && err.code === 'TIMEOUT',
    )

    // 5. Stalled stream exceeds hopTimeoutMs (55ms):
    mode = 'stall'
    const stallReq = createPinnedDownstreamRequester(resolver, 55, 500, localRequest, '')
    await assert.rejects(
      stallReq({
        url: new URL('http://webvpn.ustb.booktsg.com/stream'),
        method: 'GET',
        headers: {},
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
      (err: unknown) => err instanceof LiteratureError && err.code === 'TIMEOUT',
    )
  } finally {
    srv.closeAllConnections()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
})

test('validatePdfStructureSync and LiteratureArtifactStore accept publisher PDFs with severe WebVPN offset drift (-127B / -146B) and Linearized /Prev tables while rejecting dangerous actions', async () => {
  const signal = new AbortController().signal
  const pad = (n: number) => String(n).padStart(10, '0')

  const buildPublisherPdf = (extraCatalogEntries = '', declaredDriftBytes = 0) => {
    const header = '%PDF-1.4\r\n'
    const obj1 = `1 0 obj\r<< /Type /Catalog /Pages 2 0 R ${extraCatalogEntries} >>\rendobj\r`
    const obj2 = '2 0 obj\r<< /Type /Pages /Kids [3 0 R] /Count 1 >>\rendobj\r'
    const obj3 = '3 0 obj\r<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\rendobj\r'
    const oHex = '68d1431b5b2a08c20f9e529b1957bb364b78a4726e0236e270da6c92d8f016be'
    const uHex = '0f936997ec0401773b4b91055e33abd800000000000000000000000000000000'
    const obj4 = `4 0 obj\r<</Filter /Standard/U <${uHex}>/O <${oHex}>/P 2100/V 2/Length 128 /R 3>>\rendobj\r`
    const o1 = header.length
    const o2 = o1 + obj1.length
    const o3 = o2 + obj2.length
    const o4 = o3 + obj3.length
    const actualXrefOffset = o4 + obj4.length
    const xref = `xref 0 5 \r0000000000 00000 n\r${pad(o1)} 00000 n\r${pad(o2 + declaredDriftBytes)} 00000 n\r${pad(o3 + declaredDriftBytes)} 00000 n\r${pad(o4 + declaredDriftBytes)} 00000 n\r`
    const fileIdHex = '1210121610131116111515161312E000'
    const trailer = `trailer\r<</Size 5/Root 1 0 R/ID[<${fileIdHex}><${fileIdHex}>]/Encrypt 4 0 R>>\rstartxref\r${actualXrefOffset + declaredDriftBytes}\r%%EOF\r`
    return Buffer.from(header + obj1 + obj2 + obj3 + obj4 + xref + trailer, 'latin1')
  }

  // 1. 10.1186/s12885-024-13320-4 style (-127B WebVPN URL-rewrite offset drift)
  const drifted127Pdf = buildPublisherPdf('', 127)
  assert.equal(validatePdfStructureSync(drifted127Pdf), true)
  assert.equal(await validatePdfInIsolatedWorker(drifted127Pdf, signal), true)

  const store = new LiteratureArtifactStore()
  const staged = await store.stagePdf({
    userId: 247,
    filename: 's12885-024-13320-4.pdf',
    data: drifted127Pdf,
    signal,
  })
  staged.publish()
  const delivered = store.read(247, staged.artifactId)
  assert(delivered)
  assert.deepEqual(delivered.data, drifted127Pdf)

  // 2. 10.1007/s11831-025-10367-9 style Linearized PDF with /Prev drifted by -146B and bare \r line endings
  const linearizedDrifted146Pdf = (() => {
    const head =
      '%PDF-1.4\r%\xe2\xe3\xcf\xd3\r6698 0 obj\r<</Linearized 1/L 2737147/O 6701/E 398948/N 45/T 2603065/H [ 3916 6391]>>\rendobj\r'
    const firstXref =
      'xref\r6698 3\r0000000016 00000 n\r0000010307 00000 n\r0000010617 00000 n\rtrailer\r<</Size 6879/Prev 2603052/Root 6699 0 R>>\rstartxref\r0\r%%EOF\r'
    const body =
      '6699 0 obj\r<</Type/Catalog/Pages 6690 0 R>>\rendobj\r6690 0 obj\r<</Type/Pages/Count 45/Kids[6701 0 R]>>\rendobj\r6701 0 obj\r<</Type/Page/Parent 6690 0 R>>\rendobj\r'
    const tailXref =
      'xref\r0 1\r0000000000 65535 f\rtrailer\r<</Size 6698>>\rstartxref\r116\r%%EOF\r'
    return Buffer.from(head + firstXref + body + tailXref, 'latin1')
  })()
  assert.equal(validatePdfStructureSync(linearizedDrifted146Pdf), true)
  assert.equal(await validatePdfInIsolatedWorker(linearizedDrifted146Pdf, signal), true)

  // 3. Dangerous PDF actions (/JS, /JavaScript, /Launch, including hex-escaped names) are rejected
  for (const dangerousEntry of [
    '/OpenAction << /S /JavaScript /JS (noop) >>',
    '/OpenAction << /S /Java#53cript /J#53 (noop) >>',
    '/AA << /O << /S /Launch /F (noop) >> >>',
    '/AA << /O << /S /Laun#63h /F (noop) >> >>',
  ]) {
    const dangerousPdf = buildPublisherPdf(dangerousEntry, 0)
    assert.equal(validatePdfStructureSync(dangerousPdf), false)
    assert.equal(await validatePdfInIsolatedWorker(dangerousPdf, signal), false)
  }

  // 4. Content stream containing literal text "/JS" in last 64KiB is NOT falsely rejected
  const textWithSlashJsStream = 'BT /F1 12 Tf 72 720 Td (Documentation: /JS is a PDF key.) Tj ET'
  const pdfWithSlashJsInContentStream = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${textWithSlashJsStream.length} >>\nstream\n${textWithSlashJsStream}\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n`,
    'latin1',
  )
  assert.equal(validatePdfStructureSync(pdfWithSlashJsInContentStream), true)

  // 5. Compressed /ObjStm hiding /JavaScript action is still rejected
  const zlib = await import('node:zlib')
  const objStmPayload = zlib.deflateSync(
    Buffer.from('5 0 << /S /JavaScript /JS (noop) >>', 'latin1'),
  )
  const pdfWithObjStmJs = Buffer.concat([
    Buffer.from(
      `%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>\nendobj\n4 0 obj\n<< /Type /ObjStm /Filter /FlateDecode /N 1 /First 4 /Length ${objStmPayload.length} >>\nstream\n`,
      'latin1',
    ),
    objStmPayload,
    Buffer.from(
      '\nendstream\nendobj\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n',
      'latin1',
    ),
  ])
  assert.equal(validatePdfStructureSync(pdfWithObjStmJs), false)

  // Uncompressed /ObjStm with % /Encrypt comment is also rejected when containing /JavaScript
  const uncompPayload = '5 0 << /S /JavaScript /JS (noop) >>'
  const pdfWithUncompressedObjStmJs = Buffer.from(
    `%PDF-1.5\n% /Encrypt\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction 5 0 R >>\nendobj\n4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${uncompPayload.length} >>\nstream\n${uncompPayload}\nendstream\nendobj\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n`,
    'latin1',
  )
  assert.equal(validatePdfStructureSync(pdfWithUncompressedObjStmJs), false)
})

test('resolveLiteratureCaptchaBundleRoot honors env override and falls back to default bundle root when present', () => {
  assert.equal(
    resolveLiteratureCaptchaBundleRoot(
      { OPENCLAUDE_LITERATURE_CAPTCHA_BUNDLE_ROOT: '/custom/ocr-bundle' },
      () => false,
    ),
    '/custom/ocr-bundle',
  )
  assert.equal(
    resolveLiteratureCaptchaBundleRoot(
      { OPENCLAUDE_LITERATURE_CAPTCHA_BUNDLE_ROOT: '' },
      () => true,
    ),
    undefined,
  )
  assert.equal(
    resolveLiteratureCaptchaBundleRoot(
      { OPENCLAUDE_LITERATURE_CAPTCHA_BUNDLE_ROOT: 'relative/path' },
      () => true,
    ),
    undefined,
  )
  const expectedFiles = new Set([
    `${DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT}/venv/bin/python`,
    `${DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT}/runner.py`,
  ])
  assert.equal(
    resolveLiteratureCaptchaBundleRoot({}, (file) => expectedFiles.has(file)),
    DEFAULT_LITERATURE_CAPTCHA_BUNDLE_ROOT,
  )
  assert.equal(
    resolveLiteratureCaptchaBundleRoot({}, (file) => file.endsWith('runner.py')),
    undefined,
  )
})
