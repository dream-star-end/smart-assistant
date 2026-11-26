/**
 * Host root-signed A0 Approval Receipt verification & glob utilities (OCV5-904).
 *
 * Shared between `scripts/check-a0-monotonic.ts` and `scripts/harness-gate/oc-governor.sh`.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface A0ApprovalReceipt {
  schemaVersion: 1
  sha: string
  reason: string
  approvedBy?: string
  issuedAt: string
  expiresAt: string
  sha256: string
  allowedPaths?: string[]
}

export type ApprovalVerification =
  | { valid: true; receiptPath: string; receipt: A0ApprovalReceipt }
  | { valid: false; receiptPath: string; reason: string }

const SHA40_RE = /^[0-9a-f]{40}$/
const SHA64_RE = /^[0-9a-f]{64}$/

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

/**
 * Canonical SHA-256 digest for A0 approval receipts (shared with `oc-governor.sh approve-a0`).
 */
export function computeA0ReceiptDigest(fields: {
  sha: string
  issuedAt: string
  expiresAt: string
  reason: string
}): string {
  const payload = [
    'a0-approval-v1',
    `sha=${fields.sha}`,
    `issuedAt=${fields.issuedAt}`,
    `expiresAt=${fields.expiresAt}`,
    `reason=${fields.reason}`,
    '',
  ].join('\n')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function verifyA0ApprovalReceipt(opts: {
  approvalDir: string
  targetSha: string
  a0Paths: readonly string[]
  requireRootOwner: boolean
  nowMs?: number
}): ApprovalVerification {
  const receiptPath = path.join(opts.approvalDir, `${opts.targetSha}.json`)
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
  if (opts.requireRootOwner && st.uid !== 0) {
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

  const sha =
    typeof raw.sha === 'string' ? raw.sha : typeof raw.headSha === 'string' ? raw.headSha : ''
  if (sha !== opts.targetSha) {
    return {
      valid: false,
      receiptPath,
      reason: `receipt sha mismatch (expected ${opts.targetSha}, got ${sha || '<missing>'})`,
    }
  }

  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  if (reason.trim().length < 8) {
    return { valid: false, receiptPath, reason: 'receipt reason must be at least 8 characters' }
  }

  const issuedAt = typeof raw.issuedAt === 'string' ? raw.issuedAt : ''
  const expiresAt = typeof raw.expiresAt === 'string' ? raw.expiresAt : ''
  const issuedMs = Date.parse(issuedAt)
  const expiresMs = Date.parse(expiresAt)
  const nowMs = opts.nowMs ?? Date.now()

  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt issuedAt/expiresAt must be valid ISO timestamps',
    }
  }
  if (expiresMs <= issuedMs) {
    return { valid: false, receiptPath, reason: 'receipt expiresAt must be after issuedAt' }
  }
  if (expiresMs <= nowMs) {
    return { valid: false, receiptPath, reason: `receipt expired at ${expiresAt}` }
  }

  const digestField =
    typeof raw.sha256 === 'string' ? raw.sha256 : typeof raw.digest === 'string' ? raw.digest : ''
  if (!SHA64_RE.test(digestField)) {
    return { valid: false, receiptPath, reason: 'receipt missing valid 64-hex sha256 digest' }
  }

  const expectedDigest = computeA0ReceiptDigest({ sha, issuedAt, expiresAt, reason })
  const aBuf = Buffer.from(digestField, 'hex')
  const bBuf = Buffer.from(expectedDigest, 'hex')
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) {
    return {
      valid: false,
      receiptPath,
      reason: 'receipt sha256 digest verification failed (tampered)',
    }
  }

  let allowedPaths: string[] | undefined
  if (raw.allowedPaths !== undefined) {
    if (
      !Array.isArray(raw.allowedPaths) ||
      raw.allowedPaths.some((p) => typeof p !== 'string' || !p.trim())
    ) {
      return { valid: false, receiptPath, reason: 'receipt allowedPaths must be a string array' }
    }
    allowedPaths = raw.allowedPaths as string[]
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
    receipt: {
      schemaVersion: 1,
      sha,
      reason,
      approvedBy: typeof raw.approvedBy === 'string' ? raw.approvedBy : undefined,
      issuedAt,
      expiresAt,
      sha256: digestField,
      ...(allowedPaths ? { allowedPaths } : {}),
    },
  }
}
