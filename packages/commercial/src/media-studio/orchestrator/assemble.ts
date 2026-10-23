// OCV5-591 A2-1a — start the director agent for an enabled studio: the worker on this slot, the
// user-action API on the browser routes. Off with the studio (OC_STUDIO_ENABLED); a missing planner
// (no Grok runner) leaves projects in planning with a clear event instead of failing boot.

import type { Pool } from 'pg'

import type { CommercialConfig } from '../../config.js'
import type { GrokRunner } from '../../grok/visionProxy.js'
import { rootLogger } from '../../logging/logger.js'
import { fetchSystemVoices } from '../../minimax/mediaClient.js'
import { resolveMiniMaxMediaKey } from '../../minimax/mediaKey.js'
import { SystemVoiceCache } from '../../minimax/voices.js'
import type { MuseBridgeHub } from '../../muse/hub.js'
import type { StudioHttpDeps } from '../http.js'
import type { PlanVoice } from './plan.js'
import { makeOrchestratorApi } from './service.js'
import { StudioWorker } from './worker.js'

export function startStudioOrchestrator(input: {
  cfg: CommercialConfig
  pool: Pool
  studio: StudioHttpDeps
  grok?: GrokRunner
  museHub?: MuseBridgeHub
}): { stop: () => Promise<void> } | undefined {
  const { studio } = input
  if (!studio.providers) return undefined
  const log = rootLogger.child({ subsys: 'studioOrchestrator' })
  const key = resolveMiniMaxMediaKey({
    MINIMAX_MEDIA_KEY_FILE: input.cfg.MINIMAX_MEDIA_KEY_FILE,
    MINIMAX_TOKEN_PLAN_KEY: input.cfg.MINIMAX_TOKEN_PLAN_KEY,
  }).key
  const voices = new SystemVoiceCache(async () => {
    if (!key) throw new Error('minimax media key missing')
    return await fetchSystemVoices(fetch, key)
  })
  const worker = new StudioWorker({
    pool: input.pool,
    blobs: studio.blobs,
    providers: studio.providers,
    grok: input.grok,
    systemVoices: async (): Promise<PlanVoice[]> =>
      ((await voices.get()) ?? []).map((v) => ({
        voiceId: v.voiceId,
        name: v.voiceName,
        description: v.description,
      })),
    museOnline: () => input.museHub?.bridgeOnline() ?? false,
    log,
    slot: process.env.OC_SLOT?.trim() || 'A',
  })
  studio.orchestrator = makeOrchestratorApi(
    input.pool,
    (projectId) => void worker.advance(projectId),
    {
      pool: input.pool,
      providers: studio.providers,
    },
  )
  worker.start()
  log.info('studio_orchestrator_started', {
    owner: worker.owner,
    planner: input.grok ? 'grok' : 'missing',
  })
  return { stop: () => worker.stop() }
}
