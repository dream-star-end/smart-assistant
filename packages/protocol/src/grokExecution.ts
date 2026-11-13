/**
 * Public Grok CLI version projected from a trusted per-turn admission.
 * Callers must verify a signed authority or authenticated master response
 * first. This validates binding/shape, not signatures. No credentials/endpoints.
 */
export interface GrokExecutionDescriptor {
  readonly canonicalModel: string
  readonly upstreamModelId: string
  readonly billingRequestId: string
  readonly executionRevision: string
  readonly authorityTurnId?: string
  readonly engineSessionId?: string
  readonly routeTokenHash?: string
}

export function grokExecutionUpstream(canonicalModel: string, upstream: unknown): string {
  if (canonicalModel === 'grok-build' && (upstream === 'grok-4.6' || upstream === 'grok-4.7')) return upstream
  if (canonicalModel === 'grok-build-fast' && upstream === 'grok-4.7-build-fast') return upstream
  throw new Error('GROK_EXECUTION_DESCRIPTOR_INVALID: canonical/upstream mismatch')
}

export function freezeGrokExecutionDescriptor(
  raw: GrokExecutionDescriptor,
  binding: { canonicalModel: string; billingRequestId: string; engineSessionId?: string; routeTokenHash?: string },
): GrokExecutionDescriptor {
  if (!raw || raw.canonicalModel !== binding.canonicalModel
    || raw.billingRequestId !== binding.billingRequestId
    || !/^[0-9a-f]{32}$/.test(raw.billingRequestId)
    || typeof raw.executionRevision !== 'string' || !raw.executionRevision
    || (binding.engineSessionId !== undefined && raw.engineSessionId !== binding.engineSessionId)
    || (binding.routeTokenHash !== undefined && raw.routeTokenHash !== binding.routeTokenHash)) {
    throw new Error('GROK_EXECUTION_DESCRIPTOR_INVALID: turn binding mismatch')
  }
  const upstreamModelId = grokExecutionUpstream(raw.canonicalModel, raw.upstreamModelId)
  return Object.freeze({
    canonicalModel: raw.canonicalModel, upstreamModelId,
    billingRequestId: raw.billingRequestId, executionRevision: raw.executionRevision,
    ...(raw.authorityTurnId === undefined ? {} : { authorityTurnId: raw.authorityTurnId }),
    ...(raw.engineSessionId === undefined ? {} : { engineSessionId: raw.engineSessionId }),
    ...(raw.routeTokenHash === undefined ? {} : { routeTokenHash: raw.routeTokenHash }),
  })
}
