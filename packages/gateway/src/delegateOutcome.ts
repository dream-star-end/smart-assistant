import type { DelegateJobState } from '@openclaude/protocol'

/** Read model only: never rewrite the settled job or infer errors from prose. */
export function effectiveDelegateOutcome(job: {
  state: DelegateJobState
  failureClass?: string
  result?: { body: Record<string, unknown> } | null
}): DelegateJobState {
  if (job.state === 'completed' &&
      (job.failureClass === 'child_error' || job.result?.body.ok === false)) {
    return 'failed'
  }
  return job.state
}
