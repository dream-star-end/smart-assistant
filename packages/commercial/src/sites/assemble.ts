import type { Pool } from 'pg'
import type { CommercialConfig } from '../config.js'
import { createHttpSitesEdgeClient } from './edgeClient.js'
import { createPgSitesRepo } from './repo.js'
import { SitesService } from './service.js'

export function createSitesFromConfig(cfg: CommercialConfig, pool: Pool): SitesService {
  const enabled = Boolean(cfg.OC_SITES_ENABLED && cfg.OC_SITES_EDGE_PUSH_URL && cfg.OC_SITES_EDGE_SECRET)
  return new SitesService({
    enabled,
    baseDomain: cfg.OC_SITES_BASE_DOMAIN,
    maxPerUser: cfg.OC_SITES_MAX_PER_USER,
    maxSiteBytes: cfg.OC_SITES_MAX_SITE_BYTES,
    edgeSecret: cfg.OC_SITES_EDGE_SECRET ?? undefined,
    repo: enabled ? createPgSitesRepo(pool) : undefined,
    edge:
      enabled && cfg.OC_SITES_EDGE_PUSH_URL && cfg.OC_SITES_EDGE_SECRET
        ? createHttpSitesEdgeClient({
            baseUrl: cfg.OC_SITES_EDGE_PUSH_URL,
            secret: cfg.OC_SITES_EDGE_SECRET,
          })
        : undefined,
  })
}
