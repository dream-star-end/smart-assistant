/**
 * v3 media URL signing — HMAC-SHA256 自签名 URL,替代 `<img src>` 的 cookie 鉴权。
 *
 * **背景**:`<img src="/api/file?path=...">` 浏览器原生不带 Authorization 头,只能靠
 * HttpOnly `oc_session` cookie。但 iOS Safari 在 Cloudflare CDN + cross-hop 场景下经常
 * drop 这个 cookie(SameSite=Strict + CDN edge 转发),导致用户看到 `[?]` 破图。
 *
 * 业界标准:S3/GCS 风格的 signed URL —— URL 自带 HMAC 签名 + 过期戳 + 用户标识,
 * 无需 cookie/Bearer 即可访问。本模块提供 sign/verify primitives。
 *
 * **Key derivation**:
 *   MEDIA_SIGN_KEY = HKDF-SHA256(bridgeSecretBytes, salt=zero, info="oc-media-sign-v1", L=32)
 *
 * 复用 bridgeSecret 作为 root,通过 HKDF 派生用途隔离的子 key —— bridgeSecret 已是 host-side
 * 高熵 root secret(/var/lib/openclaude/.v3-bridge-secret 600 root:root),不引入新 key 管理。
 *
 * **Signature canonicalization**:
 *   sig_input = `${userId}\n${expMs}\n${decodedPath}`
 *   sig       = HMAC-SHA256(MEDIA_SIGN_KEY, sig_input).toString("hex")
 *
 * sign/verify 两端都对 DECODED path 做 HMAC,verify 端先 decodeURIComponent 再算 —— 这是
 * "同一字节序列"的根基,避免 canonicalization 错位(`%2F` vs `/` 等)。
 *
 * **URL form**:
 *   /api/media-signed?p=<encodeURIComponent(path)>&u=<userId>&e=<expMs>&s=<hex>
 *
 * 四个参数全 URL-encode,verify 端按 query string 拿。`u` 形如 `c:<digits>` 与
 * gateway `getUserId()` 输出一致。
 *
 * **pRaw 必须真 raw**:`VerifySignatureInput.pRaw` 期望调用方传**未解码**的 `p=` 字面值
 * (即 `?p=` 之后、`&` 之前的原始 percent-encoded 串)。`verifySignedUrl` 内部 `decodeURIComponent`
 * 一次拿到与 sign 端一致的 decoded path。如果调用方在外部 URLSearchParams.get 已经解码过一次,
 * 这里再 decode 一次 = 双解码 → 对含字面 `%`(`100%.png` 抛 URIError)
 * 与含字面 `%2F`(`a%2Fb.png` 错位为 `a/b.png`)的合法路径产生 canonicalization 错配。
 * 见 handlers.ts `extractRawQueryParam`。
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

/** info bytes for HKDF — 改值即 rotate key,旧 URL 全部失效 */
const HKDF_INFO = Buffer.from('oc-media-sign-v1')

/** 签名结果固定 sha256 hex = 64 字符 */
const SIG_LEN_HEX = 64
const SIG_HEX_RE = /^[0-9a-f]{64}$/

/**
 * Commercial JWT 用户的 userId 形:`c:<digits>` 1-19 位正整数。
 * 与 gateway `getUserId()`(server.ts:2152)输出对齐。
 */
const USER_ID_RE = /^c:[1-9]\d{0,18}$/

/** 单条 path 长度上限(防 DoS / URL 过长) */
const MAX_PATH_LEN = 4096

/** Sign endpoint 单批 paths 数量上限(对齐 frontend mediaSign.js cap) */
export const MEDIA_SIGN_BATCH_MAX = 32

/** 默认 signed URL TTL(ms) */
export const DEFAULT_SIGN_TTL_MS = 5 * 60 * 1000

/**
 * 从 bridgeSecret (64-char lowercase hex, see bridgeSecret.ts)派生 MEDIA_SIGN_KEY。
 *
 * 调用方在 registerCommercial 中算一次,把返回的 Buffer 作为 deps 喂给 handlers。
 *
 * 失败抛错(bridgeSecret 格式不对就是 fatal,registerCommercial 启动期暴露)。
 */
export function deriveMediaSignKey(bridgeSecret: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(bridgeSecret)) {
    throw new Error('deriveMediaSignKey: bridgeSecret must be 64-char lowercase hex')
  }
  const ikm = Buffer.from(bridgeSecret, 'hex')
  // hkdfSync(digest, ikm, salt, info, length) → ArrayBuffer
  const ab = hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32)
  return Buffer.from(ab)
}

/**
 * 计算签名 hex。
 *
 * - `userId`:形如 `c:<digits>`(commercial user)
 * - `expMs`:绝对毫秒过期戳
 * - `decodedPath`:**已经 URL-decode 的** path 字符串
 *
 * 调用方不应传入 URL-encoded 的 path —— sign/verify 必须对相同字节序列做 HMAC。
 */
export function computeSignature(
  key: Buffer,
  userId: string,
  expMs: number,
  decodedPath: string,
): string {
  const sigInput = `${userId}\n${expMs}\n${decodedPath}`
  return createHmac('sha256', key).update(sigInput).digest('hex')
}

/**
 * 验证 URL query 中的签名。constant-time compare。
 *
 * 不做 path 谓词校验(那是 handler 层的职责);只做"密码学正确性"检查。
 *
 * 返回:
 *   - `ok` → 签名/时效/形式全通过
 *   - `bad-request` → 参数缺失 / 格式不对 / decode 失败
 *   - `forbidden`   → HMAC 不匹配
 *   - `gone`        → expMs ≤ now
 *
 * 让调用方按枚举对照映射 HTTP status code(400 / 403 / 410),实现 endpoint 不重复字面量。
 */
export type VerifyResult =
  | { kind: 'ok'; userId: string; expMs: number; decodedPath: string }
  | { kind: 'bad-request'; reason: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'gone'; reason: string }

export interface VerifySignatureInput {
  /** Raw URL-encoded p query param */
  pRaw: string | null
  /** userId, e.g. "c:42" — 已经从 query 拿过来,但还没校验 */
  u: string | null
  /** expMs 字符串形式(query string 都是 string) */
  e: string | null
  /** 签名 hex */
  s: string | null
  /** 用于过期判定的 now,可注入便于测试 */
  nowMs?: number
}

export function verifySignedUrl(key: Buffer, input: VerifySignatureInput): VerifyResult {
  const { pRaw, u, e, s } = input
  if (!pRaw || !u || !e || !s) {
    return { kind: 'bad-request', reason: 'missing-param' }
  }
  if (pRaw.length > MAX_PATH_LEN) {
    return { kind: 'bad-request', reason: 'path-too-long' }
  }
  if (!USER_ID_RE.test(u)) {
    return { kind: 'bad-request', reason: 'bad-user-id' }
  }
  if (!/^[0-9]+$/.test(e)) {
    return { kind: 'bad-request', reason: 'bad-exp' }
  }
  const expMs = Number.parseInt(e, 10)
  if (!Number.isSafeInteger(expMs)) {
    return { kind: 'bad-request', reason: 'bad-exp' }
  }
  if (s.length !== SIG_LEN_HEX || !SIG_HEX_RE.test(s)) {
    return { kind: 'bad-request', reason: 'bad-sig' }
  }
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pRaw)
  } catch {
    return { kind: 'bad-request', reason: 'bad-encoding' }
  }
  if (decodedPath.length === 0 || decodedPath.length > MAX_PATH_LEN) {
    return { kind: 'bad-request', reason: 'path-too-long' }
  }
  // HMAC compare (constant time)
  const expected = createHmac('sha256', key).update(`${u}\n${expMs}\n${decodedPath}`).digest()
  const got = Buffer.from(s, 'hex')
  // 长度先校验,timingSafeEqual 要求等长
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { kind: 'forbidden', reason: 'bad-sig' }
  }
  const now = input.nowMs ?? Date.now()
  if (expMs <= now) {
    return { kind: 'gone', reason: 'expired' }
  }
  return { kind: 'ok', userId: u, expMs, decodedPath }
}

/**
 * 用 path + userId + ttlMs 构造一个 signed URL(URL-encoded p 形式,直接可作为 `<img src>`)。
 *
 * 调用方负责确保:
 *   - path 已经过 user-scoped predicate(本函数只做密码学层,不做路径授权)
 *   - userId 是 `c:<digits>` 形式
 */
export function buildSignedUrl(
  key: Buffer,
  decodedPath: string,
  userId: string,
  ttlMs: number = DEFAULT_SIGN_TTL_MS,
): { url: string; expMs: number } {
  const expMs = Date.now() + ttlMs
  const sig = computeSignature(key, userId, expMs, decodedPath)
  const p = encodeURIComponent(decodedPath)
  const u = encodeURIComponent(userId)
  const url = `/api/media-signed?p=${p}&u=${u}&e=${expMs}&s=${sig}`
  return { url, expMs }
}

/**
 * 校验 input paths array 的 shape —— 给 /api/media-sign handler 用。
 *
 * 返回 normalized + deduped 数组,或失败原因(handler 直接 400)。
 * 不做 user-scoped 谓词(那是 handler 在拿到 resolver 后做)。
 */
export interface NormalizePathsResult {
  ok: true
  paths: string[]
}
export interface NormalizePathsError {
  ok: false
  reason: 'not-array' | 'empty' | 'too-many' | 'bad-path'
  message: string
}

export function normalizeSignBatchInput(raw: unknown): NormalizePathsResult | NormalizePathsError {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'not-array', message: 'paths must be an array' }
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'empty', message: 'paths must be non-empty' }
  }
  if (raw.length > MEDIA_SIGN_BATCH_MAX) {
    return {
      ok: false,
      reason: 'too-many',
      message: `paths length must be ≤ ${MEDIA_SIGN_BATCH_MAX}`,
    }
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string') {
      return { ok: false, reason: 'bad-path', message: 'each path must be a string' }
    }
    if (p.length === 0 || p.length > MAX_PATH_LEN) {
      return {
        ok: false,
        reason: 'bad-path',
        message: `path length must be 1..${MAX_PATH_LEN}`,
      }
    }
    // POSIX 绝对路径 (/...) 或 Windows 绝对路径 (C:\...)
    const isAbsolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
    if (!isAbsolute) {
      return { ok: false, reason: 'bad-path', message: 'paths must be absolute' }
    }
    if (p.includes('..')) {
      return { ok: false, reason: 'bad-path', message: 'paths must not contain ..; ' }
    }
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return { ok: true, paths: out }
}
