import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * codexAuthSync — keep `~/.codex/auth.json` in sync with OpenClaude's
 * stored Codex OAuth state.
 *
 * Background: OpenClaude's frontend OAuth flow saves Codex tokens into the
 * gateway config (`auth.codexOAuth`), but the codex CLI / codex MCP server
 * processes only read `~/.codex/auth.json`. Without this sync, switching
 * Codex accounts in the OpenClaude UI silently has no effect — codex CLI
 * keeps using whatever token was last written by `codex login`.
 *
 * Two write paths:
 *  - Callback (user just logged in via OpenClaude UI): force write.
 *  - Refresh (gateway's periodic auto-refresh fired): only overwrite if the
 *    file's current `refresh_token` matches the one we just consumed,
 *    otherwise the user has run `codex login` directly and we'd be stomping
 *    their explicit choice.
 *
 * Caveat: codex MCP server processes cache the token in memory at startup
 * and don't re-read the file. After updating, callers should suggest the
 * user run `pkill -f "codex.*mcp-server"` to pick up the new token.
 */

export interface CodexOAuthInput {
  accessToken: string
  refreshToken: string
  /**
   * OIDC `id_token` from the token endpoint response. Only present on the
   * authorization_code (callback) path — refresh_token grants do not return
   * a fresh id_token per OIDC Core §12. Falsy values fall back to the
   * prev-file preserve logic (same account_id keeps prev id_token).
   */
  idToken?: string
}

interface ParsedTokens {
  id_token?: unknown
  access_token?: unknown
  refresh_token?: unknown
  account_id?: unknown
}

interface ParsedAuthFile {
  OPENAI_API_KEY?: unknown
  auth_mode?: unknown
  tokens?: ParsedTokens
  last_refresh?: unknown
}

export type CodexAuthDecision =
  | { action: 'write'; content: string; reason: string }
  | { action: 'skip'; reason: string }

/**
 * Extract `chatgpt_account_id` from a ChatGPT-issued JWT access_token.
 * The token's payload (second segment) carries an
 * `https://api.openai.com/auth.chatgpt_account_id` claim.
 *
 * Returns null on any parse failure — callers should still write the file
 * with an empty account_id since `auth_mode: chatgpt` + valid access_token
 * is the load-bearing part for codex CLI.
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.')
    if (parts.length < 2) return null
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    const authClaim = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const aid = authClaim?.chatgpt_account_id
    return typeof aid === 'string' && aid.length > 0 ? aid : null
  } catch {
    return null
  }
}

/**
 * Pure decision function: given the new OAuth state and the prior
 * file contents, decide whether to write and what to write.
 *
 * - `expectedPreviousRefreshToken` undefined → force-write (callback path)
 * - `expectedPreviousRefreshToken` set → only write if existing file's
 *   refresh_token matches (refresh path, ownership check)
 *
 * `id_token` resolution order:
 *   1. `args.oauth.idToken` if non-empty (fresh from authorization_code grant)
 *   2. previous file's `id_token` if previous file's account_id matches new
 *      token's account_id (same identity, refresh_token grant didn't return
 *      a new id_token)
 *   3. empty string (cross-account, no previous, or fresh ChatGPT auth with
 *      token endpoint omitting id_token)
 *
 * codex 0.125 chatgpt mode requires a non-empty id_token to attach the
 * Authorization header for /v1/responses calls; an empty id_token causes
 * 401 "Missing bearer or basic authentication" at the OpenAI edge.
 */
export function decideCodexAuthWrite(args: {
  oauth: CodexOAuthInput
  previousFileText: string | null
  expectedPreviousRefreshToken?: string
  nowIso: string
}): CodexAuthDecision {
  const accountId = extractChatGptAccountId(args.oauth.accessToken) ?? ''

  let prev: ParsedAuthFile | null = null
  if (args.previousFileText) {
    try {
      prev = JSON.parse(args.previousFileText) as ParsedAuthFile
    } catch {
      prev = null
    }
  }

  // Refresh path: skip if the file no longer belongs to us.
  //
  // Conservative policy: only overwrite when we can prove the file was last
  // written by us (refresh_token matches the one we just consumed). If the
  // file exists in any other shape — different refresh_token, no
  // refresh_token at all (API-key mode, future formats, partial writes) —
  // we leave it alone.
  //
  // Genuinely missing file (previousFileText === null) is the one exception:
  // that's a clean slate and the callback path's previous write got lost,
  // so re-writing is a recovery rather than a stomp.
  if (args.expectedPreviousRefreshToken !== undefined && args.previousFileText !== null) {
    const fileRT =
      typeof prev?.tokens?.refresh_token === 'string' ? (prev.tokens.refresh_token as string) : ''
    if (fileRT !== args.expectedPreviousRefreshToken) {
      return {
        action: 'skip',
        reason: fileRT
          ? 'auth.json refresh_token differs from expected (likely user ran `codex login` directly)'
          : 'auth.json has no refresh_token (likely API-key mode or unknown format) — refusing to overwrite',
      }
    }
  }

  // id_token resolution: input takes precedence, else preserve prev on same
  // identity, else empty.
  let idToken = ''
  if (typeof args.oauth.idToken === 'string' && args.oauth.idToken.length > 0) {
    idToken = args.oauth.idToken
  } else {
    const prevAccountId =
      typeof prev?.tokens?.account_id === 'string' ? (prev.tokens.account_id as string) : ''
    const prevIdToken =
      typeof prev?.tokens?.id_token === 'string' ? (prev.tokens.id_token as string) : ''
    if (accountId && prevAccountId === accountId && prevIdToken) {
      idToken = prevIdToken
    }
  }

  const content = JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: args.oauth.accessToken,
      refresh_token: args.oauth.refreshToken,
      account_id: accountId,
    },
    last_refresh: args.nowIso,
  })

  return {
    action: 'write',
    content,
    reason: accountId ? `account=${accountId}` : 'account_id unparseable',
  }
}

interface SyncLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>, err?: unknown): void
}

/**
 * IO wrapper: read existing file, decide, write atomically.
 * Best-effort: any IO failure is logged at warn level and swallowed.
 * Never throws.
 */
export async function syncCodexAuthFile(opts: {
  oauth: CodexOAuthInput
  filePath: string
  log: SyncLogger
  /** Omit for callback path (force). Set to the consumed refresh_token for refresh path. */
  expectedPreviousRefreshToken?: string
}): Promise<void> {
  let previousFileText: string | null = null
  try {
    previousFileText = await readFile(opts.filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      // Refresh path: state is unknown, don't risk overwriting whatever's
      // there. Callback path: user just explicitly logged in, force-write
      // is acceptable even if we couldn't read prior state.
      if (opts.expectedPreviousRefreshToken !== undefined) {
        opts.log.warn(
          'codex auth.json read failed on refresh path; refusing to write',
          { file: opts.filePath },
          err,
        )
        return
      }
      opts.log.warn('codex auth.json read failed (continuing)', { file: opts.filePath }, err)
    }
  }

  const decision = decideCodexAuthWrite({
    oauth: opts.oauth,
    previousFileText,
    expectedPreviousRefreshToken: opts.expectedPreviousRefreshToken,
    nowIso: new Date().toISOString(),
  })

  if (decision.action === 'skip') {
    opts.log.info('codex auth.json sync skipped', { file: opts.filePath, reason: decision.reason })
    return
  }

  try {
    await mkdir(dirname(opts.filePath), { recursive: true, mode: 0o700 })
    const tmp = `${opts.filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, decision.content, { mode: 0o600 })
    await rename(tmp, opts.filePath)
    // rename preserves source mode on POSIX, but be explicit in case the
    // target file already existed with a different mode and the platform
    // semantics aren't what we expect.
    await chmod(opts.filePath, 0o600).catch(() => {})
    opts.log.info('codex auth.json synced', {
      file: opts.filePath,
      reason: decision.reason,
      restartHint: 'pkill -f "codex.*mcp-server" for running MCP servers to pick up the new token',
    })
  } catch (err) {
    opts.log.warn('codex auth.json write failed', { file: opts.filePath }, err)
  }
}
