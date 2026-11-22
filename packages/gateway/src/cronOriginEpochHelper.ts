import {
  ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE,
  parseOriginWebchatSessionKey,
  type CronOriginFireResult,
} from './cronOriginSession.js'
import { NOTIFY_MAX_CALLBACK_EPOCH } from './delegateJobsNotifyOps.js'

export interface CronOriginEpochOccurrence {
  callbackEpoch?: number
  updatedAt?: number
}

export interface CronOriginEpochDeliveryContext {
  dueMinuteKey: number
  deliveryId: string
  callbackEpoch?: number
}

export interface FireCronOriginWithEpochBumpParams<
  TJob extends { id: string; sourceSessionKey?: string; projectMode?: unknown; boardProjectId?: string | null },
  TOcc extends CronOriginEpochOccurrence,
  TCtx extends CronOriginEpochDeliveryContext,
> {
  useLegacyLeg: boolean
  job: TJob
  project: { mode: TJob['projectMode']; boardProjectId: string | null }
  deliveryContext: TCtx
  readOccurrence: (deliveryId: string) => TOcc | null
  writeOccurrence: (occ: TOcc) => void
  onOriginSessionFire: (job: TJob, ctx: TCtx) => Promise<CronOriginFireResult>
  notifyOriginSessionDropped: (job: TJob, ctx: TCtx, reason: 'exhausted') => Promise<void>
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export async function fireCronOriginWithEpochBump<
  TJob extends { id: string; sourceSessionKey?: string; projectMode?: unknown; boardProjectId?: string | null },
  TOcc extends CronOriginEpochOccurrence,
  TCtx extends CronOriginEpochDeliveryContext,
>(params: FireCronOriginWithEpochBumpParams<TJob, TOcc, TCtx>): Promise<CronOriginFireResult> {
  const { useLegacyLeg, job, project, deliveryContext } = params
  if (!useLegacyLeg) {
    return parseOriginWebchatSessionKey(job.sourceSessionKey || '')
      ? { kind: 'injected' }
      : { kind: 'fallback' }
  }
  const fireJob: TJob = {
    ...job,
    projectMode: project.mode,
    boardProjectId: project.mode === 'fixed' ? project.boardProjectId : null,
  }
  const occForEpoch = params.readOccurrence(deliveryContext.deliveryId)
  const curEpoch =
    typeof occForEpoch?.callbackEpoch === 'number' && occForEpoch.callbackEpoch > 1
      ? Math.floor(occForEpoch.callbackEpoch)
      : 1
  const fireCtx: TCtx = curEpoch > 1 ? { ...deliveryContext, callbackEpoch: curEpoch } : deliveryContext
  const result = await params.onOriginSessionFire(fireJob, fireCtx)
  if (result.kind === 'retryable_failure' && result.code === ORIGIN_MESSAGE_PREVIOUSLY_FAILED_CODE) {
    if (curEpoch >= NOTIFY_MAX_CALLBACK_EPOCH) {
      params.logger.warn(`job ${job.id} origin-session previously_failed epoch cap reached`, {
        jobId: job.id,
        deliveryId: deliveryContext.deliveryId,
        callbackEpoch: curEpoch,
      })
      await params.notifyOriginSessionDropped(job, deliveryContext, 'exhausted')
      return { kind: 'terminal_failure', code: 'ORIGIN_MESSAGE_PREVIOUSLY_FAILED_EXHAUSTED' }
    }
    const nextEpoch = curEpoch + 1
    if (occForEpoch) {
      params.writeOccurrence({ ...occForEpoch, callbackEpoch: nextEpoch, updatedAt: Date.now() })
    }
    params.logger.info(`job ${job.id} origin-session bumped callbackEpoch after previously_failed`, {
      jobId: job.id,
      deliveryId: deliveryContext.deliveryId,
      previousEpoch: curEpoch,
      nextEpoch,
    })
  }
  return result
}
