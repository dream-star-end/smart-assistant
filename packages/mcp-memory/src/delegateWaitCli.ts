/**
 * `oc-memory delegate-wait` — long-poll the gateway until every jobId reaches
 * a terminal state, or until this foreground Bash segment approaches Cursor's
 * background-handoff deadline. Healthy elapsed wall time is never a failure:
 * a bounded segment returns the same pending jobIds for the next call.
 */
import {
  formatDelegateHttpResult,
  interpretDelegateWaitBody,
  type FormattedDelegateResult,
} from './delegateCursorFastPath.js'

export const DEFAULT_DELEGATE_WAIT_POLL_MS = 30_000
export const MIN_DELEGATE_WAIT_POLL_MS = 250
export const MAX_DELEGATE_WAIT_POLL_MS = 55_000
// Cursor 的 foreground Bash 会在 60 分钟左右被改挂为它自己的
// background task。那个 task registry 不认 OpenClaude delegate job 终态,
// 会让 TaskOutput 再空等一整个 blockUntilMs。每段 CLI 等待必须在
// 该边界前主动返回可续等的 jobId。
export const DEFAULT_DELEGATE_CLI_FOREGROUND_BUDGET_MS = 50 * 60_000
export const MIN_DELEGATE_CLI_FOREGROUND_BUDGET_MS = 60_000
export const MAX_DELEGATE_CLI_FOREGROUND_BUDGET_MS = 55 * 60_000

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

/** One foreground Bash segment. Default 50m, always below Cursor's ~60m handoff. */
export function resolveDelegateCliForegroundBudgetMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return normalizeMs(
    env.OPENCLAUDE_DELEGATE_CLI_FOREGROUND_BUDGET_MS,
    DEFAULT_DELEGATE_CLI_FOREGROUND_BUDGET_MS,
    MIN_DELEGATE_CLI_FOREGROUND_BUDGET_MS,
    MAX_DELEGATE_CLI_FOREGROUND_BUDGET_MS,
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
  foregroundBudgetMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<DelegateWaitLoopResult> {
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
  const now = opts.now ?? Date.now
  const startedAt = now()

  while (pending.size > 0) {
    const remainingMs = opts.foregroundBudgetMs === undefined
      ? Number.POSITIVE_INFINITY
      : opts.foregroundBudgetMs - (now() - startedAt)
    if (remainingMs < MIN_DELEGATE_WAIT_POLL_MS) {
      return formatForegroundBudgetElapsed(unique, pending, results)
    }
    const waitMs = Math.min(opts.pollWaitMs, remainingMs)
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
    if (
      opts.foregroundBudgetMs !== undefined &&
      now() - startedAt >= opts.foregroundBudgetMs
    ) {
      return formatForegroundBudgetElapsed(unique, pending, results)
    }
    const roundElapsed = now() - roundStarted
    if (roundElapsed < BUSY_LOOP_GUARD_MS) {
      await sleep(1_000)
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

function formatForegroundBudgetElapsed(
  jobIds: string[],
  pending: Set<string>,
  results: Map<string, FormattedDelegateResult>,
): DelegateWaitLoopResult {
  const completed = jobIds.filter((id) => !pending.has(id))
  const pendingIds = jobIds.filter((id) => pending.has(id))
  const lines = [
    `前台安全等待窗口已到: ${completed.length} 已完成 / ${pendingIds.length} 仍在运行。`,
    '已主动退出本次 Bash,避免 Cursor 把长命令改挂到无法感知 delegate 终态的 TaskOutput。',
  ]
  if (completed.length > 0) {
    lines.push('', '### 已完成')
    for (const id of completed) {
      const result = results.get(id)
      lines.push(`- ${id}`, result?.text ?? '(无输出)')
    }
  }
  lines.push(
    '',
    '### 仍在运行',
    ...pendingIds.map((id) => `- status=running jobId=${id}`),
    '请立即继续下一段前台等待,不要重新委派,不要使用 Cursor TaskOutput:',
    `  oc-memory delegate-wait ${pendingIds.join(' ')}`,
  )
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
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
