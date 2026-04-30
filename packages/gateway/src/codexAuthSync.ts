import { randomBytes } from 'node:crypto'
import { chmod, chown, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * codexAuthSync (v3 commercial) — keep two host-side files in sync with
 * OpenClaude's stored Codex OAuth state, for sharing the host's chatgpt
 * subscription with per-user containers.
 *
 *   master file   (NEVER mounted to any container)
 *   ──────────
 *     /var/lib/openclaude-v3/codex-master-auth/auth.json
 *     full schema (incl. refresh_token), root:root 0600
 *     Used as the single source of truth on the host. Refresh_token lives
 *     here so only the gateway main process can refresh.
 *
 *   container file (ro bind-mounted into each per-user container as
 *                   /home/agent/.codex/auth.json)
 *   ─────────────
 *     /var/lib/openclaude-v3/codex-container-auth/auth.json
 *     STRIPPED schema — no refresh_token, no id_token.
 *     chown CODEX_CONTAINER_AUTH_UID, mode 0400.
 *     Codex CLI inside the container can read access_token + auth_mode +
 *     account_id (enough to make API calls) but cannot self-refresh
 *     (no refresh_token) and cannot write back (ro mount).
 *
 * Two write paths into syncCodexAuthFiles():
 *   - Callback (boss just OAuth'd via the OpenClaude UI): force-write.
 *   - Refresh (gateway's periodic auto-refresh fired): only overwrite the
 *     master file if its refresh_token matches the one we just consumed
 *     (single-actor protection). If master is skipped, container is also
 *     skipped — staying consistent with master is more important than
 *     handing the container a stale token.
 *
 * Process startup: callers should also invoke this once on boot if
 * config.auth.codexOAuth has a valid token, to self-heal cases where the
 * host files were lost / had bad permissions / the deploy moved dirs.
 *
 * Caveat: codex MCP/app-server processes inside containers cache the token
 * in memory at startup and don't re-read the file. Supervisor/runner is
 * responsible for restarting them on token rotation.
 */

export interface CodexOAuthInput {
  accessToken: string
  refreshToken: string
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
 * Pure decision for the MASTER file: full schema with refresh_token.
 * Same logic as the personal version — refresh path enforces ownership
 * via expectedPreviousRefreshToken.
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

  if (args.expectedPreviousRefreshToken !== undefined && args.previousFileText !== null) {
    const fileRT =
      typeof prev?.tokens?.refresh_token === 'string' ? (prev.tokens.refresh_token as string) : ''
    if (fileRT !== args.expectedPreviousRefreshToken) {
      return {
        action: 'skip',
        reason: fileRT
          ? 'master auth.json refresh_token differs from expected (foreign writer)'
          : 'master auth.json has no refresh_token (unknown format) — refusing to overwrite',
      }
    }
  }

  let idToken = ''
  const prevAccountId =
    typeof prev?.tokens?.account_id === 'string' ? (prev.tokens.account_id as string) : ''
  const prevIdToken =
    typeof prev?.tokens?.id_token === 'string' ? (prev.tokens.id_token as string) : ''
  if (accountId && prevAccountId === accountId && prevIdToken) {
    idToken = prevIdToken
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

/**
 * Build the STRIPPED variant for the container file.
 *
 * Schema: same shape codex CLI expects, but `refresh_token` and `id_token`
 * are removed entirely (NOT empty-string'd) — codex inside the container
 * has no way to self-refresh and cannot leak refresh_token via filesystem
 * exfil even if the container is compromised.
 *
 * The serialized output MUST NOT contain the substring "refresh_token";
 * tests assert this directly on the returned string.
 */
export function buildContainerVariantContent(args: {
  oauth: CodexOAuthInput
  nowIso: string
}): string {
  const accountId = extractChatGptAccountId(args.oauth.accessToken) ?? ''
  // Note: keys are intentionally only access_token + account_id under
  // tokens. No id_token, no refresh_token. JSON.stringify drops undefined.
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      access_token: args.oauth.accessToken,
      account_id: accountId,
    },
    last_refresh: args.nowIso,
  })
}

interface SyncLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>, err?: unknown): void
}

export type { SyncLogger }

export type SyncOutcome =
  | { ok: true; action: 'wrote' | 'skipped'; reason: string }
  | { ok: false; action: 'failed'; reason: string }

/**
 * Atomic write for the master file. Read existing, decide, write at 0600.
 */
export async function syncCodexMasterAuthFile(opts: {
  oauth: CodexOAuthInput
  filePath: string
  log: SyncLogger
  expectedPreviousRefreshToken?: string
}): Promise<SyncOutcome> {
  let previousFileText: string | null = null
  try {
    previousFileText = await readFile(opts.filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ENOENT') {
      if (opts.expectedPreviousRefreshToken !== undefined) {
        opts.log.warn(
          'codex master auth.json read failed on refresh path; refusing to write',
          { file: opts.filePath },
          err,
        )
        return { ok: false, action: 'failed', reason: 'read failed on refresh path' }
      }
      opts.log.warn('codex master auth.json read failed (continuing)', { file: opts.filePath }, err)
    }
  }

  const decision = decideCodexAuthWrite({
    oauth: opts.oauth,
    previousFileText,
    expectedPreviousRefreshToken: opts.expectedPreviousRefreshToken,
    nowIso: new Date().toISOString(),
  })

  if (decision.action === 'skip') {
    opts.log.info('codex master auth.json sync skipped', {
      file: opts.filePath,
      reason: decision.reason,
    })
    return { ok: true, action: 'skipped', reason: decision.reason }
  }

  try {
    await mkdir(dirname(opts.filePath), { recursive: true, mode: 0o700 })
    const tmp = `${opts.filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, decision.content, { mode: 0o600 })
    await rename(tmp, opts.filePath)
    await chmod(opts.filePath, 0o600).catch(() => {})
    // Note: do not log auth.json content / token strings — this logger
    // call intentionally only carries the file path and abstract reason.
    opts.log.info('codex master auth.json synced', {
      file: opts.filePath,
      reason: decision.reason,
    })
    return { ok: true, action: 'wrote', reason: decision.reason }
  } catch (err) {
    opts.log.warn('codex master auth.json write failed', { file: opts.filePath }, err)
    return { ok: false, action: 'failed', reason: 'write failed' }
  }
}

/**
 * Atomic write for the container file. Always force-write (no ownership
 * check — the container file is never user-written). Strips refresh_token
 * and id_token. Mandatory chown to a specific uid (the container's agent
 * runtime uid) and chmod 0400.
 *
 * **Fail-closed UID 契约**: containerUid 必填(无默认)。chown 失败 → 整个
 * 写入失败(不 rename,删 tmp,返 ok:false)。这样 syncCodexAuthFiles 的
 * outcome 真实反映"容器是否能读到 auth.json",而不是 root-owned 0400 假装
 * 同步成功(容器 agent uid 物理上读不了)。
 *
 * Atomic rename via tmp file — same inode under the mount stays valid.
 * Bind-mount of the directory (not file) means the container will see the
 * new auth.json immediately after rename.
 */
export async function writeContainerVariantFile(opts: {
  oauth: CodexOAuthInput
  filePath: string
  containerUid: number
  log: SyncLogger
}): Promise<SyncOutcome> {
  const content = buildContainerVariantContent({
    oauth: opts.oauth,
    nowIso: new Date().toISOString(),
  })

  // Container dir is intentionally 0755 so the container's agent uid can
  // enter it via the bind-mount; the file mode 0400 + uid is what
  // restricts who can read auth.json.
  try {
    await mkdir(dirname(opts.filePath), { recursive: true, mode: 0o755 })
  } catch (err) {
    opts.log.warn('codex container auth.json mkdir failed', { dir: dirname(opts.filePath) }, err)
    return { ok: false, action: 'failed', reason: 'mkdir failed' }
  }

  const tmp = `${opts.filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, content, { mode: 0o400 })
  } catch (err) {
    opts.log.warn('codex container auth.json write failed', { file: opts.filePath }, err)
    return { ok: false, action: 'failed', reason: 'write failed' }
  }

  // chown is **mandatory** for fail-closed semantics. Failure here means the
  // container's agent uid cannot read the file, so the sync did not actually
  // achieve the goal of "container has working auth.json". Bail before rename
  // so the canonical path keeps the previous (working or absent) version.
  try {
    await chown(tmp, opts.containerUid, opts.containerUid)
  } catch (err) {
    opts.log.warn(
      'codex container auth.json chown failed; bailing before rename (sync NOT applied)',
      { tmp, uid: opts.containerUid },
      err,
    )
    try {
      await unlink(tmp)
    } catch { /* tmp may already be missing — best effort */ }
    return { ok: false, action: 'failed', reason: 'chown failed' }
  }

  try {
    await rename(tmp, opts.filePath)
  } catch (err) {
    opts.log.warn('codex container auth.json rename failed', { tmp, file: opts.filePath }, err)
    try {
      await unlink(tmp)
    } catch { /* */ }
    return { ok: false, action: 'failed', reason: 'rename failed' }
  }
  // chmod after rename is best-effort: writeFile already set 0o400 on tmp,
  // and rename preserves mode. If this fails the file is still 0o400, so a
  // log warn is sufficient.
  await chmod(opts.filePath, 0o400).catch(() => {})
  opts.log.info('codex container auth.json synced', { file: opts.filePath })
  return { ok: true, action: 'wrote', reason: 'container variant written' }
}

/**
 * Orchestrate both writes: master first, then container variant. If the
 * master write is skipped or fails, the container is NOT written, so the
 * two files cannot drift to inconsistent token versions.
 *
 * Returns per-file outcome so callers (admin UI, /healthz) can surface
 * "GPT not available" if the container side failed.
 */
export async function syncCodexAuthFiles(opts: {
  oauth: CodexOAuthInput
  masterDir: string
  containerDir: string
  /**
   * Required. The uid the container runs its agent as (Dockerfile USER).
   * Container variant file is chowned to this uid; if chown fails the sync
   * is reported failed (fail-closed — see writeContainerVariantFile).
   */
  containerUid: number
  log: SyncLogger
  expectedPreviousRefreshToken?: string
}): Promise<{ master: SyncOutcome; container: SyncOutcome }> {
  const masterPath = join(opts.masterDir, 'auth.json')
  const containerPath = join(opts.containerDir, 'auth.json')

  const master = await syncCodexMasterAuthFile({
    oauth: opts.oauth,
    filePath: masterPath,
    log: opts.log,
    expectedPreviousRefreshToken: opts.expectedPreviousRefreshToken,
  })

  if (master.action === 'failed') {
    opts.log.warn('codex container variant skipped because master write failed', {
      masterDir: opts.masterDir,
      containerDir: opts.containerDir,
    })
    return {
      master,
      container: { ok: false, action: 'failed', reason: 'master write failed' },
    }
  }

  if (master.action === 'skipped') {
    // Master was skipped due to ownership check — keeping the container
    // variant on the previous (consistent-with-master) version is correct.
    opts.log.info('codex container variant skipped because master sync was skipped', {
      reason: master.reason,
    })
    return {
      master,
      container: { ok: true, action: 'skipped', reason: 'master was skipped' },
    }
  }

  const container = await writeContainerVariantFile({
    oauth: opts.oauth,
    filePath: containerPath,
    containerUid: opts.containerUid,
    log: opts.log,
  })

  return { master, container }
}
