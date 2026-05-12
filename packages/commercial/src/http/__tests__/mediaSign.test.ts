import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'
import {
  MEDIA_SIGN_BATCH_MAX,
  buildSignedUrl,
  computeSignature,
  deriveMediaSignKey,
  normalizeSignBatchInput,
  verifySignedUrl,
} from '../mediaSign.js'
import { extractRawQueryParam } from '../handlers.js'

const VALID_BRIDGE_SECRET = randomBytes(32).toString('hex') // 64-char lowercase hex
const ALT_BRIDGE_SECRET = randomBytes(32).toString('hex')

function parseSignedQuery(url: string): { p: string; u: string; e: string; s: string } {
  const idx = url.indexOf('?')
  assert.ok(idx >= 0, 'URL must have query')
  const usp = new URLSearchParams(url.slice(idx + 1))
  return {
    p: usp.get('p') ?? '',
    u: usp.get('u') ?? '',
    e: usp.get('e') ?? '',
    s: usp.get('s') ?? '',
  }
}

describe('deriveMediaSignKey', () => {
  test('returns 32-byte Buffer from 64-char hex secret', () => {
    const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    assert.ok(Buffer.isBuffer(key))
    assert.equal(key.length, 32)
  })

  test('same input → same key (deterministic HKDF)', () => {
    const k1 = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    const k2 = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    assert.equal(k1.toString('hex'), k2.toString('hex'))
  })

  test('different secrets → different keys', () => {
    const k1 = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    const k2 = deriveMediaSignKey(ALT_BRIDGE_SECRET)
    assert.notEqual(k1.toString('hex'), k2.toString('hex'))
  })

  test('rejects non-64-char hex', () => {
    assert.throws(() => deriveMediaSignKey('abc'))
    assert.throws(() => deriveMediaSignKey('z'.repeat(64))) // not hex
    assert.throws(() => deriveMediaSignKey('F'.repeat(64))) // uppercase rejected
  })
})

describe('buildSignedUrl + verifySignedUrl roundtrip', () => {
  const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)

  test('plain path roundtrip → ok', () => {
    const { url, expMs } = buildSignedUrl(key, '/root/.openclaude/uploads/x.png', 'c:42')
    const q = parseSignedQuery(url)
    // URLSearchParams auto-decodes values; check that the raw URL string contains
    // the percent-encoded form, and the decoded value matches.
    assert.ok(url.includes('u=c%3A42'), 'URL must percent-encode `:` in userId')
    assert.equal(q.u, 'c:42')
    assert.equal(q.e, String(expMs))
    const r = verifySignedUrl(key, { pRaw: q.p, u: q.u, e: q.e, s: q.s })
    assert.equal(r.kind, 'ok')
    if (r.kind === 'ok') {
      assert.equal(r.userId, 'c:42')
      assert.equal(r.expMs, expMs)
      assert.equal(r.decodedPath, '/root/.openclaude/uploads/x.png')
    }
  })

  test('path with special chars (spaces, unicode, &) → roundtrip ok', () => {
    const path = '/root/.openclaude/generated/中文 & 空格 ?#.png'
    const { url } = buildSignedUrl(key, path, 'c:7')
    // Raw URL must percent-encode `&` to `%26`, else the query would split into
    // multiple params. We check the raw URL string before URLSearchParams parsing.
    const queryStr = url.slice(url.indexOf('?') + 1)
    assert.ok(queryStr.includes('%26'), 'raw URL must percent-encode `&` in path')
    const q = parseSignedQuery(url)
    const r = verifySignedUrl(key, { pRaw: q.p, u: q.u, e: q.e, s: q.s })
    assert.equal(r.kind, 'ok')
    if (r.kind === 'ok') assert.equal(r.decodedPath, path)
  })

  test('tampered path → forbidden', () => {
    const { expMs } = buildSignedUrl(key, '/a/b/c.png', 'c:1')
    const sigFor_ab = computeSignature(key, 'c:1', expMs, '/a/b/c.png')
    // Reuse signature but for different path
    const r = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a/b/d.png'),
      u: 'c:1',
      e: String(expMs),
      s: sigFor_ab,
    })
    assert.equal(r.kind, 'forbidden')
  })

  test('tampered userId → forbidden', () => {
    const expMs = Date.now() + 60_000
    const sig = computeSignature(key, 'c:1', expMs, '/a/b.png')
    const r = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a/b.png'),
      u: 'c:2', // mismatched
      e: String(expMs),
      s: sig,
    })
    assert.equal(r.kind, 'forbidden')
  })

  test('tampered expMs → forbidden', () => {
    const expMs = Date.now() + 60_000
    const sig = computeSignature(key, 'c:1', expMs, '/a/b.png')
    const r = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a/b.png'),
      u: 'c:1',
      e: String(expMs + 1),
      s: sig,
    })
    assert.equal(r.kind, 'forbidden')
  })

  test('wrong key → forbidden', () => {
    const otherKey = deriveMediaSignKey(ALT_BRIDGE_SECRET)
    const { url, expMs } = buildSignedUrl(key, '/a.png', 'c:1')
    const q = parseSignedQuery(url)
    const r = verifySignedUrl(otherKey, {
      pRaw: q.p,
      u: 'c:1',
      e: String(expMs),
      s: q.s,
    })
    assert.equal(r.kind, 'forbidden')
  })

  test('expired → gone', () => {
    const past = Date.now() - 10_000
    const sig = computeSignature(key, 'c:1', past, '/a.png')
    const r = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a.png'),
      u: 'c:1',
      e: String(past),
      s: sig,
    })
    assert.equal(r.kind, 'gone')
  })

  test('nowMs injection — explicit clock skew test', () => {
    const expMs = 1_000_000
    const sig = computeSignature(key, 'c:1', expMs, '/a.png')
    const before = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a.png'),
      u: 'c:1',
      e: String(expMs),
      s: sig,
      nowMs: 999_999,
    })
    assert.equal(before.kind, 'ok')
    const after = verifySignedUrl(key, {
      pRaw: encodeURIComponent('/a.png'),
      u: 'c:1',
      e: String(expMs),
      s: sig,
      nowMs: 1_000_000, // expMs <= now → gone
    })
    assert.equal(after.kind, 'gone')
  })
})

describe('verifySignedUrl input validation (bad-request)', () => {
  const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)
  const expMs = Date.now() + 60_000
  const okSig = computeSignature(key, 'c:1', expMs, '/a.png')

  test('missing params → bad-request', () => {
    assert.equal(
      verifySignedUrl(key, { pRaw: null, u: 'c:1', e: String(expMs), s: okSig }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, { pRaw: 'x', u: null, e: String(expMs), s: okSig }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, { pRaw: 'x', u: 'c:1', e: null, s: okSig }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, { pRaw: 'x', u: 'c:1', e: String(expMs), s: null }).kind,
      'bad-request',
    )
  })

  test('malformed userId → bad-request', () => {
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'u:42', // wrong prefix
        e: String(expMs),
        s: okSig,
      }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'c:', // empty number
        e: String(expMs),
        s: okSig,
      }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'c:01', // leading zero rejected
        e: String(expMs),
        s: okSig,
      }).kind,
      'bad-request',
    )
  })

  test('malformed expMs / sig → bad-request', () => {
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'c:1',
        e: 'abc',
        s: okSig,
      }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'c:1',
        e: String(expMs),
        s: 'shortsig',
      }).kind,
      'bad-request',
    )
    assert.equal(
      verifySignedUrl(key, {
        pRaw: encodeURIComponent('/a.png'),
        u: 'c:1',
        e: String(expMs),
        s: 'Z'.repeat(64), // non-hex char
      }).kind,
      'bad-request',
    )
  })

  test('bad URI encoding → bad-request', () => {
    const r = verifySignedUrl(key, {
      pRaw: '%E0%A4%A', // invalid UTF-8 escape
      u: 'c:1',
      e: String(expMs),
      s: okSig,
    })
    assert.equal(r.kind, 'bad-request')
  })
})

describe('normalizeSignBatchInput', () => {
  test('dedupes + preserves order', () => {
    const r = normalizeSignBatchInput(['/a.png', '/b.png', '/a.png'])
    assert.equal(r.ok, true)
    if (r.ok) assert.deepEqual(r.paths, ['/a.png', '/b.png'])
  })

  test('rejects non-array', () => {
    assert.equal(normalizeSignBatchInput('a').ok, false)
    assert.equal(normalizeSignBatchInput(null).ok, false)
    assert.equal(normalizeSignBatchInput(undefined).ok, false)
    assert.equal(normalizeSignBatchInput({}).ok, false)
  })

  test('rejects empty', () => {
    const r = normalizeSignBatchInput([])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'empty')
  })

  test('rejects >32 paths', () => {
    const big = Array.from({ length: MEDIA_SIGN_BATCH_MAX + 1 }, (_, i) => `/p${i}.png`)
    const r = normalizeSignBatchInput(big)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'too-many')
  })

  test('rejects non-string element', () => {
    const r = normalizeSignBatchInput(['/a.png', 42])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'bad-path')
  })

  test('rejects relative path', () => {
    const r = normalizeSignBatchInput(['foo/bar.png'])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'bad-path')
  })

  test('rejects path with ..', () => {
    const r = normalizeSignBatchInput(['/root/../etc/passwd'])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'bad-path')
  })

  test('rejects empty string path', () => {
    const r = normalizeSignBatchInput([''])
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'bad-path')
  })

  test('accepts Windows absolute paths', () => {
    const r = normalizeSignBatchInput(['C:\\Users\\test.png', 'D:/x.jpg'])
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.paths.length, 2)
  })

  test('accepts exactly batch-max paths', () => {
    const exact = Array.from({ length: MEDIA_SIGN_BATCH_MAX }, (_, i) => `/p${i}.png`)
    const r = normalizeSignBatchInput(exact)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.paths.length, MEDIA_SIGN_BATCH_MAX)
  })
})

describe('URL canonicalization (decoded path is signing input)', () => {
  const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)
  test('`%2F` vs `/` — verify sees decoded path', () => {
    // Path with literal "/" → URL-encoded "%2F". The signing INPUT is the decoded path,
    // so HMAC is over `/a/b.png`, not `/a%2Fb.png`. Verify must also decode first.
    const decodedPath = '/a/b.png'
    const expMs = Date.now() + 60_000
    const sig = computeSignature(key, 'c:1', expMs, decodedPath)
    // Send pRaw as fully encoded — verify should still ok
    const r = verifySignedUrl(key, {
      pRaw: encodeURIComponent(decodedPath),
      u: 'c:1',
      e: String(expMs),
      s: sig,
    })
    assert.equal(r.kind, 'ok')
  })
})

// Codex review round 1 catch:
//   handler glue 用 URLSearchParams.get('p') 拿 `p` 等于先解码一次,verifySignedUrl
//   再 decodeURIComponent 一次 → 双解码 → 含字面 `%`/`%2F` 的合法路径全部签名错位 / 抛错。
//   修法 = 用 `extractRawQueryParam(req.url, 'p')` 抽**未解码**的 p 字面值,
//   verifySignedUrl 只 decode 一次。下面 4 个测试同时覆盖辅助函数 + 端到端 canonicalization。
describe('extractRawQueryParam (no double-decode)', () => {
  test('extracts raw percent-encoded p as-is', () => {
    // Path `/uploads/a%2Fb.png`(文件名字面含 `%2F`)→ buildSignedUrl 后 URL 形如:
    //   ?p=%2Fuploads%2Fa%252Fb.png&u=...
    // URLSearchParams.get('p') 会返回 `/uploads/a%2Fb.png` (已 once-decoded)。
    // extractRawQueryParam 应当返回 `%2Fuploads%2Fa%252Fb.png` (raw)。
    const requestUrl = '/api/media-signed?p=%2Fuploads%2Fa%252Fb.png&u=c%3A1&e=123&s=abc'
    assert.equal(extractRawQueryParam(requestUrl, 'p'), '%2Fuploads%2Fa%252Fb.png')
    assert.equal(extractRawQueryParam(requestUrl, 'u'), 'c%3A1')
    assert.equal(extractRawQueryParam(requestUrl, 'e'), '123')
    assert.equal(extractRawQueryParam(requestUrl, 's'), 'abc')
  })

  test('returns null for missing param', () => {
    assert.equal(extractRawQueryParam('/api/media-signed?u=c%3A1', 'p'), null)
    assert.equal(extractRawQueryParam('/api/media-signed', 'p'), null)
    assert.equal(extractRawQueryParam('/api/media-signed?', 'p'), null)
  })

  test('returns null for empty value (`?p=` / bare `?p`)', () => {
    // Contract hygiene:non-null 必须意味"拿到非空字符串",简化 caller 的 truthy 判定。
    assert.equal(extractRawQueryParam('/api/media-signed?p=', 'p'), null)
    assert.equal(extractRawQueryParam('/api/media-signed?p', 'p'), null)
    assert.equal(extractRawQueryParam('/api/media-signed?u=c&p=&s=x', 'p'), null)
  })

  test('returns null on duplicate `p=` (sig smuggling defense)', () => {
    // 攻击者送 `?p=valid&p=evil` 试图让 URLSearchParams.get 返回 first/last 之一
    // 时绕过签名 —— 我们拒绝整条请求。
    assert.equal(extractRawQueryParam('/api/media-signed?p=a&p=b', 'p'), null)
    assert.equal(extractRawQueryParam('/api/media-signed?p=a&u=c&p=b', 'p'), null)
  })

  test('handles fragment correctly (server side typically not present)', () => {
    // 浏览器不会把 fragment 发到 server,但稳妥起见 fragment 不参与 query。
    assert.equal(extractRawQueryParam('/api/media-signed?p=raw#frag', 'p'), 'raw')
  })

  test('end-to-end: path with literal `%` survives handler glue', () => {
    // **bug reproduction**:文件名字面含 `%` 的合法路径(`/uploads/100%.png`)。
    // 旧 handler 用 URLSearchParams.get('p') → 返回 once-decoded `/uploads/100%.png`,
    // verifySignedUrl 内 decodeURIComponent 一次再 decode → `100%.png` 中 `%.p` 抛 URIError → bad-request。
    // 修后:extractRawQueryParam 返回 raw `%2Fuploads%2F100%25.png`,verify decode 一次得到
    // 原始 `/uploads/100%.png`,签名匹配。
    const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    const decodedPath = '/uploads/100%.png'
    const { url } = buildSignedUrl(key, decodedPath, 'c:1')
    const pRaw = extractRawQueryParam(url, 'p')
    const u = extractRawQueryParam(url, 'u')
    const e = extractRawQueryParam(url, 'e')
    const s = extractRawQueryParam(url, 's')
    assert.ok(pRaw, 'pRaw must be present')
    // u/e/s 是 ASCII 安全;extractRawQueryParam 返回的也是 raw —— 需要 decode 才得到 sig 期望形态
    const r = verifySignedUrl(key, {
      pRaw,
      u: u ? decodeURIComponent(u) : null,
      e,
      s,
    })
    assert.equal(r.kind, 'ok')
    if (r.kind === 'ok') assert.equal(r.decodedPath, decodedPath)
  })

  test('end-to-end: path with literal `%2F` does not collapse to `/`', () => {
    // 文件名字面含 `%2F`(虽然奇怪但合法)→ sign 端 HMAC 输入 = `/a%2Fb.png`。
    // 旧 handler 双解码后 verify 拿到 `/a/b.png` → 签名错位 → forbidden。
    // 修后 raw 抽取 → verify 单次 decode 拿到原 `/a%2Fb.png`,签名匹配。
    const key = deriveMediaSignKey(VALID_BRIDGE_SECRET)
    const decodedPath = '/a%2Fb.png'
    const { url } = buildSignedUrl(key, decodedPath, 'c:1')
    const pRaw = extractRawQueryParam(url, 'p')
    const u = extractRawQueryParam(url, 'u')
    const e = extractRawQueryParam(url, 'e')
    const s = extractRawQueryParam(url, 's')
    assert.ok(pRaw, 'pRaw must be present')
    const r = verifySignedUrl(key, {
      pRaw,
      u: u ? decodeURIComponent(u) : null,
      e,
      s,
    })
    assert.equal(r.kind, 'ok')
    if (r.kind === 'ok') assert.equal(r.decodedPath, decodedPath)
  })
})
