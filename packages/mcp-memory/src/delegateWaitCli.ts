/**
 * `oc-memory delegate-wait` — long-poll the gateway until every jobId finishes
 * or the hard cap is hit. Blocks on `/api/delegate/wait` (tens of seconds per
 * round); never busy-spins.
 */
import {
  formatDelegateHttpResult,
  interpretDelegateWaitBody,
  type FormattedDelegateResult,
} from './delegateCursorFastPath.js'

export const DEFAULT_DELEGATE_WAIT_POLL_MS = 30_000
export const MIN_DELEGATE_WAIT_POLL_MS = 250
export const MAX_DELEGATE_WAIT_POLL_MS = 55_000

export const DEFAULT_DELEGATE_WAIT_HARD_MS = 2 * 60 * 60_000 + 60_000
export const MIN_DELEGATE_WAIT_HARD_MS = 60_000
export const MAX_DELEGATE_WAIT_HARD_MS = DEFAULT_DELEGATE_WAIT_HARD_MS

function normalizeMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Per-round long-poll. Default 30s; env `OPENCLAUDE_DELEGATE_WAIT_POLL_MS` clamped to 250ms..55s. */
export function resolveDelegateWaitPollMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeMs(
    env.OPENCLAUDE_DELEGATE_WAIT_POLL_MS,
    DEFAULT_DELEGATE_WAIT_POLL_MS,
    MIN_DELEGATE_WAIT_POLL_MS,
    MAX_DELEGATE_WAIT_POLL_MS,
  )
}

/** Overall CLI cap. Default 2h+60s (outlasts gateway hard clamp); env `OPENCLAUDE_DELEGATE_WAIT_HARD_MS` clamped to 1min..2h+60s. */
export function resolveDelegateWaitHardMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeMs(
    env.OPENCLAUDE_DELEGATE_WAIT_HARD_MS,
    DEFAULT_DELEGATE_WAIT_HARD_MS,
    MIN_DELEGATE_WAIT_HARD_MS,
    MAX_DELEGATE_WAIT_HARD_MS,
  )
}

export type DelegateWaitOnce = (
  jobId: string,
  waitMs: number,
) => Promise<{ statusCode: number; body: string }>

export type DelegateWaitLoopResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const BUSY_LOOP_GUARD_MS = 200

/** Transport blip on one long-poll: keep waiting instead of failing the whole CLI. */
export function isTransientDelegateWaitError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: unknown }
  const code = e?.code || e?.cause?.code
  const msg = String(e?.message ?? err)
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    /delegate client timeout/i.test(msg) ||
    /socket hang up/i.test(msg)
  )
}

export async function runDelegateWaitLoop(opts: {
  jobIds: string[]
  waitOnce: DelegateWaitOnce
  pollWaitMs: number
  hardTimeoutMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<DelegateWaitLoopResult> {
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }))
  const unique = [...new Set(opts.jobIds.map((id) => id.trim()).filter(Boolean))]
  if (unique.length === 0) {
    return { exitCode: 1, stdout: '', stderr: 'delegate-wait requires at least one <jobId>\n' }
  }
  const pending = new Set(unique)
  const results = new Map<string, FormattedDelegateResult>()
  const startedAt = now()

  while (pending.size > 0) {
    const elapsed = now() - startedAt
    if (elapsed >= opts.hardTimeoutMs) {
      const leftover = [...pending].join(', ')
      return {
        exitCode: 2,
        stdout: formatCollected(unique, results),
        stderr: `delegate-wait timed out after ${Math.round(opts.hardTimeoutMs / 1000)}s; still running: ${leftover}\n`,
      }
    }
    const remaining = opts.hardTimeoutMs - elapsed
    const waitMs = Math.max(1, Math.min(opts.pollWaitMs, remaining))
    const roundStarted = now()
    const views = await Promise.all(
      [...pending].map(async (jobId) => {
        try {
          const res = await opts.waitOnce(jobId, waitMs)
          return { jobId, view: interpretDelegateWaitBody(res.statusCode, res.body) }
        } catch (err) {
          // One idle long-poll dying (45s client timeout, reset) is not a
          // failed child. Treat as still running and poll again.
          if (isTransientDelegateWaitError(err)) {
            return { jobId, view: { kind: 'running' as const, jobId } }
          }
          throw err
        }
      }),
    )
    for (const { jobId, view } of views) {
      if (view.kind === 'running') continue
      pending.delete(jobId)
      if (view.kind === 'expired') {
        results.set(jobId, { kind: 'error', text: `委派失败: ${view.error}` })
        continue
      }
      if (view.kind === 'error') {
        results.set(jobId, { kind: 'error', text: view.error })
        continue
      }
      results.set(jobId, formatDelegateHttpResult(view.httpStatus, view.body, jobId))
    }
    if (pending.size === 0) break
    const roundElapsed = now() - roundStarted
    if (roundElapsed < BUSY_LOOP_GUARD_MS) {
      await sleep(Math.min(1_000, remaining))
    }
  }

  const formatted = formatCollected(unique, results)
  const failed = unique.some((id) => results.get(id)?.kind === 'error')
  return {
    exitCode: failed ? 2 : 0,
    stdout: formatted.endsWith('\n') ? formatted : `${formatted}\n`,
    stderr: '',
  }
}

function formatCollected(
  jobIds: string[],
  results: Map<string, FormattedDelegateResult>,
): string {
  if (jobIds.length === 1) {
    const r = results.get(jobIds[0])
    return r?.text ?? ''
  }
  const sections = jobIds.map((id, i) => {
    const r = results.get(id)
    const mark = !r ? '…' : r.kind === 'error' ? '❌' : '✅'
    const body = r?.text ?? '(无输出)'
    return [`### ${i + 1}. ${mark} ${id}`, body].join('\n')
  })
  const okCount = jobIds.filter((id) => results.get(id)?.kind === 'ok').length
  const failCount = jobIds.length - okCount
  return [`委派等待 ${jobIds.length} 个作业: ${okCount} 成功 / ${failCount} 失败。`, '', sections.join('\n\n')].join(
    '\n',
  )
}
