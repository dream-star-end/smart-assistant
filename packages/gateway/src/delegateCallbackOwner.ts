/**
 * OCV5-22 B2: leftover send_to_agent intent recovery is not a second consumer
 * when a durable job row exists. Completer (job row) is the sole callback
 * owner for a release generation.
 */
import {
  isDelegateTerminalState,
  type DelegateCallbackState,
  type DelegateJobState,
} from '@openclaude/protocol'
import type { DelegateJobSnapshot } from './delegateJobs.js'
import { resolveDelegateCallbackOwner } from './delegateSmFlag.js'

export type IntentRecoveryAction =
  | { action: 'legacy_interrupt' }
  | { action: 'drop_shadow' }
  | { action: 'ack_delivered' }
  | { action: 'ensure_callback'; jobId: string; state: DelegateJobState }

export type IntentRecoveryJobView = {
  jobId: string
  state: DelegateJobState
  callbackState?: DelegateCallbackState
}

const ACKED_CALLBACK_STATES = new Set<DelegateCallbackState>([
  'delivered',
  'skipped_silent',
  'abandoned',
])

export function decideSendToAgentIntentRecovery(opts: {
  callbackOwner: 'job' | 'intent'
  job: IntentRecoveryJobView | undefined
}): IntentRecoveryAction {
  if (opts.callbackOwner === 'intent') return { action: 'legacy_interrupt' }
  if (!opts.job) return { action: 'legacy_interrupt' }
  if (!isDelegateTerminalState(opts.job.state)) return { action: 'drop_shadow' }
  if (opts.job.callbackState && ACKED_CALLBACK_STATES.has(opts.job.callbackState)) {
    return { action: 'ack_delivered' }
  }
  return { action: 'ensure_callback', jobId: opts.job.jobId, state: opts.job.state }
}

/**
 * Shared ownership predicate for flag-off (`OC_DELEGATE_NOTIFIER=0`)
 * `origin-inject` job-row delivery and retry scheduling.
 *
 * - `kind === 'delegate'` with `callbackOriginSessionKey` (dynamic MCP wait
 *   handoff) is always job-row owned regardless of `callbackOwner`.
 * - `kind === 'send_to_agent'` is job-row owned ONLY when
 *   `callbackOwner === 'job'`. When `callbackOwner === 'intent'` and
 *   `NOTIFIER=0`, the legacy intent path owns delivery (`sta-cb-{jobId}` and
 *   intent file removal without advancing `delegate_jobs.callback_state`), so
 *   both row selection and dispatch must skip these rows to prevent duplicate
 *   delivery with a fresh `dlgcb-*` id on timer tick or restart.
 */
export function isFlagOffJobOwnedOriginInject(
  job: Pick<
    DelegateJobSnapshot,
    'kind' | 'callback' | 'callbackOriginSessionKey' | 'parentSessionKey'
  >,
  callbackOwner: 'job' | 'intent' = resolveDelegateCallbackOwner(),
): boolean {
  if (job.callback !== 'origin-inject') return false
  if (job.kind === 'delegate') return Boolean(job.callbackOriginSessionKey)
  if (job.kind === 'send_to_agent') {
    return callbackOwner === 'job' && Boolean(job.callbackOriginSessionKey || job.parentSessionKey)
  }
  return false
}
