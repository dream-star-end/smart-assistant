/** Native compaction export and process close barriers shared by the app-server runner. */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createReadStream, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { NativeModelHandoffArtifact } from './engineAdapter.js'
const CODEX_ROLLOUT_MAX_BYTES = 256 * 1024 * 1024

export async function readLatestCodexNativeHandoff(
  rolloutPath: string,
  compactStartedAt: number,
): Promise<NativeModelHandoffArtifact> {
  if (!isAbsolute(rolloutPath)) throw new Error('CODEX_COMPACTION_PATH_INVALID')
  const canonical = realpathSync(rolloutPath)
  if (canonical !== resolve(rolloutPath)) throw new Error('CODEX_COMPACTION_PATH_INVALID')
  const info = lstatSync(canonical)
  if (!info.isFile() || info.isSymbolicLink() || info.size > CODEX_ROLLOUT_MAX_BYTES) {
    throw new Error('CODEX_COMPACTION_PATH_INVALID')
  }
  let latest: { timestamp: number; message: string } | null = null
  const lines = createInterface({
    input: createReadStream(canonical, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const line of lines) {
    if (!line.includes('"type":"compacted"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const row = parsed as Record<string, unknown>
    if (row.type !== 'compacted' || !row.payload || typeof row.payload !== 'object') continue
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isFinite(ts) || ts + 5_000 < compactStartedAt) continue
    const payload = row.payload as Record<string, unknown>
    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (!message || !Array.isArray(payload.replacement_history)) continue
    if (!latest || ts >= latest.timestamp) latest = { timestamp: ts, message }
  }
  if (!latest) throw new Error('CODEX_NATIVE_COMPACTION_NOT_EXPORTED')
  return { summaryText: latest.message, source: 'codex', compactStartedAt }
}

export function runnerShutdownTimeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function waitForCloseWithin(closePromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (closed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    closePromise.then(() => finish(true))
  })
}

export function killCodexProcessGroup(proc: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (typeof proc.pid === 'number' && proc.pid > 0) {
      process.kill(-proc.pid, signal)
      return
    }
  } catch {
    // Fall back to the direct child if the detached process group is already
    // gone or unavailable on this platform.
  }
  try {
    proc.kill(signal)
  } catch {
    /* ignore */
  }
}


const guardedStdin = new WeakSet<object>()
export function guardStdinErrors(stdin: {
  on?: (event: 'error', fn: (err: Error) => void) => unknown
}): void {
  if (guardedStdin.has(stdin)) return
  guardedStdin.add(stdin)
  if (typeof stdin.on !== 'function') return
  stdin.on('error', () => {
    /* swallow async EPIPE so a settled write cannot become uncaughtException */
  })
}

export function normalisePrompt(input: string | Array<{ type: string; text?: string }>): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const b of input) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(true)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function isInlinePushProcLive(
  proc: ChildProcessWithoutNullStreams | null,
  currentProc: ChildProcessWithoutNullStreams | null,
): boolean {
  if (!proc || currentProc !== proc) return false
  if (proc.killed || proc.exitCode != null || proc.signalCode != null) return false
  return true
}

export async function writeCodexDelegateTerminalNotification(
  proc: ChildProcessWithoutNullStreams | null,
  isLive: (candidate: ChildProcessWithoutNullStreams | null) => boolean,
  line: string,
): Promise<{ ok: boolean; processAlive: boolean; unknown?: boolean }> {
  if (!isLive(proc) || !proc) return { ok: false, processAlive: false }
  const stdin = proc.stdin
  if (!stdin || stdin.writable === false || stdin.destroyed) {
    return { ok: false, processAlive: true }
  }
  guardStdinErrors(stdin)
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(new Error('codex stdin write timeout')), 2_000)
      timer.unref?.()
      const finish = (err?: Error | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (typeof stdin.off === 'function') stdin.off('error', onError)
        if (typeof proc.off === 'function') proc.off('close', onClose)
        if (err) reject(err)
        else resolve()
      }
      const onError = (err: Error): void => finish(err)
      const onClose = (): void => finish(new Error('codex process closed during inline push'))
      if (typeof stdin.once === 'function') stdin.once('error', onError)
      if (typeof proc.once === 'function') proc.once('close', onClose)
      try {
        stdin.write(`${line}\n`, (err) => finish(err))
      } catch (err) {
        finish(err as Error)
      }
    })
    if (!isLive(proc)) {
      return { ok: false, processAlive: false }
    }
    return { ok: true, processAlive: true }
  } catch (err) {
    const live = isLive(proc)
    const message = err instanceof Error ? err.message : ''
    if (live && message.includes('stdin write timeout')) {
      return { ok: false, processAlive: true, unknown: true }
    }
    return { ok: false, processAlive: live }
  }
}

export async function handleCodexChatgptAuthTokensRefresh(args: {
  id: string | number
  params: unknown
  sessionKey: string
  writeRaw: (line: string) => boolean
  warn: (message: string, meta: Record<string, unknown>) => void
}): Promise<void> {
  const { id, params, sessionKey, writeRaw, warn } = args
  const baseUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const token = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  if (!baseUrl || !token) {
    writeRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message:
            "method 'account/chatgptAuthTokens/refresh' not implemented by openclaude-gateway",
        },
      }),
    )
    return
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/internal/v3/codex/token-refresh`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params ?? {}),
    })
    const text = await resp.text()
    if (resp.status >= 200 && resp.status < 300) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (err) {
        warn('codex token refresh: master 2xx but body not JSON', {
          sessionKey,
          status: resp.status,
          err: (err as Error).message,
        })
        writeRaw(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: 'codex token refresh: master returned non-JSON body',
            },
          }),
        )
        return
      }
      writeRaw(JSON.stringify({ jsonrpc: '2.0', id, result: parsed }))
      return
    }
    warn('codex token refresh: master returned non-2xx', {
      sessionKey,
      status: resp.status,
      body: text.slice(0, 512),
    })
    writeRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `codex token refresh failed: master returned ${resp.status}`,
        },
      }),
    )
  } catch (err) {
    warn('codex token refresh: master fetch threw', {
      sessionKey,
      err: (err as Error).message,
    })
    writeRaw(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `codex token refresh failed: ${(err as Error).message}`,
        },
      }),
    )
  }
}
