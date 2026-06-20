import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * claudeCredentialsSync — keep `~/.claude/.credentials.json` as the SINGLE
 * authority source for the Claude subscription OAuth token.
 *
 * Background / root cause this fixes:
 *   OpenClaude historically kept a SECOND copy of the Claude OAuth token in the
 *   gateway config (`auth.claudeOAuth`) and ran its OWN periodic/on-401 refresh
 *   against the Anthropic token endpoint. But that refresh uses the *same* OAuth
 *   client_id (9d1c250a-…, the official Claude Code client) and the *same*
 *   account as the official `claude` CLI, which maintains its own
 *   `~/.claude/.credentials.json` and refreshes it independently.
 *
 *   Anthropic OAuth uses single-use refresh-token rotation with reuse
 *   detection. Two independent refreshers on one client_id + account =
 *   the same rotating refresh-token chain refreshed twice → the auth server
 *   flags refresh-token reuse and revokes the whole token *family*, including
 *   freshly issued access tokens. Symptom: the gateway "successfully" refreshes
 *   yet the brand-new token 401s seconds later → periodic 401 storms in WebChat,
 *   while the CC terminal (which only ever reads credentials.json) stays fine.
 *
 *   Fix: the gateway no longer refreshes Claude at all. `credentials.json` is
 *   the one authority; the official `claude` engine owns refresh (its own
 *   instances coordinate safely — that is the product's normal multi-tab mode).
 *   The gateway only WRITES credentials.json on two non-refresh occasions:
 *     - UI login callback (user explicitly logged in)  → force write
 *     - boot seed (recover credentials.json from a legacy config copy ONLY when
 *       the file is entirely missing)                   → onlyIfMissing write
 *
 * File format (official Claude Code):
 *   { "claudeAiOauth": { accessToken, refreshToken, expiresAt(ms),
 *                        scopes:[...], subscriptionType, rateLimitTier } }
 */

export interface ClaudeOAuthInput {
  accessToken: string
  refreshToken: string
  /** epoch milliseconds */
  expiresAt: number
  /** space-separated scope string (OAuth token response); converted to scopes[] */
  scope?: string
}

interface ParsedClaudeCreds {
  claudeAiOauth?: Record<string, unknown>
  [k: string]: unknown
}

export type ClaudeCredsDecision =
  | { action: 'write'; content: string; reason: string }
  | { action: 'skip'; reason: string }

function parseCreds(text: string | null): ParsedClaudeCreds | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ParsedClaudeCreds) : null
  } catch {
    return null
  }
}

/**
 * Pure decision function: given the new OAuth state and the prior file
 * contents, decide whether to write `~/.claude/.credentials.json` and what.
 *
 * - `expectedPreviousRefreshToken` set → ownership check: only write if the
 *   file's current refreshToken matches (refresh path). Unused by the current
 *   single-authority design but kept for parity with codexAuthSync and to make
 *   any future gateway-side write provably non-stomping.
 * - `onlyIfMissing` → boot-seed path: only write when the file does not exist at
 *   all. We never compare/overwrite an existing file, so we can never clobber a
 *   token the official claude engine just rotated in (a fresher-token compare
 *   would be a read-decide-rename TOCTOU). A genuinely missing file is a clean
 *   recovery: the legacy config copy is the only token we have.
 * - neither → force write (login callback path).
 *
 * Existing `claudeAiOauth` sub-fields (subscriptionType, rateLimitTier, and any
 * unknown future fields) and unknown top-level keys are PRESERVED — only the
 * token triplet (+ scopes when we have a fresh scope string) is overwritten.
 */
export function decideClaudeCredsWrite(args: {
  oauth: ClaudeOAuthInput
  previousFileText: string | null
  expectedPreviousRefreshToken?: string
  onlyIfMissing?: boolean
}): ClaudeCredsDecision {
  const prev = parseCreds(args.previousFileText)
  const prevOauth =
    prev?.claudeAiOauth && typeof prev.claudeAiOauth === 'object'
      ? (prev.claudeAiOauth as Record<string, unknown>)
      : undefined

  // Refresh-path ownership check: only overwrite a file we can prove is ours.
  if (args.expectedPreviousRefreshToken !== undefined && args.previousFileText !== null) {
    const fileRT = typeof prevOauth?.refreshToken === 'string' ? (prevOauth.refreshToken as string) : ''
    if (fileRT !== args.expectedPreviousRefreshToken) {
      return {
        action: 'skip',
        reason: fileRT
          ? 'credentials.json refreshToken differs from expected (user re-logged via claude CLI)'
          : 'credentials.json has no refreshToken (unknown format) — refusing to overwrite',
      }
    }
  }

  // Boot-seed: only write when there is no file at all — never touch an existing
  // file (avoids any read-decide-rename race against the official engine).
  if (args.onlyIfMissing && args.previousFileText !== null) {
    return { action: 'skip', reason: 'credentials.json already exists — boot-seed only writes when missing' }
  }

  // Prefer a fresh scope string; otherwise preserve the file's existing scopes.
  let scopes: string[] | undefined
  if (typeof args.oauth.scope === 'string' && args.oauth.scope.trim()) {
    scopes = args.oauth.scope.trim().split(/\s+/)
  } else if (Array.isArray(prevOauth?.scopes)) {
    scopes = (prevOauth?.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
  }

  const claudeAiOauth: Record<string, unknown> = {
    ...(prevOauth ?? {}),
    accessToken: args.oauth.accessToken,
    refreshToken: args.oauth.refreshToken,
    expiresAt: args.oauth.expiresAt,
  }
  if (scopes) claudeAiOauth.scopes = scopes

  const base: ParsedClaudeCreds = prev ? { ...prev } : {}
  base.claudeAiOauth = claudeAiOauth

  const sub = typeof claudeAiOauth.subscriptionType === 'string' ? claudeAiOauth.subscriptionType : ''
  return { action: 'write', content: JSON.stringify(base), reason: sub ? `sub=${sub}` : 'written' }
}

interface SyncLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>, err?: unknown): void
}

/**
 * IO wrapper: read existing file, decide, write atomically (tmp + rename, mode
 * 0600). Best-effort: any IO failure is logged at warn level and swallowed.
 * Never throws.
 */
export async function syncClaudeCredentialsFile(opts: {
  oauth: ClaudeOAuthInput
  filePath: string
  log: SyncLogger
  /** Set to the consumed refreshToken for a refresh-path (ownership-checked) write. */
  expectedPreviousRefreshToken?: string
  /** Boot-seed: only write when the file does not exist at all. */
  onlyIfMissing?: boolean
}): Promise<void> {
  let previousFileText: string | null = null
  try {
    previousFileText = await readFile(opts.filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      // For any non-force path, unknown state means don't risk a write.
      if (opts.expectedPreviousRefreshToken !== undefined || opts.onlyIfMissing) {
        opts.log.warn(
          'claude credentials.json read failed on guarded path; refusing to write',
          { file: opts.filePath },
          err,
        )
        return
      }
      opts.log.warn('claude credentials.json read failed (continuing)', { file: opts.filePath }, err)
    }
  }

  const decision = decideClaudeCredsWrite({
    oauth: opts.oauth,
    previousFileText,
    expectedPreviousRefreshToken: opts.expectedPreviousRefreshToken,
    onlyIfMissing: opts.onlyIfMissing,
  })

  if (decision.action === 'skip') {
    opts.log.info('claude credentials.json sync skipped', {
      file: opts.filePath,
      reason: decision.reason,
    })
    return
  }

  try {
    await mkdir(dirname(opts.filePath), { recursive: true, mode: 0o700 })
    const tmp = `${opts.filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, decision.content, { mode: 0o600 })
    await rename(tmp, opts.filePath)
    await chmod(opts.filePath, 0o600).catch(() => {})
    opts.log.info('claude credentials.json synced', { file: opts.filePath, reason: decision.reason })
  } catch (err) {
    opts.log.warn('claude credentials.json write failed', { file: opts.filePath }, err)
  }
}

export interface ClaudeCredsStatus {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scopes?: string[]
}

/**
 * Synchronous reader for status endpoints — credentials.json is the source of
 * truth for "is Claude authenticated / when does it expire". Returns null on
 * missing/unparseable file. Never throws.
 */
export function readClaudeCredentialsSync(filePath: string): ClaudeCredsStatus | null {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const oauth = parseCreds(text)?.claudeAiOauth as Record<string, unknown> | undefined
  if (!oauth) return null
  return {
    accessToken: typeof oauth.accessToken === 'string' ? oauth.accessToken : undefined,
    refreshToken: typeof oauth.refreshToken === 'string' ? oauth.refreshToken : undefined,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    scopes: Array.isArray(oauth.scopes)
      ? (oauth.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  }
}
