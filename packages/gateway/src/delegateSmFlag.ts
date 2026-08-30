/**
 * OCV5-22 phase 0 / stage 1 feature flags.
 *
 * OC_DELEGATE_SM=0 (default) keeps today's in-memory Map UX (running/done/expired).
 * OC_DELEGATE_SM=1 enables queued/failure_class/owner-lease/callback-owner.
 * OC_DELEGATE_DURABLE=0 (default) keeps JSON snapshots; 1 writes WAL SQLite.
 * OC_DELEGATE_NOTIFIER=0 (default) keeps Completer origin-inject; 1 enables
 * the EngineNotifier side channel (requires SM && DURABLE).
 * OC_DELEGATE_CUTOVER=0 (default) keeps today's recycle/SIGTERM path; 1 enables
 * BeginCutover freeze + runningDelegateJobs drain (requires SM && DURABLE && NOTIFIER).
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

/** Production durable path is SM && DURABLE. A lone DURABLE=1 is a no-op flag. */
export function isDelegateDurableEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDelegateSmEnabled(env) && isDelegateDurableEnabled(env)
}

/**
 * R0/R1 EngineNotifier. Default off. Production notify requires SM && DURABLE
 * && NOTIFIER so SM=0 or DURABLE=0 stays byte-equivalent to 38c70b490.
 */
export function isDelegateNotifierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_NOTIFIER ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

export function isDelegateNotifierEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDelegateDurableEffective(env) && isDelegateNotifierEnabled(env)
}

/**
 * Stage 3 cutover immunity. Default off. Production freeze/drain/ClaimPaused
 * requires SM && DURABLE && NOTIFIER && CUTOVER so a lone CUTOVER=1 is a no-op.
 */
export function isDelegateCutoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_CUTOVER ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

export function isDelegateCutoverEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDelegateNotifierEffective(env) && isDelegateCutoverEnabled(env)
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
