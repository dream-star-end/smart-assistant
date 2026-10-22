import { mintAntigravityRelayRoute } from '../billing/antigravityRouteContext.js'
/**
 * Per-turn Antigravity admission on master (OCV5-415 P2): pick a gemini OAuth
 * account, mint the CLI's limited token for it, then mint the relay route
 * bound to that account. The route and limited token travel to the container
 * in the master-owned `__oc_antigravity_route` frame field.
 */
import { antigravityModelCoolingUntil } from './antigravityModelCooldown.js'
import { AntigravityOAuthError, mintAntigravityLimitedToken } from './antigravityOAuth.js'
import { pickAntigravityAccount, reportAntigravityOutcome } from './antigravityPool.js'
import { releaseInflight } from './policy/affinity.js'

export interface AntigravityRouteGrant {
  token: string
  baseUrl: string
  /** openid/userinfo-only access token for the CLI token file. */
  accessToken: string
  accessTokenExpiresAt: string
  idToken: string | null
}

/**
 * Accounts one admission may try when a stored grant turns out to be dead
 * (OCV5-556): a grant revoked while the user was away must not fail the
 * first message back; the dead account is reported and the turn moves on.
 */
export const ANTIGRAVITY_ADMISSION_MAX_ACCOUNTS = 3

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
  const deadGrants = new Set<bigint>()
  let account: Awaited<ReturnType<typeof pickAntigravityAccount>>
  let limited: Awaited<ReturnType<typeof mintAntigravityLimitedToken>>
  for (;;) {
    account = await (deps.pick ?? pickAntigravityAccount)({
      userId: args.userId,
      modelId: args.modelId,
      reserveToken: args.requestId,
      skip: async (accountId) => {
        if (deadGrants.has(accountId)) return true
        // A KV hiccup must not block admission: treat the model as usable.
        const until = await coolingUntil(accountId, args.modelId).catch(() => null)
        if (until !== null) cooled = true
        return until !== null
      },
    })
    if (!account) {
      if (deadGrants.size > 0) throw new AntigravityAdmissionError('ANTIGRAVITY_AUTH_UNAVAILABLE')
      throw new AntigravityAdmissionError(
        cooled ? 'ANTIGRAVITY_MODEL_COOLING_DOWN' : 'ANTIGRAVITY_NO_ACCOUNT',
      )
    }
    try {
      limited = await (deps.mintLimited ?? mintAntigravityLimitedToken)(account.accountId, {
        clientSecret: deps.clientSecret,
        onAuthFailure: async (id, err) => {
          await reportAntigravityOutcome(id, { kind: 'auth_invalid' }, err.message)
        },
      })
      break
    } catch (err) {
      // Not admitted: give back the in-flight unit the pick reserved for this turn.
      releaseInflight(args.requestId)
      // Only this account's grant is dead (reported above): try another one.
      // invalid_client is the shared OAuth client, so every account would fail.
      const accountGrantDead =
        err instanceof AntigravityOAuthError && err.authInvalid && err.oauthCode !== 'invalid_client'
      if (!accountGrantDead || deadGrants.size + 1 >= ANTIGRAVITY_ADMISSION_MAX_ACCOUNTS) {
        throw new AntigravityAdmissionError('ANTIGRAVITY_AUTH_UNAVAILABLE')
      }
      deadGrants.add(account.accountId)
    }
  }
  let route: Awaited<ReturnType<typeof mintAntigravityRelayRoute>>
  try {
    route = await (deps.mintRoute ?? mintAntigravityRelayRoute)({
      containerId: args.containerId,
      userId: args.userId,
      requestId: args.requestId,
      modelId: args.modelId,
      accountId: account.accountId,
      budgetCredits: args.budgetCredits,
      relayPort: args.relayPort,
    })
  } catch (err) {
    releaseInflight(args.requestId)
    throw err
  }
  return {
    token: route.token,
    baseUrl: route.baseUrl,
    accessToken: limited.accessToken,
    accessTokenExpiresAt: limited.expiresAt.toISOString(),
    idToken: limited.idToken,
  }
}
