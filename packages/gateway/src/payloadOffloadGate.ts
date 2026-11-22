/**
 * Unified Large Payload Offload Gate (OCV5-840).
 *
 * Prevents oversized attachments, web extractions, delegate returns, and
 * swarm board payloads from flooding in-session context. Oversized payloads
 * are written atomically to `<workspaceDir>/.openclaude-artifacts/` (0600)
 * and replaced with a compact head+tail preview + file path handle for
 * on-demand `Read`/`Grep`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { cleanupContextReferences } from './engine/contextReference.js'
import { contextPayloadOffloadsTotal } from './metrics.js'

export const SESSION_ARTIFACTS_DIR_NAME = '.openclaude-artifacts'

/** Deterministic, collision-safe directory scope for a full server sessionKey (B4). */
export function sessionArtifactScopeId(sessionKey: string): string {
  return `s-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`
}

export interface OffloadPayloadOptions {
  workspaceDir: string
  /** Full server-side sessionKey (preferred for B4 strict per-session ownership). */
  sessionKey?: string
  sessionId?: string
  category: string
  content: string
  inlineMaxChars: number
  headChars?: number
  tailChars?: number
  label?: string
}

export interface OffloadPayloadResult {
  offloaded: boolean
  text: string
  artifactPath?: string
  originalChars: number
  originalBytes: number
  inlineChars: number
}

function sanitizeSlug(raw: string, fallback: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 32) || fallback
}

/** UTF-16 surrogate-safe head slice (never splits a surrogate pair). */
export function safeSliceHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff && end > 1) end -= 1
  return text.slice(0, end)
}

/** UTF-16 surrogate-safe tail slice (never splits a surrogate pair). */
export function safeSliceTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let start = text.length - maxChars
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff && start + 1 < text.length) start += 1
  return text.slice(start)
}

/** UTF-8 byte-budget truncation that never splits a multi-byte character. */
export function truncateUtf8Safe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 }
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1
  // Verify we didn't leave an incomplete multi-byte leader at buf[end-1]
  if (end > 0) {
    let lead = end - 1
    while (lead > 0 && (buf[lead]! & 0xc0) === 0x80) lead -= 1
    const first = buf[lead]!
    const seqLen =
      (first & 0x80) === 0 ? 1 :
      (first & 0xe0) === 0xc0 ? 2 :
      (first & 0xf0) === 0xe0 ? 3 :
      (first & 0xf8) === 0xf0 ? 4 : 1
    if (lead + seqLen > end) end = lead
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

export function offloadPayloadIfOversized(opts: OffloadPayloadOptions): OffloadPayloadResult {
  const content = opts.content ?? ''
  const originalChars = content.length
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const inlineMax = Math.max(256, Math.floor(opts.inlineMaxChars))

  if (originalChars <= inlineMax) {
    return {
      offloaded: false,
      text: content,
      originalChars,
      originalBytes,
      inlineChars: originalChars,
    }
  }

  const category = sanitizeSlug(opts.category, 'payload')
  const defaultHead = Math.max(128, Math.floor(inlineMax * 0.65))
  const defaultTail = Math.max(64, Math.floor(inlineMax * 0.2))
  const headChars = Math.min(opts.headChars ?? defaultHead, inlineMax)
  const tailChars = Math.min(opts.tailChars ?? defaultTail, Math.max(0, inlineMax - headChars))

  let artifactPath: string | undefined
  if (opts.workspaceDir) {
    try {
      mkdirSync(opts.workspaceDir, { recursive: true, mode: 0o700 })
      const wsStat = lstatSync(opts.workspaceDir)
      if (wsStat.isSymbolicLink() || !wsStat.isDirectory()) {
        throw new Error('ARTIFACT_WORKSPACE_UNSAFE')
      }
      const realWs = realpathSync(opts.workspaceDir)
      const rootDir = join(opts.workspaceDir, SESSION_ARTIFACTS_DIR_NAME)
      mkdirSync(rootDir, { recursive: true, mode: 0o700 })
      const rootStat = lstatSync(rootDir)
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error('ARTIFACT_ROOT_UNSAFE')
      }
      const realRoot = realpathSync(rootDir)
      if (realRoot !== realWs && !realRoot.startsWith(`${realWs}${sep}`)) {
        throw new Error('ARTIFACT_ROOT_ESCAPE')
      }
      const targetDir = opts.sessionKey
        ? join(rootDir, sessionArtifactScopeId(opts.sessionKey))
        : rootDir
      if (targetDir !== rootDir) {
        mkdirSync(targetDir, { recursive: true, mode: 0o700 })
        const scopeStat = lstatSync(targetDir)
        if (scopeStat.isSymbolicLink() || !scopeStat.isDirectory()) {
          throw new Error('ARTIFACT_SCOPE_UNSAFE')
        }
        const realScope = realpathSync(targetDir)
        if (!realScope.startsWith(`${realRoot}${sep}`)) {
          throw new Error('ARTIFACT_SCOPE_ESCAPE')
        }
      }
      const sessTag = opts.sessionId ? `-${sanitizeSlug(opts.sessionId, 's').slice(0, 12)}` : ''
      const rand = randomBytes(4).toString('hex')
      const filename = `${category}${sessTag}-${Date.now()}-${rand}.txt`
      const finalPath = join(targetDir, filename)
      const tmpPath = `${finalPath}.${process.pid}.tmp`
      writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
      const realTmp = realpathSync(tmpPath)
      if (!realTmp.startsWith(`${realRoot}${sep}`)) {
        rmSync(tmpPath, { force: true })
        throw new Error('ARTIFACT_TMP_ESCAPE')
      }
      renameSync(tmpPath, finalPath)
      artifactPath = finalPath
    } catch {
      // Fail-open: still return bounded preview even if artifact write fails.
      artifactPath = undefined
    }
  }

  contextPayloadOffloadsTotal.inc({ category })

  const head = safeSliceHead(content, headChars)
  const tail = tailChars > 0 ? safeSliceTail(content, tailChars) : ''
  const omittedChars = Math.max(0, originalChars - head.length - tail.length)
  const labelPrefix = opts.label ? `[${opts.label}] ` : ''
  const locationLine = artifactPath
    ? `Full content offloaded to: \`${artifactPath}\` (${originalChars} chars, ${originalBytes} bytes). Use Read/Grep in bounded chunks if needed.`
    : `Content truncated (${originalChars} chars, ${originalBytes} bytes; artifact spill unavailable).`

  const sections = [head, `\n\n… (${labelPrefix}${omittedChars} chars omitted; ${locationLine}) …`]
  if (tail) sections.push(`\n\n${tail}`)
  const text = sections.join('')

  return {
    offloaded: true,
    text,
    artifactPath,
    originalChars,
    originalBytes,
    inlineChars: text.length,
  }
}

/**
 * Remove session-owned offloaded artifacts and context reference directories (B4).
 * When `sessionKey` is provided, ONLY removes `<workspaceDir>/.openclaude-artifacts/s-<hash>`
 * and `.openclaude-context-s-<hash>-*`, preserving sibling agents sharing the same peer/workspace.
 */
export async function cleanupSessionArtifacts(
  workspaceDir: string | undefined,
  sessionKey?: string,
): Promise<{ removedDirs: number }> {
  if (!workspaceDir) return { removedDirs: 0 }
  let removedDirs = 0
  try {
    const artifactsRoot = join(workspaceDir, SESSION_ARTIFACTS_DIR_NAME)
    const target = sessionKey
      ? join(artifactsRoot, sessionArtifactScopeId(sessionKey))
      : artifactsRoot
    const st = await lstat(target).catch(() => null)
    if (st && st.isDirectory() && !st.isSymbolicLink()) {
      await rm(target, { recursive: true, force: true })
      removedDirs += 1
    }
  } catch {
    // fail-open
  }
  removedDirs += await cleanupContextReferences(workspaceDir, sessionKey)
  return { removedDirs }
}
