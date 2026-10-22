// OCV5-561 Muse media bridge — build the hub and bridge endpoints from config (kept out of
// index.ts). Off unless OC_MUSE_BRIDGE_ENABLED=1; a failed start leaves the feature off instead
// of failing master boot. Selfhost runs a single master, which owns the in-memory hub.

import type { Pool } from 'pg'

import type { CommercialConfig } from '../config.js'
import { rootLogger } from '../logging/logger.js'
import { type MuseBridgeHttpHandler, makeMuseBridgeHttpHandler } from './bridgeHttp.js'
import { MuseBridgeHub } from './hub.js'
import { CLI_TIMEOUT_SEC, parseAllowedUids } from './protocol.js'
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
