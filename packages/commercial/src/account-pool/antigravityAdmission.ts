import { mintAntigravityRelayRoute } from '../billing/antigravityRouteContext.js'
/**
 * Per-turn Antigravity admission on master (OCV5-415 P2): pick a gemini OAuth
 * account, mint the CLI's limited token for it, then mint the relay route
 * bound to that account. The route and limited token travel to the container
 * in the master-owned `__oc_antigravity_route` frame field.
 */
import { antigravityModelCoolingUntil } from './antigravityModelCooldown.js'
import { mintAntigravityLimitedToken } from './antigravityOAuth.js'
import { pickAntigravityAccount, reportAntigravityOutcome } from './antigravityPoolInterim.js'

export interface AntigravityRouteGrant {
  token: string
  baseUrl: string
  /** openid/userinfo-only access token for the CLI token file. */
  accessToken: string
  accessTokenExpiresAt: string
  idToken: string | null
}

export class AntigravityAdmissionError extends Error {
  readonly code:
    | 'ANTIGRAVITY_NOT_CONFIGURED'
    | 'ANTIGRAVITY_NO_ACCOUNT'
    | 'ANTIGRAVITY_MODEL_COOLING_DOWN'
    | 'ANTIGRAVITY_AUTH_UNAVAILABLE'
  constructor(code: AntigravityAdmissionError['code']) {
    super(code)
    this.name = 'AntigravityAdmissionError'
    this.code = code
  }
}

export async function admitAntigravityTurn(
  args: {
    containerId: number
    userId: bigint
    requestId: string
    modelId: string
    budgetCredits: bigint
    relayPort: number
  },
  deps: {
    clientSecret: string
    pick?: typeof pickAntigravityAccount
    modelCoolingUntil?: typeof antigravityModelCoolingUntil
    mintLimited?: typeof mintAntigravityLimitedToken
    mintRoute?: typeof mintAntigravityRelayRoute
  },
): Promise<AntigravityRouteGrant> {
  if (!deps.clientSecret) throw new AntigravityAdmissionError('ANTIGRAVITY_NOT_CONFIGURED')
  let cooled = false
  const coolingUntil = deps.modelCoolingUntil ?? antigravityModelCoolingUntil
  const account = await (deps.pick ?? pickAntigravityAccount)({
    skip: async (accountId) => {
      // A KV hiccup must not block admission: treat the model as usable.
      const until = await coolingUntil(accountId, args.modelId).catch(() => null)
      if (until !== null) cooled = true
      return until !== null
    },
  })
  if (!account) {
    throw new AntigravityAdmissionError(
      cooled ? 'ANTIGRAVITY_MODEL_COOLING_DOWN' : 'ANTIGRAVITY_NO_ACCOUNT',
    )
  }
  let limited: Awaited<ReturnType<typeof mintAntigravityLimitedToken>>
  try {
    limited = await (deps.mintLimited ?? mintAntigravityLimitedToken)(account.accountId, {
      clientSecret: deps.clientSecret,
      onAuthFailure: async (id, err) => {
        await reportAntigravityOutcome(id, { kind: 'auth_invalid' }, err.message)
      },
    })
  } catch {
    throw new AntigravityAdmissionError('ANTIGRAVITY_AUTH_UNAVAILABLE')
  }
  const route = await (deps.mintRoute ?? mintAntigravityRelayRoute)({
    containerId: args.containerId,
    userId: args.userId,
    requestId: args.requestId,
    modelId: args.modelId,
    accountId: account.accountId,
    budgetCredits: args.budgetCredits,
    relayPort: args.relayPort,
  })
  return {
    token: route.token,
    baseUrl: route.baseUrl,
    accessToken: limited.accessToken,
    accessTokenExpiresAt: limited.expiresAt.toISOString(),
    idToken: limited.idToken,
  }
}
