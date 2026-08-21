/**
 * Short-lived admin device-auth sessions for official Grok subscriptions.
 * The official CLI owns the OAuth exchange. We copy its resulting credential
 * into the normal encrypted account form, then delete the temporary HOME.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const GROK_AUTH_SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'
const GROK_OAUTH_ISSUER = 'https://auth.x.ai'
const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SESSION_TTL_MS = 15 * 60_000
const START_TIMEOUT_MS = 20_000
const MAX_OUTPUT_CHARS = 64 * 1024
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
const DEVICE_URL_RE = /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9]{4}-[A-Z0-9]{4})/

export interface GrokDeviceCredential {
  access_token: string
  refresh_token: string
  expires_at: string
  principal_type?: string
  principal_id?: string
}

export type GrokDeviceAuthStatus =
  | { status: 'pending'; session_id: string; verification_url: string; user_code: string }
  | ({ status: 'complete'; session_id: string } & GrokDeviceCredential)
  | { status: 'failed'; session_id: string; error: string }

interface DeviceSession {
  id: string
  dir: string
  child: ChildProcessWithoutNullStreams
  createdAt: number
  verificationUrl: string | null
  userCode: string | null
  output: string
  state: 'pending' | 'complete' | 'failed' | 'cancelled'
  credential: GrokDeviceCredential | null
  error: string | null
  resolveReady: (() => void) | null
  rejectReady: ((err: Error) => void) | null
  ttl: NodeJS.Timeout
}

const sessions = new Map<string, DeviceSession>()

function cliPath(): string {
  const configured = process.env.OC_GROK_CLI_BIN?.trim()
  if (configured) return configured
  if (existsSync('/root/.grok/bin/grok')) return '/root/.grok/bin/grok'
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  return path.join(repoRoot, 'node_modules', '.bin', 'grok')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseExpiry(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000
    return new Date(ms).toISOString()
  }
  if (typeof raw === 'string' && raw.trim()) {
    const date = new Date(raw)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return null
}

export function buildGrokDeviceAuthEnv(
  home: string,
  grokHome: string,
  proxyUrl?: string | null,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const proxy = typeof proxyUrl === 'string' ? proxyUrl.trim() : ''
  return {
    // This is an authentication-only third-party child. Do not inherit
    // database/KMS/container credentials from the commercial master.
    PATH: base.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: base.LANG ?? 'C.UTF-8',
    TERM: base.TERM ?? 'xterm-256color',
    HOME: home,
    GROK_HOME: grokHome,
    GROK_CLI_AUTO_UPDATE: 'false',
    GROK_TELEMETRY_ENABLED: 'false',
    ...(proxy
      ? {
          HTTPS_PROXY: proxy,
          HTTP_PROXY: proxy,
          https_proxy: proxy,
          http_proxy: proxy,
          NO_PROXY: '127.0.0.1,localhost',
        }
      : {}),
  }
}

/** Strictly parse the one official xAI OAuth scope from auth.json. */
export function parseGrokAuthJson(raw: string): GrokDeviceCredential {
  const document = JSON.parse(raw) as Record<string, unknown>
  const scoped = document[GROK_AUTH_SCOPE]
  if (!scoped || typeof scoped !== 'object' || Array.isArray(scoped)) {
    throw new Error('GROK_DEVICE_AUTH_SCOPE_MISSING')
  }
  const entry = scoped as Record<string, unknown>
  if (entry.auth_mode !== 'oidc') {
    throw new Error('GROK_DEVICE_AUTH_MODE_INVALID')
  }
  if (
    entry.oidc_issuer !== GROK_OAUTH_ISSUER ||
    entry.oidc_client_id !== GROK_OAUTH_CLIENT_ID
  ) {
    throw new Error('GROK_DEVICE_AUTH_OIDC_INVALID')
  }
  const access = entry.key
  const refresh = entry.refresh_token
  const expiresAt = parseExpiry(entry.expires_at)
  if (typeof access !== 'string' || access.length === 0) throw new Error('GROK_DEVICE_ACCESS_TOKEN_MISSING')
  if (typeof refresh !== 'string' || refresh.length === 0) throw new Error('GROK_DEVICE_REFRESH_TOKEN_MISSING')
  if (!expiresAt) throw new Error('GROK_DEVICE_EXPIRY_MISSING')
  const principalType = entry.principal_type
  const principalId = entry.principal_id
  if (
    (principalType !== undefined || principalId !== undefined) &&
    (
      typeof principalType !== 'string' || principalType.length === 0 ||
      typeof principalId !== 'string' || principalId.length === 0
    )
  ) {
    throw new Error('GROK_DEVICE_AUTH_PRINCIPAL_INVALID')
  }
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    ...(typeof principalType === 'string' && typeof principalId === 'string'
      ? { principal_type: principalType, principal_id: principalId }
      : {}),
  }
}

function stopChild(session: DeviceSession): void {
  if (session.child.exitCode !== null || session.child.signalCode !== null) return
  try { process.kill(-session.child.pid!, 'SIGTERM') } catch { session.child.kill('SIGTERM') }
}

function destroySession(session: DeviceSession, stop: boolean): void {
  sessions.delete(session.id)
  clearTimeout(session.ttl)
  if (stop) stopChild(session)
  void rm(session.dir, { recursive: true, force: true })
}

function observeOutput(session: DeviceSession, chunk: string): void {
  session.output = `${session.output}${chunk}`.slice(-MAX_OUTPUT_CHARS)
  const clean = session.output.replace(ANSI_RE, '')
  const match = DEVICE_URL_RE.exec(clean)
  if (!match || session.verificationUrl) return
  session.userCode = match[1]!
  session.verificationUrl = match[0]
  session.resolveReady?.()
  session.resolveReady = null
  session.rejectReady = null
}

async function finishSession(session: DeviceSession, code: number | null): Promise<void> {
  if (session.state !== 'pending') return
  try {
    if (code !== 0) throw new Error('GROK_DEVICE_AUTH_PROCESS_FAILED')
    const raw = await readFile(path.join(session.dir, '.grok', 'auth.json'), 'utf8')
    session.credential = parseGrokAuthJson(raw)
    session.state = 'complete'
  } catch (err) {
    session.state = 'failed'
    session.error = err instanceof Error ? err.message : 'GROK_DEVICE_AUTH_FAILED'
  }
  if (!session.verificationUrl) {
    session.rejectReady?.(new Error(session.error ?? 'GROK_DEVICE_AUTH_ENDED_BEFORE_CODE'))
    session.resolveReady = null
    session.rejectReady = null
  }
}

export async function startGrokDeviceAuth(opts: { proxyUrl?: string } = {}): Promise<GrokDeviceAuthStatus> {
  const dir = await mkdtemp(path.join(tmpdir(), 'openclaude-grok-auth-'))
  const grokHome = path.join(dir, '.grok')
  await mkdir(grokHome, { mode: 0o700 })
  await writeFile(
    path.join(grokHome, 'config.toml'),
    '[cli]\nauto_update = false\n\n[features]\ntelemetry = false\nfeedback = false\n',
    { mode: 0o600 },
  ).catch(async () => {
    await rm(dir, { recursive: true, force: true })
    throw new Error('GROK_DEVICE_AUTH_CONFIG_FAILED')
  })
  const bin = cliPath()
  const child = spawn(
    'script',
    ['-qefc', `${shellQuote(bin)} login --device-auth`, '/dev/null'],
    {
      env: buildGrokDeviceAuthEnv(dir, grokHome, opts.proxyUrl),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  )
  const id = randomBytes(16).toString('hex')
  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const session: DeviceSession = {
    id,
    dir,
    child,
    createdAt: Date.now(),
    verificationUrl: null,
    userCode: null,
    output: '',
    state: 'pending',
    credential: null,
    error: null,
    resolveReady,
    rejectReady,
    ttl: setTimeout(() => {
      session.state = 'failed'
      session.error = 'GROK_DEVICE_AUTH_EXPIRED'
      session.rejectReady?.(new Error(session.error))
      destroySession(session, true)
    }, SESSION_TTL_MS),
  }
  session.ttl.unref()
  sessions.set(id, session)
  child.stdin.end()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => observeOutput(session, chunk))
  child.stderr.on('data', (chunk: string) => observeOutput(session, chunk))
  child.once('error', (err) => {
    session.state = 'failed'
    session.error = err.message
    session.rejectReady?.(err)
  })
  child.once('close', (code) => { void finishSession(session, code) })

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('GROK_DEVICE_AUTH_CODE_TIMEOUT')), START_TIMEOUT_MS)
    timer.unref()
  })
  try {
    await Promise.race([ready, timeout])
  } catch (err) {
    destroySession(session, true)
    throw err
  }
  return {
    status: 'pending',
    session_id: id,
    verification_url: session.verificationUrl!,
    user_code: session.userCode!,
  }
}

export function getGrokDeviceAuthStatus(id: string): GrokDeviceAuthStatus | null {
  const session = sessions.get(id)
  if (!session) return null
  if (session.state === 'complete' && session.credential) {
    const out: GrokDeviceAuthStatus = { status: 'complete', session_id: id, ...session.credential }
    destroySession(session, false)
    return out
  }
  if (session.state === 'failed') {
    const out: GrokDeviceAuthStatus = { status: 'failed', session_id: id, error: session.error ?? 'GROK_DEVICE_AUTH_FAILED' }
    destroySession(session, false)
    return out
  }
  if (session.state === 'cancelled') return null
  return {
    status: 'pending',
    session_id: id,
    verification_url: session.verificationUrl!,
    user_code: session.userCode!,
  }
}

export function cancelGrokDeviceAuth(id: string): boolean {
  const session = sessions.get(id)
  if (!session) return false
  session.state = 'cancelled'
  destroySession(session, true)
  return true
}
