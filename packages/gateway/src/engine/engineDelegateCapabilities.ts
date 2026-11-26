/**
 * Engine capability predicates for billed commercial delegation (OCV5-895).
 *
 * Encapsulated inside `gateway-engines` so `localExecution.ts` and
 * `delegateModelCatalogPrompt.ts` share a single source of truth without
 * branching on raw engine literals outside the adapter layer (R3-special-case).
 */

/** Engines eligible for commercial `billed_delegate` preflight & prompt advertisement. */
const COMMERCIAL_BILLED_DELEGATE_ENGINES: ReadonlySet<string> = new Set([
  'ccb',
  'grok',
  'codex',
])

/**
 * Engine-reported engines (non-CCB) that admit master billing + provider route
 * before local execution under `kind === 'billed_delegate'`.
 */
const BILLED_DELEGATE_MASTER_ADMITTED_ENGINES: ReadonlySet<string> = new Set([
  'grok',
  'codex',
])

export function isCommercialBilledDelegateEngine(engine: string): boolean {
  return COMMERCIAL_BILLED_DELEGATE_ENGINES.has(engine)
}

export function isBilledDelegateMasterAdmittedEngine(engine: string): boolean {
  return BILLED_DELEGATE_MASTER_ADMITTED_ENGINES.has(engine)
}
