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
 * OC_DELEGATE_INFLIGHT_SURFACE=0 (default) keeps today's turn_status working-detail
 * only; 1 dual-writes a session-level inflight slot (design v3 §N4 / R2).
 * OC_DELEGATE_INLINE_PUSH_CCB=0 / OC_DELEGATE_INLINE_PUSH_CODEX=0 (default)
 * keep the R0/R1 duck-type stdin probe; 1 uses EngineAdapter.writeDelegateTerminal.
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

/**
 * R2 session-level inflight surface. Default off. A lone INFLIGHT_SURFACE=1
 * enables the slot (in-process always; restart rebuild uses durable jobs when
 * SM&&DURABLE). Flag-off is byte-equivalent to 653ef6339 for turn_status.
 */
export function isDelegateInflightSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.OC_DELEGATE_INFLIGHT_SURFACE ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

export function isDelegateInflightSurfaceEffective(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDelegateInflightSurfaceEnabled(env)
}

function envFlagOn(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = String(env[key] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

/**
 * R3 档 A InlinePush. Default off per engine. A lone flag is a no-op until
 * EngineNotifier is effective (SM && DURABLE && NOTIFIER); server wiring
 * only reaches this predicate from the notifier port.
 * Flag-off keeps the R0/R1 duck-type stdin probe (653ef6339 equivalent).
 */
export function isDelegateInlinePushCcbEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env, 'OC_DELEGATE_INLINE_PUSH_CCB')
}

export function isDelegateInlinePushCodexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlagOn(env, 'OC_DELEGATE_INLINE_PUSH_CODEX')
}

export function isDelegateInlinePushEnabled(
  engine: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (engine === 'ccb') return isDelegateInlinePushCcbEnabled(env)
  if (engine === 'codex') return isDelegateInlinePushCodexEnabled(env)
  return false
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
