/**
 * antigravityRouteRuntime — Antigravity route store / relay / delegate-route /
 * bridge-hook assembly shared by master (`index.ts`) and egress (`egress/main.ts`).
 */

import type Redis from 'ioredis'
import type { Pool } from 'pg'

import { admitAntigravityTurn } from '../account-pool/antigravityAdmission.js'
import {
  configureAntigravityModelCooldownStore,
  createIoredisAntigravityModelCooldownStore,
} from '../account-pool/antigravityModelCooldown.js'
import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { readAntigravityRouteAuthority } from '../billing/antigravityRouteAuthority.js'
import {
  configureAntigravityRelayAuthority,
  configureAntigravityRelayKv,
  createIoredisAntigravityRelayKv,
  expireAntigravityRelayRoute,
  expireAntigravityRelayRouteForRequest,
} from '../billing/antigravityRouteContext.js'
import type { PricingCache } from '../billing/pricing.js'
import type { Logger } from '../logging/logger.js'
import {
  type AntigravityRelayHandler,
  makeAntigravityRelayHandler,
} from './internalAntigravityRelay.js'
import {
  type DelegateAntigravityRouteHandler,
  makeDelegateAntigravityRouteHandler,
} from './internalDelegateAntigravityRoute.js'

/** Configure process-wide Redis KV, PG authority, and model cooldown stores for Antigravity routing. */
export function configureAntigravityRouteStores(deps: {
  redis: Redis
  pool: Pick<Pool, 'query'>
}): void {
  configureAntigravityRelayKv(createIoredisAntigravityRelayKv(deps.redis))
  configureAntigravityRelayAuthority((route) => readAntigravityRouteAuthority(deps.pool, route))
  configureAntigravityModelCooldownStore(createIoredisAntigravityModelCooldownStore(deps.redis))
}

export interface AntigravityRouteRuntimeDeps {
  identityRepo: ContainerIdentityRepo
  pool: Pick<Pool, 'query'>
  relayPort: number
  clientSecret: string
  readBalance: (userId: bigint) => Promise<bigint>
  rootLogger: Logger
  pricing: PricingCache
}

export interface AntigravityRouteRuntime {
  relayHandler: AntigravityRelayHandler
  makeDelegateHandler: () => DelegateAntigravityRouteHandler
}

/** Assemble master-side Antigravity relay and delegate-route HTTP handlers. */
export function createAntigravityRouteRuntime(
  deps: AntigravityRouteRuntimeDeps,
): AntigravityRouteRuntime {
  const relayHandler = makeAntigravityRelayHandler({
    identityRepo: deps.identityRepo,
    logger: deps.rootLogger.child({ subsys: 'antigravityRelay' }),
    clientSecret: deps.clientSecret,
    pricing: deps.pricing,
  })
  return {
    relayHandler,
    makeDelegateHandler: () =>
      makeDelegateAntigravityRouteHandler({
        identityRepo: deps.identityRepo,
        pool: deps.pool,
        relayPort: deps.relayPort,
        clientSecret: deps.clientSecret,
        readBalance: deps.readBalance,
        logger: deps.rootLogger.child({ subsys: 'delegateAntigravityRoute' }),
      }),
  }
}

/** Build UserChatBridge Antigravity admission and route-expiry lifecycle hooks. */
export function createAntigravityBridgeHooks(deps: {
  relayPort: number
  clientSecret: string
}): {
  admitAntigravityTurn: (args: {
    containerId: number
    userId: bigint
    requestId: string
    modelId: string
    budgetCredits: bigint
  }) => ReturnType<typeof admitAntigravityTurn>
  expireAntigravityRoute: (token: string) => Promise<void>
  expireAntigravityRouteForRequest: (requestId: string) => Promise<void>
} {
  return {
    admitAntigravityTurn: ({ containerId, userId, requestId, modelId, budgetCredits }) =>
      admitAntigravityTurn(
        {
          containerId,
          userId,
          requestId,
          modelId,
          budgetCredits,
          relayPort: deps.relayPort,
        },
        { clientSecret: deps.clientSecret },
      ),
    expireAntigravityRoute: async (token) => {
      await expireAntigravityRelayRoute(token)
    },
    expireAntigravityRouteForRequest: async (requestId) => {
      await expireAntigravityRelayRouteForRequest(requestId)
    },
  }
}
