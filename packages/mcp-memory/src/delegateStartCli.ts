/**
 * `oc-memory delegate` / `request-review` — start an async gateway job then
 * block on the same wait loop as `delegate-wait`. Identity/depth come from the
 * signed context file (gateway-issued), never from Shell env or CLI flags.
 */
import { readFileSync } from 'node:fs'
import {
  interpretDelegateStartBody,
  type FormattedDelegateResult,
} from './delegateCursorFastPath.js'
import {
  runDelegateWaitLoop,
  type DelegateWaitLoopResult,
  type DelegateWaitOnce,
} from './delegateWaitCli.js'

export const DELEGATE_CONTEXT_HEADER = 'x-openclaude-delegate-context'
export const DELEGATE_CONTEXT_FILE_ENV = 'OPENCLAUDE_DELEGATE_CONTEXT_FILE'

export type DelegateCliArgs = {
  agentId: string
  goal: string
  context?: string
  effort?: string
  model?: string
  toolsets?: string[]
  resumeSessionKey?: string
}

export function readDelegateContextToken(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; token: string } | { ok: false; error: string } {
  const file = env[DELEGATE_CONTEXT_FILE_ENV]?.trim()
  if (!file) {
    return {
      ok: false,
      error: `${DELEGATE_CONTEXT_FILE_ENV} missing:异步委派必须带网关签发的上下文文件，禁止用环境变量伪造 agent/session/depth`,
    }
  }
  try {
    const token = readFileSync(file, 'utf8').trim()
    if (!token) return { ok: false, error: `delegate context file is empty: ${file}` }
    return { ok: true, token }
  } catch (err: any) {
    return {
      ok: false,
      error: `delegate context file unreadable (${file}): ${err?.message ?? err}`,
    }
  }
}

export function buildDelegateStartBody(args: DelegateCliArgs): Record<string, unknown> {
  return {
    goal: args.goal,
    ...(args.context ? { context: args.context } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.toolsets && args.toolsets.length > 0 ? { toolsets: args.toolsets } : {}),
    ...(args.resumeSessionKey ? { resumeSessionKey: args.resumeSessionKey } : {}),
    async: true,
    streamProgress: true,
  }
}

export function requestReviewArgs(draft: string, revisionNote?: string, resumeSessionKey?: string): DelegateCliArgs {
  const note =
    revisionNote && revisionNote.trim()
      ? `\n\n【队长修订说明】\n${revisionNote.trim().slice(0, 4000)}`
      : ''
  return {
    agentId: 'hidden-reviewer',
    goal: '对队长准备提交给用户的最终答复草稿做独立质量审查,给出结构化裁决。',
    context: draft.slice(0, 16000) + note,
    resumeSessionKey,
  }
}

export type DelegateStartOnce = (agentId: string, body: string, contextToken: string) => Promise<{
  statusCode: number
  body: string
}>

export async function runDelegateStartAndWait(opts: {
  args: DelegateCliArgs
  contextToken: string
  start: DelegateStartOnce
  waitOnce: DelegateWaitOnce
  pollWaitMs: number
}): Promise<DelegateWaitLoopResult> {
  const started = await opts.start(
    opts.args.agentId,
    JSON.stringify(buildDelegateStartBody(opts.args)),
    opts.contextToken,
  )
  const start = interpretDelegateStartBody(started.statusCode, started.body)
  if ('error' in start) {
    return { exitCode: 1, stdout: '', stderr: `${start.error}\n` }
  }
  return runDelegateWaitLoop({
    jobIds: [start.jobId],
    waitOnce: opts.waitOnce,
    pollWaitMs: opts.pollWaitMs,
  })
}

export function formatCliDelegateResult(result: DelegateWaitLoopResult): DelegateWaitLoopResult {
  return result
}

export function looksLikeFormattedDelegate(result: FormattedDelegateResult): boolean {
  return result.kind === 'ok' || result.kind === 'error' || result.kind === 'running'
}
