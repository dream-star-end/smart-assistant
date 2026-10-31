import { isDelegateTerminalState, type DurableAgentGroup } from '@openclaude/protocol'
import { DelegateInflightSurfaceStore } from './delegateInflightSurface.js'
import { isDelegateInflightSurfaceEffective } from './delegateSmFlag.js'
import type { DelegateSupervisionHost } from './delegateSupervision.js'
import type { RunDelegateInput } from './delegatePolicy.js'

export function flushBackgroundCompletion(input: RunDelegateInput): void {
  const actions = input.backgroundCompletionActions
  input.backgroundCompletionActions = undefined
  for (const publish of actions ?? []) publish()
}

/** Legacy completion folds inline; background callers invoke this only after
 * full cleanup and the job's terminal CAS. A completed model is not a retired job. */
export function foldDelegateCompletionSurface(
  host: Pick<DelegateSupervisionHost, '_ensureDelegateInflightSurface' | '_delegateJobs' | 'log'>,
  args: { jobId?: string; progressRunId: string; parentSessionKey?: string; userId?: string;
    agentId: string; goal: string; nested: boolean; ownerRunId?: string; group: DurableAgentGroup;
    background: boolean; cancelled: boolean },
): void {
  if (!isDelegateInflightSurfaceEffective()) return
  try {
    const jobId = DelegateInflightSurfaceStore.resolveJobId(args.jobId, args.progressRunId)
    if (!jobId || !args.parentSessionKey) return
    const snap = args.jobId ? host._delegateJobs?.snapshotOf(args.jobId) : undefined
    if (args.background && snap && !isDelegateTerminalState(snap.state)) return
    const fence = snap ? { fencingEpoch: snap.fencingEpoch, generation: snap.generation } : {}
    const surface = host._ensureDelegateInflightSurface()
    if (!surface.get(jobId)) {
      surface.upsertEnqueue({ jobId, parentSessionKey: args.parentSessionKey,
        agentId: args.agentId, goal: args.goal, runId: args.progressRunId, state: 'running',
        userId: args.userId, nested: args.nested, ownerRunId: args.ownerRunId,
        background: args.background ? true : undefined, ...fence })
    }
    surface.foldTerminal({ jobId, group: args.group,
      state: snap && isDelegateTerminalState(snap.state) ? snap.state
        : args.background && args.cancelled ? 'cancelled' : 'completed',
      // The terminal job CAS owns state; its summary may now be enriched with
      // the complete paid transcript without permitting a running regression.
      authoritative: args.background ? true : undefined,
      parentSessionKey: args.parentSessionKey, userId: args.userId, ...fence })
  } catch (error) {
    host.log.warn('delegate inflight surface fold failed',
      { jobId: args.jobId, progressRunId: args.progressRunId }, error as Error)
  }
}
