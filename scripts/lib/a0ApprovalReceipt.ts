/**
 * Host root-signed & Out-of-Commit GitHub A0 Approval Receipt Verification (OCV5-904 / OCV5-903 B2 & B3).
 *
 * Byte-for-byte canonical equivalence with `scripts/harness-gate/oc-governor.sh` (`approve-a0` / `verify-a0`):
 *   - `reason` is trimmed BEFORE checking `length >= 8` and BEFORE computing the canonical payload;
 *     newlines (`\r`/`\n`) are rejected to prevent canonical line injection.
 *   - `allowedPaths` (when provided: non-empty array of trimmed non-empty newline-free strings,
 *     deduplicated & sorted) is bound into the `a0-approval-v1` canonical payload as
 *     `allowedPaths=<JSON array>` (or `allowedPaths=*` when omitted).
 *   - Supports optional root-only `0600` HMAC key file `${ROOT}/control/.hmac-key`:
 *     when present, `hmacSha256` is mandatory and plain `sha256`-only downgrade is rejected.
 *   - Production ALWAYS enforces `uid === 0` (even when `--approval-dir` / `OC_A0_APPROVAL_DIR` is
 *     overridden); skipping owner checks requires explicit test-only `requireRootOwner: false`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type FetchLike,
  verifyGithubA0Approval,
} from './githubTrustedApproval.js'

export interface A0ApprovalReceipt {
  schemaVersion: 1
  sha: string
  reason: string
  approvedBy?: string
  issuedAt: string
  expiresAt: string
  sha256: string
  hmacSha256?: string
  allowedPaths?: string[]
  source?: 'host-file' | 'github-status' | 'github-pr-review'
}

export type ApprovalVerification =
  | {
      valid: true
      receiptPath: string
      source: 'host-file' | 'github-status' | 'github-pr-review'
      receipt: A0ApprovalReceipt
    }
  | { valid: false; receiptPath: string; reason: string }

export const SHA40_RE = /^[0-9a-f]{40}$/
export const SHA64_RE = /^[0-9a-f]{64}$/
export const STRICT_ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.+/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if ('+?^${}()|[]\\.'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(filePath))
}

/** Normalize and sort allowedPaths by UTF-8 byte order for canonical payload binding (undefined -> '*'). */
export function canonicalizeA0AllowedPaths(allowedPaths?: readonly string[]): string {
  if (allowedPaths === undefined) return '*'
  const normalized = [...new Set(allowedPaths.map((p) => p.trim()))].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  )
  return JSON.stringify(normalized)
}

/**
 * Exact byte-for-byte canonical payload shared with `oc-governor.sh approve-a0` / `verify-a0`:
 *   a0-approval-v1
 *   sha=<40hex>
 *   issuedAt=<ISO-8601>
 *   expiresAt=<ISO-8601>
 *   reason=<trimmed reason>
 *   allowedPaths=<* | JSON.stringify(sorted unique trimmed paths)>
 */
export function buildA0CanonicalPayload(fields: {
  sha: string
  issuedAt: string
  expiresAt: string
  reason: string
  allowedPaths?: readonly string[]
}): string {
  return [
    'a0-approval-v1',
    `sha=${fields.sha}`,
    `issuedAt=${fields.issuedAt}`,
    `expiresAt=${fields.expiresAt}`,
    `reason=${fields.reason.trim()}`,
    `allowedPaths=${canonicalizeA0AllowedPaths(fields.allowedPaths)}`,
    '',
  ].join('\n')
}

/** Canonical SHA-256 digest for A0 approval receipts (shared with `oc-governor.sh`). */
export function computeA0ReceiptDigest(fields: {
  sha: string
  issuedAt: string
  expiresAt: string
  reason: string
  allowedPaths?: readonly string[]
}): string {
  return createHash('sha256').update(buildA0CanonicalPayload(fields), 'utf8').digest('hex')
}

/** Canonical HMAC-SHA256 tag for A0 approval receipts when `${ROOT}/control/.hmac-key` is active. */
export function computeA0ReceiptHmac(
  fields: {
    sha: string
    issuedAt: string
    expiresAt: string
    reason: string
    allowedPaths?: readonly string[]
  },
  hmacKey: string,
): string {
  return createHmac('sha256', hmacKey).update(buildA0CanonicalPayload(fields), 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (!SHA64_RE.test(a) || !SHA64_RE.test(b)) return false
  const aBuf = Buffer.from(a, 'hex')
  const bBuf = Buffer.from(b, 'hex')
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
}

export type HmacKeyLoadResult =
  | { present: false }
  | { present: true; ok: true; key: string }
  | { present: true; ok: false; reason: string }

/**
 * Load optional root-only `0600` HMAC key file (`${ROOT}/control/.hmac-key`).
 * Rejects symlinks, group/world-accessible modes (`mode & 0o077 !== 0`), non-root owners
 * when `requireRootOwner` is true, or empty keys.
 */
export function readValidatedHmacKeyFile(
  keyFilePath: string,
  requireRootOwner: boolean,
): HmacKeyLoadResult {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(keyFilePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { present: false }
    return {
      present: true,
      ok: false,
      reason: `unable to stat HMAC key file ${keyFilePath}: ${(err as Error).message}`,
    }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {
      present: true,
      ok: false,
      reason: `HMAC key file must be a regular file (no symlinks): ${keyFilePath}`,
    }
  }
  if ((st.mode & 0o077) !== 0) {
    return {
      present: true,
      ok: false,
      reason: `HMAC key file must be mode 0600/0400 (no group/world permissions): ${keyFilePath}`,
    }
  }
  if (requireRootOwner && st.uid !== 0) {
    return {
      present: true,
      ok: false,
      reason: `HMAC key file must be owned by root (uid=0, got uid=${st.uid}): ${keyFilePath}`,
    }
  }
  let raw: string
  try {
    raw = readFileSync(keyFilePath, 'utf8').trim()
  } catch (err) {
    return {
      present: true,
      ok: false,
      reason: `failed to read HMAC key file ${keyFilePath}: ${(err as Error).message}`,
    }
  }
  if (!raw) {
    return { present: true, ok: false, reason: `HMAC key file is empty: ${keyFilePath}` }
  }
  return { present: true, ok: true, key: raw }
}

function parseStrictIsoMs(s: unknown): number {
  if (typeof s !== 'string' || !STRICT_ISO_TIMESTAMP_RE.test(s)) return Number.NaN
  return Date.parse(s)
}

export function verifyA0ApprovalFile(opts: {
  receiptPath: string
  targetSha: string
  a0Paths: readonly string[]
  requireRootOwner?: boolean
  hmacKeyFile?: string
  hmacKey?: string
  nowMs?: number
}): ApprovalVerification {
  const receiptPath = opts.receiptPath
  const requireRootOwner = opts.requireRootOwner ?? true
  if (!SHA40_RE.test(opts.targetSha)) {
    return { valid: false, receiptPath, reason: `invalid target sha "${opts.targetSha}"` }
  }

  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(receiptPath)
  } catch {
    return { valid: false, receiptPath, reason: 'approval receipt not found' }
  }

  if (st.isSymbolicLink() || !st.isFile()) {
    return {
      valid: false,
      receiptPath,
      reason: 'approval receipt must be a regular file (no symlinks)',
    }
  }
  if ((st.mode & 0o022) !== 0) {
    return {
      valid: false,
      receiptPath,
      reason: 'approval receipt must not be group/world writable',
    }
  }
  if (requireRootOwner && st.uid !== 0) {
    return {
      valid: false,
      receiptPath,
      reason: `approval receipt must be owned by root (uid=0, got uid=${st.uid})`,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(receiptPath, 'utf8'))
  } catch (err) {
    return {
      valid: false,
      receiptPath,
      reason: `approval receipt JSON parse error: ${(err as Error).message}`,
    }
  }

  if (!isPlainObject(raw)) {
    return { valid: false, receiptPath, reason: 'approval receipt must be a JSON object' }
  }
  if (raw.schemaVersion !== 1) {
    return {
      valid: false,
      receiptPath,
      reason: `unsupported receipt schemaVersion=${String(raw.schemaVersion)}`,
    }
  }

  const sha = typeof raw.sha === 'string' ? raw.sha : ''
  if (sha !== opts.targetSha) {
    return {
      valid: false,
      receiptPath,
      reason: `receipt sha mismatch (expected ${opts.targetSha}, got ${sha || '<missing>'})`,
    }
  }

  if (typeof raw.reason !== 'string' || /[\r\n]/.test(raw.reason)) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt reason must be a single-line string',
    }
  }
  const trimmedReason = raw.reason.trim()
  if (trimmedReason.length < 8) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt reason must be at least 8 characters after trimming',
    }
  }

  const issuedAt = typeof raw.issuedAt === 'string' ? raw.issuedAt : ''
  const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : ''
  const issuedMs = parseStrictIsoMs(issuedAt)
  const expiresMs = parseStrictIsoMs(expiresAt)
  const nowMs = opts.nowMs ?? Date.now()

  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt issuedAt/expiresAt must be valid ISO-8601 timestamps',
    }
  }
  if (expiresMs <= issuedMs) {
    return { valid: false, receiptPath, reason: 'receipt expiresAt must be after issuedAt' }
  }
  if (expiresMs <= nowMs) {
    return { valid: false, receiptPath, reason: `receipt expired at ${expiresAt}` }
  }

  let allowedPaths: string[] | undefined
  if (raw.allowedPaths !== undefined) {
    if (
      !Array.isArray(raw.allowedPaths) ||
      raw.allowedPaths.length === 0 ||
      raw.allowedPaths.some((p) => typeof p !== 'string' || /[\r\n]/.test(p) || !p.trim())
    ) {
      return {
        valid: false,
        receiptPath,
        reason: 'receipt allowedPaths must be a non-empty array of non-empty single-line strings',
      }
    }
    allowedPaths = [...new Set((raw.allowedPaths as string[]).map((p) => p.trim()))].sort()
  }

  const digestField = typeof raw.sha256 === 'string' ? raw.sha256 : ''
  if (!SHA64_RE.test(digestField)) {
    return { valid: false, receiptPath, reason: 'receipt missing valid 64-hex sha256 digest' }
  }

  const fields = { sha, issuedAt, expiresAt, reason: trimmedReason, allowedPaths }
  const expectedDigest = computeA0ReceiptDigest(fields)
  if (!safeEqualHex(digestField, expectedDigest)) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt sha256 digest verification failed (tampered)',
    }
  }

  // Optional HMAC enforcement when `.hmac-key` exists (rejects plain sha256 downgrade!)
  let activeHmacKey = opts.hmacKey?.trim() || undefined
  if (!activeHmacKey && opts.hmacKeyFile) {
    const keyRes = readValidatedHmacKeyFile(opts.hmacKeyFile, requireRootOwner)
    if (keyRes.present) {
      if (!keyRes.ok) {
        return { valid: false, receiptPath, reason: keyRes.reason }
      }
      activeHmacKey = keyRes.key
    }
  }

  const hmacField = raw.hmacSha256
  if (activeHmacKey) {
    if (typeof hmacField !== 'string' || !SHA64_RE.test(hmacField)) {
      return {
        valid: false,
        receiptPath,
        reason: 'HMAC key is active; receipt missing valid hmacSha256 (plain sha256 downgrade rejected)',
      }
    }
    const expectedHmac = computeA0ReceiptHmac(fields, activeHmacKey)
    if (!safeEqualHex(hmacField, expectedHmac)) {
      return {
        valid: false,
        receiptPath,
        reason: 'receipt hmacSha256 verification failed (tampered or wrong HMAC key)',
      }
    }
  } else if (hmacField !== undefined) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt carries hmacSha256 but verifier has no active .hmac-key configured',
    }
  }

  if (allowedPaths) {
    const uncovered = opts.a0Paths.filter((p) => !matchesAnyGlob(p, allowedPaths!))
    if (uncovered.length > 0) {
      return {
        valid: false,
        receiptPath,
        reason: `receipt allowedPaths does not cover A0 changes: ${uncovered.join(', ')}`,
      }
    }
  }

  return {
    valid: true,
    receiptPath,
    source: 'host-file',
    receipt: {
      schemaVersion: 1,
      sha,
      reason: trimmedReason,
      approvedBy: typeof raw.approvedBy === 'string' ? raw.approvedBy : undefined,
      issuedAt,
      expiresAt,
      sha256: digestField,
      ...(typeof hmacField === 'string' ? { hmacSha256: hmacField } : {}),
      ...(allowedPaths ? { allowedPaths } : {}),
      source: 'host-file',
    },
  }
}

export function verifyA0ApprovalReceipt(opts: {
  approvalDir: string
  targetSha: string
  a0Paths: readonly string[]
  requireRootOwner?: boolean
  hmacKeyFile?: string
  hmacKey?: string
  nowMs?: number
}): ApprovalVerification {
  const resolvedDir = path.resolve(opts.approvalDir)
  const receiptPath = path.join(resolvedDir, `${opts.targetSha}.json`)
  const defaultHmacKeyFile = path.join(path.dirname(resolvedDir), '.hmac-key')
  return verifyA0ApprovalFile({
    receiptPath,
    targetSha: opts.targetSha,
    a0Paths: opts.a0Paths,
    requireRootOwner: opts.requireRootOwner ?? true,
    hmacKeyFile: opts.hmacKeyFile ?? (opts.hmacKey ? undefined : defaultHmacKeyFile),
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
  })
}

/**
 * Unified out-of-commit A0 approval verification (host root-only receipt OR GitHub trusted approval).
 */
export async function verifyA0ApprovalUnified(opts: {
  approvalDir: string
  targetSha: string
  a0Paths: readonly string[]
  requireRootOwner?: boolean
  hmacKeyFile?: string
  hmacKey?: string
  nowMs?: number
  github?: {
    repo?: string
    token?: string
    prNumber?: number
    trustedApprovers?: readonly string[]
    apiBaseUrl?: string
    fetchImpl?: FetchLike
  }
}): Promise<ApprovalVerification> {
  const hostRes = verifyA0ApprovalReceipt({
    approvalDir: opts.approvalDir,
    targetSha: opts.targetSha,
    a0Paths: opts.a0Paths,
    requireRootOwner: opts.requireRootOwner ?? true,
    hmacKeyFile: opts.hmacKeyFile,
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
  })
  if (hostRes.valid) return hostRes

  const ghRepo = opts.github?.repo?.trim()
  const ghToken = opts.github?.token?.trim()
  if (ghRepo && ghToken) {
    const ghRes = await verifyGithubA0Approval({
      repo: ghRepo,
      token: ghToken,
      headSha: opts.targetSha,
      a0Paths: opts.a0Paths,
      prNumber: opts.github?.prNumber,
      trustedApprovers: opts.github?.trustedApprovers,
      apiBaseUrl: opts.github?.apiBaseUrl,
      nowMs: opts.nowMs,
      fetchImpl: opts.github?.fetchImpl,
    })
    if (ghRes.valid && ghRes.channel) {
      const issuedAt = ghRes.issuedAt ?? new Date(opts.nowMs ?? Date.now()).toISOString()
      const expiresAt =
        ghRes.expiresAt ?? new Date((opts.nowMs ?? Date.now()) + 24 * 3600_000).toISOString()
      return {
        valid: true,
        receiptPath: ghRes.source,
        source: ghRes.channel,
        receipt: {
          schemaVersion: 1,
          sha: opts.targetSha,
          reason: ghRes.reason,
          approvedBy: ghRes.approvedBy,
          issuedAt,
          expiresAt,
          sha256: computeA0ReceiptDigest({
            sha: opts.targetSha,
            issuedAt,
            expiresAt,
            reason: ghRes.reason,
          }),
          source: ghRes.channel,
        },
      }
    }
    return {
      valid: false,
      receiptPath: `${hostRes.receiptPath} | ${ghRes.source}`,
      reason: `host: ${hostRes.reason}; github: ${ghRes.reason}`,
    }
  }

  return hostRes
}
