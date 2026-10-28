import type { AutomaticRecoveryDecision } from '../db/pgSessionsBackend.js';
import { automaticRetryStatus, getUserError } from '@openclaude/protocol';
import type { ClaimedRecoveryJob } from '../dispatch/turnRecoveryStore.js';

/** Old queued jobs predate the actual limit field: omit N instead of claiming 10. */
export function recoveryJobStatus(job: ClaimedRecoveryJob, state: 'scheduled' | 'running') {
  const limit = job.request._automaticRecoveryRetryLimit;
  return automaticRetryStatus(state, job.semanticRecoveryAttempt, typeof limit === 'number' ? limit : undefined);
}

export function recoveryRunningFrame(job: ClaimedRecoveryJob) {
  return {
    type: 'sys.recovery_status',
    peer: { id: job.sessionId, kind: 'dm' },
    sourceClientMessageId: job.sourceClientMessageId,
    rootClientMessageId: job.rootClientMessageId,
    clientMessageId: job.request.clientMessageId,
    retryStatus: recoveryJobStatus(job, 'running'),
    ts: Date.now(),
  };
}

export function recoveryDecisionFrame(sessionId: string, verdict: AutomaticRecoveryDecision) {
  return {
    type: 'sys.recovery_decision',
    peer: { id: sessionId, kind: 'dm' },
    ...verdict,
    userError: getUserError(verdict.errorCode),
    ts: Date.now(),
  };
}
