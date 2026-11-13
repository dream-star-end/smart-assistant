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
