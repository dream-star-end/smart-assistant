// OCV5-591 media studio — build the browser API deps and the GC tick from config (kept out of
// index.ts). Off unless OC_STUDIO_ENABLED=1; a failed start leaves the feature off instead of
// failing master boot.

import { mkdir, readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

import { makeImage2Runner } from '../billing/image2Run.js'
import { parseImageModelPolicy } from '../billing/imageModels.js'
import type { PreCheckRedis } from '../billing/preCheck.js'
import type { CommercialConfig } from '../config.js'
import { rootLogger } from '../logging/logger.js'
import { resolveMiniMaxMediaKey } from '../minimax/mediaKey.js'
import type { MuseBridgeHub } from '../muse/hub.js'
import { studioAccess } from './access.js'
import { StudioBlobStore } from './blobs.js'
import { STUDIO_GC_INTERVAL_MS, runStudioGc } from './gc.js'
import type { StudioHttpDeps } from './http.js'
import { BUILTIN_ADAPTERS, type BuiltinAdapterDeps } from './providers/adapters/index.js'
import { createProviderRegistry, parseProviderConfig } from './providers/registry.js'
import { StudioStore } from './store.js'

export const STUDIO_DEFAULT_ROOT = '/var/lib/openclaude-v5/studio'

/** Services the built-in media providers ride on; each one missing only disables its provider. */
export interface StudioProviderServices {
  preCheckRedis?: PreCheckRedis
  museHub?: MuseBridgeHub
}

function providerDeps(
  cfg: CommercialConfig,
  pool: Pool,
  services: StudioProviderServices,
  warn: (msg: string) => void,
): BuiltinAdapterDeps {
  const deps: BuiltinAdapterDeps = { pool }
  if (services.preCheckRedis) {
    const policy = parseImageModelPolicy(process.env, warn)
    deps.image2 = {
      enabled: process.env.OC_IMAGE2_ENABLED === 'true',
      policy,
      run: makeImage2Runner({ pool, preCheckRedis: services.preCheckRedis, policy }),
    }
  }
  if (services.museHub) {
    deps.muse = {
      hub: services.museHub,
      prices: {
        image: BigInt(cfg.OC_MUSE_PRICE_IMAGE_CREDITS ?? 0),
        video: BigInt(cfg.OC_MUSE_PRICE_VIDEO_CREDITS ?? 0),
      },
      readFile: (p) => readFile(p),
    }
  }
  // OCV5-589 / D12: the same media key resolution as the container route.
  const mediaKey = resolveMiniMaxMediaKey({
    MINIMAX_MEDIA_KEY_FILE: cfg.MINIMAX_MEDIA_KEY_FILE,
    MINIMAX_TOKEN_PLAN_KEY: cfg.MINIMAX_TOKEN_PLAN_KEY,
  })
  deps.minimax = {
    mediaKey,
    client: { pool, windowCap: cfg.OC_MINIMAX_MEDIA_WINDOW_MAX_CALLS },
  }
  return deps
}

export async function createStudioFromConfig(
  cfg: CommercialConfig,
  pool: Pool,
  services: StudioProviderServices = {},
): Promise<StudioHttpDeps | undefined> {
  const log = rootLogger.child({ subsys: 'mediaStudio' })
  const access = studioAccess(cfg, (msg, meta) => log.warn(msg, meta))
  if (!access.enabled) return undefined
  const root = cfg.OC_STUDIO_ROOT ?? STUDIO_DEFAULT_ROOT
  try {
    await mkdir(root, { recursive: true, mode: 0o750 })
  } catch (err) {
    log.error('studio_root_unavailable', { err: err as Error })
    return undefined
  }
  const blobs = new StudioBlobStore({ pool, root })
  const timer = setInterval(() => {
    void runStudioGc({ pool, blobs })
      .then((out) => {
        if (out.projects + out.takes + out.blobs > 0) log.info('studio_gc', out)
      })
      .catch((err) => log.warn('studio_gc_failed', { err: err as Error }))
  }, STUDIO_GC_INTERVAL_MS)
  timer.unref?.()
  const warn = (msg: string) => log.warn('studio_provider_config', { detail: msg })
  const providers = createProviderRegistry({
    entries: parseProviderConfig(cfg.OC_STUDIO_PROVIDERS, warn),
    factories: BUILTIN_ADAPTERS,
    deps: providerDeps(cfg, pool, services, warn),
    warn,
  })
  return { access, store: new StudioStore(pool), blobs, providers }
}
