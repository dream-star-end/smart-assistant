/**
 * GET /internal/v3/marketplace/sync — container-side hub reconciliation source.
 *
 * The container's mcp-memory calls this (with its container token) to fetch the
 * user's currently-installed, non-revoked marketplace skills (full SKILL.md +
 * artifact_hash). The container then writes/removes its hub/skills/<slug>/SKILL.md
 * accordingly. Pull model = same UID, no master-writes-volume; revoked skills
 * drop out of the list and get removed on the next sync (kill-switch).
 *
 * Auth reuses verifyContainerIdentity — identical to internalSkillEmbed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { type Logger, rootLogger } from '../logging/logger.js'
import {
  listActiveInstalledAgents,
  listActiveInstalledArtifacts,
} from '../marketplace/marketplaceDb.js'
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from './util.js'

export const MARKETPLACE_SYNC_PATH = '/internal/v3/marketplace/sync'

export interface MarketplaceSyncCtx {
  hostUuid: string
  boundIp: string
}

export type MarketplaceSyncHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MarketplaceSyncCtx,
) => Promise<void>

export interface MarketplaceSyncDeps {
  identityRepo: ContainerIdentityRepo
  logger?: Logger
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ...(body as object), requestId }))
}

export function makeMarketplaceSyncHandler(deps: MarketplaceSyncDeps): MarketplaceSyncHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: 'internalMarketplaceSync' })
  return async function handle(req, res, ctx) {
    setSecurityHeaders(res)
    const requestId = ensureRequestId(req)
    res.setHeader(REQUEST_ID_HEADER, requestId)

    let identity: Awaited<ReturnType<typeof verifyContainerIdentity>>
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization)
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log.child({ requestId }).warn('identity_failed', { errcode: err.code })
        sendJson(
          res,
          401,
          { error: { code: 'UNAUTHORIZED', message: 'identity verification failed' } },
          requestId,
        )
        return
      }
      throw err
    }

    try {
      const [skills, agents] = await Promise.all([
        listActiveInstalledArtifacts(identity.userId),
        listActiveInstalledAgents(identity.userId),
      ])
      sendJson(res, 200, { skills, agents }, requestId)
    } catch (err) {
      log
        .child({ requestId, uid: identity.userId })
        .error('marketplace_sync_failed', { err: err as Error })
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'sync failed' } }, requestId)
    }
  }
}
