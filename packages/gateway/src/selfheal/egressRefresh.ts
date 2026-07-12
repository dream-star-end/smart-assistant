/**
 * MED16 (block C / §C5): /api/egress-proxy/refresh must preserve the selector
 * structure once the egress config has been migrated to the primary/backup
 * selector — the legacy refreshEgressNodes would rewrite a single-outbound
 * config and silently destroy the selector (and the watchdog's failover state).
 *
 * Route behavior: prefer resyncEgressSelector; ONLY when the config has not
 * been migrated yet ("not a selector config") fall back to the legacy refresh.
 * Any other non-resync reason (e.g. "no primary member") is returned as-is —
 * falling back there would clobber a selector config.
 */

import { refreshEgressNodes, resyncEgressSelector } from '../egressSubscription.js'

type EgressOpts = Parameters<typeof resyncEgressSelector>[0]

export interface EgressRefreshImpl {
  resync: typeof resyncEgressSelector
  refresh: typeof refreshEgressNodes
}

const defaultImpl: EgressRefreshImpl = {
  resync: resyncEgressSelector,
  refresh: refreshEgressNodes,
}

export async function refreshEgressPreferSelector(
  opts: EgressOpts = {},
  impl: EgressRefreshImpl = defaultImpl,
): Promise<
  Awaited<ReturnType<typeof resyncEgressSelector>> | Awaited<ReturnType<typeof refreshEgressNodes>>
> {
  const resynced = await impl.resync(opts)
  if (resynced.resynced) return resynced
  if ((resynced.reason ?? '').includes('not a selector')) {
    // Pre-migration config — legacy single-outbound refresh still applies.
    return impl.refresh(opts)
  }
  return resynced
}
