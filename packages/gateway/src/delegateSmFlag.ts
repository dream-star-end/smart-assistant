/**
 * OCV5-22 phase 0 feature flags.
 *
 * OC_DELEGATE_SM=0 (default) keeps today's in-memory Map UX (running/done/expired).
 * OC_DELEGATE_SM=1 enables queued/failure_class/owner-lease/callback-owner.
 * Resume occupancy + idempotency is a bugfix and is always on.
 */
export function isDelegateSmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_SM ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

export function resolveDelegateCallbackOwner(
  env: NodeJS.ProcessEnv = process.env,
): 'job' | 'intent' {
  const raw = String(env.OC_DELEGATE_CALLBACK_OWNER ?? '').trim().toLowerCase()
  if (raw === 'intent') return 'intent'
  if (raw === 'job') return 'job'
  // SM on still defaults to job, but Completer + snapshot persist must be live
  // before any shadow is deleted (see recover + shutdown).
  return isDelegateSmEnabled(env) ? 'job' : 'intent'
}
