/**
 * Advisor-consult admit route metadata. Master selects via the same
 * createCommercialCodexRoute authority as WS, then strips hardcoded
 * loopback ports so the container gateway fills its real listen port.
 */

const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const GROUP_ID_RE = /^[0-9]{1,20}$/
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type AdvisorCodexAdmitRoute =
  | { kind: 'official_oauth'; groupId: string }
  | {
      kind: 'api_relay'
      token: string
      modelProvider: string
      providerName: string | null
      wireApi: 'responses' | 'chat' | null
      preferredAuthMethod: 'apikey' | 'chatgpt' | null
      disableResponseStorage: boolean | null
    }
  | { kind: 'unavailable'; reason: string }

export interface AdvisorCodexBindingRow {
  codexAccountId: bigint | null
  userId: bigint
  state: string
  provider: string | null
  accountStatus: string | null
}

export type AdvisorCodexSelectorDecision =
  | { kind: 'official_oauth'; groupId: string }
  | {
      kind: 'api_relay'
      token: string
      modelProvider: string
      providerName?: string | null
      wireApi?: string | null
      preferredAuthMethod?: string | null
      disableResponseStorage?: boolean | null
      engine?: string
    }
  | { kind: 'unavailable'; reason?: string }
  | { kind: string; [key: string]: unknown }
  | null
  | undefined

export function projectAdvisorAdmitRoute(
  decision: AdvisorCodexSelectorDecision,
): AdvisorCodexAdmitRoute {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { kind: 'unavailable', reason: 'no_usable_codex_group' }
  }
  if (decision.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: typeof decision.reason === 'string' && decision.reason ? decision.reason : 'no_usable_codex_group',
    }
  }
  if (decision.kind === 'official_oauth') {
    const groupId = typeof decision.groupId === 'string' ? decision.groupId : ''
    if (!GROUP_ID_RE.test(groupId)) {
      return { kind: 'unavailable', reason: 'invalid_official_group' }
    }
    return { kind: 'official_oauth', groupId }
  }
  if (decision.kind === 'api_relay') {
    if (decision.engine !== undefined && decision.engine !== 'codex') {
      return { kind: 'unavailable', reason: 'unsupported_engine' }
    }
    const token = typeof decision.token === 'string' ? decision.token : ''
    const modelProvider = typeof decision.modelProvider === 'string' ? decision.modelProvider : ''
    if (!ROUTE_TOKEN_RE.test(token) || !PROVIDER_ID_RE.test(modelProvider)) {
      return { kind: 'unavailable', reason: 'invalid_api_relay' }
    }
    const wireApi = decision.wireApi === 'responses' || decision.wireApi === 'chat' ? decision.wireApi : null
    const preferredAuthMethod =
      decision.preferredAuthMethod === 'apikey' || decision.preferredAuthMethod === 'chatgpt'
        ? decision.preferredAuthMethod
        : null
    return {
      kind: 'api_relay',
      token,
      modelProvider,
      providerName: typeof decision.providerName === 'string' ? decision.providerName : null,
      wireApi,
      preferredAuthMethod,
      disableResponseStorage:
        typeof decision.disableResponseStorage === 'boolean' ? decision.disableResponseStorage : null,
    }
  }
  return { kind: 'unavailable', reason: 'unknown_kind' }
}

export function bindingAllowsOfficialOAuth(
  binding: AdvisorCodexBindingRow | null,
  userId: bigint,
): boolean {
  if (!binding) return false
  if (binding.userId !== userId) return false
  if (binding.state !== 'active') return false
  if (binding.provider !== 'codex') return false
  if (binding.accountStatus !== 'active') return false
  return binding.codexAccountId !== null
}

export async function selectAdvisorCodexAdmitRoute(args: {
  containerId: number
  userId: bigint
  modelId: string
  createRoute: (input: {
    containerId: number
    userId: bigint
    modelId: string
  }) => Promise<AdvisorCodexSelectorDecision>
  readBinding: (containerId: number) => Promise<AdvisorCodexBindingRow | null>
}): Promise<AdvisorCodexAdmitRoute> {
  const decision = await args.createRoute({
    containerId: args.containerId,
    userId: args.userId,
    modelId: args.modelId,
  })
  const projected = projectAdvisorAdmitRoute(decision)
  if (projected.kind !== 'official_oauth') return projected
  const binding = await args.readBinding(args.containerId)
  if (!bindingAllowsOfficialOAuth(binding, args.userId)) {
    return { kind: 'unavailable', reason: 'no_bound_codex_account' }
  }
  return projected
}
