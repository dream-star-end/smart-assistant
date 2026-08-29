/**
 * OCV5-22 phase 0 / stage 1 feature flags.
 *
 * OC_DELEGATE_SM=0 (default) keeps today's in-memory Map UX (running/done/expired).
 * OC_DELEGATE_SM=1 enables queued/failure_class/owner-lease/callback-owner.
 * OC_DELEGATE_DURABLE=0 (default) keeps JSON snapshots; 1 writes WAL SQLite.
 * Production semantics require both SM and durable on (design v3 §4).
 * Resume occupancy + idempotency is a bugfix and is always on.
 */
export function isDelegateSmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_SM ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

export function isDelegateDurableEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_DURABLE ?? '').trim().toLowerCase()
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
