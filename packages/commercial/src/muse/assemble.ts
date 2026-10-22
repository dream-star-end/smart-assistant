// OCV5-561 Muse media bridge — build the hub and bridge endpoints from config (kept out of
// index.ts). Off unless OC_MUSE_BRIDGE_ENABLED=1; a failed start leaves the feature off instead
// of failing master boot. Each master process owns its in-memory hub; commercial (OCV5-574) adds
// concurrency, per-account caps, credits and an orphan grace for its A/B slots, all from config.

import type { Pool } from 'pg'

import type { CommercialConfig } from '../config.js'
import { rootLogger } from '../logging/logger.js'
import { createMuseBilling } from './billing.js'
import { type MuseBridgeHttpHandler, makeMuseBridgeHttpHandler } from './bridgeHttp.js'
import { MuseBridgeHub } from './hub.js'
import { CLI_TIMEOUT_SEC, MAX_CONCURRENCY, QUEUE_WAIT_MS, parseAllowedUids } from './protocol.js'
import { startMusePublicFromConfig } from './publicListener.js'
import { createPgMuseStore } from './store.js'

export const MUSE_DEFAULT_STATE_ROOT = '/var/lib/openclaude-v5-selfhost/muse-media'

export async function createMuseFromConfig(
  cfg: CommercialConfig,
  pool: Pool,
): Promise<{
  hub?: MuseBridgeHub
  bridgeHttp?: MuseBridgeHttpHandler
  closePublic?: () => Promise<void>
}> {
  if (!cfg.OC_MUSE_BRIDGE_ENABLED) return {}
  const store = createPgMuseStore(pool)
  const prices = {
    image: cfg.OC_MUSE_PRICE_IMAGE_CREDITS ?? 0,
    video: cfg.OC_MUSE_PRICE_VIDEO_CREDITS ?? 0,
  }
  const queueWait = (sec: number | undefined) => (sec === undefined ? QUEUE_WAIT_MS : sec * 1000)
  const hub = new MuseBridgeHub({
    store,
    stateRoot: cfg.OC_MUSE_STATE_ROOT ?? MUSE_DEFAULT_STATE_ROOT,
    allowedUids: parseAllowedUids(cfg.OC_MUSE_ALLOWED_UIDS, (msg, meta) =>
      rootLogger.warn(msg, meta),
    ),
    rate: {
      imagePerHour: cfg.OC_MUSE_IMAGE_PER_HOUR ?? 30,
      imagePerDay: cfg.OC_MUSE_IMAGE_PER_DAY ?? 200,
      videoPerHour: cfg.OC_MUSE_VIDEO_PER_HOUR ?? 10,
      videoPerDay: cfg.OC_MUSE_VIDEO_PER_DAY ?? 40,
    },
    cliTimeoutSec: CLI_TIMEOUT_SEC,
    concurrency: Math.min(cfg.OC_MUSE_CONCURRENCY ?? 1, MAX_CONCURRENCY),
    ...(cfg.OC_MUSE_QUEUE_MAX !== undefined ? { queueMax: cfg.OC_MUSE_QUEUE_MAX } : {}),
    queueWaitMs: {
      image: queueWait(cfg.OC_MUSE_QUEUE_WAIT_IMAGE_SEC),
      video: queueWait(cfg.OC_MUSE_QUEUE_WAIT_VIDEO_SEC),
    },
    ...(cfg.OC_MUSE_USER_INFLIGHT_MAX !== undefined
      ? { userInflightMax: cfg.OC_MUSE_USER_INFLIGHT_MAX }
      : {}),
    ...(cfg.OC_MUSE_USER_RUNNING_MAX !== undefined
      ? { userRunningMax: cfg.OC_MUSE_USER_RUNNING_MAX }
      : {}),
    globalPerDay: {
      ...(cfg.OC_MUSE_GLOBAL_IMAGE_PER_DAY !== undefined
        ? { image: cfg.OC_MUSE_GLOBAL_IMAGE_PER_DAY }
        : {}),
      ...(cfg.OC_MUSE_GLOBAL_VIDEO_PER_DAY !== undefined
        ? { video: cfg.OC_MUSE_GLOBAL_VIDEO_PER_DAY }
        : {}),
    },
    ...(prices.image > 0 || prices.video > 0 ? { billing: createMuseBilling(pool, prices) } : {}),
    orphanGraceMs: (cfg.OC_MUSE_ORPHAN_GRACE_SEC ?? 0) * 1000,
  })
  try {
    await hub.start()
  } catch (err) {
    rootLogger.error('muse_bridge_start_failed', { err: (err as Error).message })
    return {}
  }
  const bridgeHttp = makeMuseBridgeHttpHandler({ hub, store })
  // Optional direct HTTPS entrance that bypasses the Cloudflare tunnel (OC_MUSE_PUBLIC_PORT).
  return { hub, bridgeHttp, closePublic: startMusePublicFromConfig(cfg, bridgeHttp) }
}
