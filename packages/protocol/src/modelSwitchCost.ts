/** Values use the existing chat/ledger unit, displayed 1:1 as 积分. */
export interface ModelSwitchCostRequest {
  sessionId: string
  requestId: string
  targetModel: string
  agentId: string
  teamMode?: boolean
  contextTier?: '300k' | '1m'
  serviceTier?: 'fast'
  text?: string
  mediaCount?: number
}
export interface ModelSwitchCostAuthorization { requestId: string; consent?: string }
export interface ModelSwitchCostRange { lowCredits: string; expectedCredits: string; highCredits: string }
export interface ModelSwitchUnitPrice {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}
export interface ModelSwitchCostQuote {
  mode: 'exempt' | 'estimate' | 'risk'
  requestId: string
  targetModel: string
  targetName: string
  sourceModel: string | null
  sourceName: string | null
  contextTokens: number | null
  contextSource: 'last-call' | 'unknown' | 'empty' | 'unchanged'
  outputTokens: number | null
  sampleCount: number
  targetCost: ModelSwitchCostRange | null
  currentCost: ModelSwitchCostRange | null
  /** Effective prices per million tokens, including current multipliers. */
  targetUnitPrice: ModelSwitchUnitPrice | null
  balanceCredits: string | null
  requiresConfirmation: boolean
  canConfirm: boolean
  expiresAt: number
  quoteToken?: string
  consent?: string
}
