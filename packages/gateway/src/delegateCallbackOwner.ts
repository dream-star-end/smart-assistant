/**
 * OCV5-22 B2: leftover send_to_agent intent recovery is not a second consumer
 * when a durable job row exists. Completer (job row) is the sole callback
 * owner for a release generation.
 */
import { isDelegateTerminalState, type DelegateJobState } from '../../protocol/src/delegation.js'

export type IntentRecoveryAction =
  | { action: 'legacy_interrupt' }
  | { action: 'drop_shadow' }
  | { action: 'ensure_callback'; jobId: string; state: DelegateJobState }

export type IntentRecoveryJobView = {
  jobId: string
  state: DelegateJobState
}

export function decideSendToAgentIntentRecovery(opts: {
  callbackOwner: 'job' | 'intent'
  job: IntentRecoveryJobView | undefined
}): IntentRecoveryAction {
  if (opts.callbackOwner === 'intent') return { action: 'legacy_interrupt' }
  if (!opts.job) return { action: 'legacy_interrupt' }
  if (!isDelegateTerminalState(opts.job.state)) return { action: 'drop_shadow' }
  return { action: 'ensure_callback', jobId: opts.job.jobId, state: opts.job.state }
}
