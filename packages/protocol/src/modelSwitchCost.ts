/** Amounts on this wire are integer fen: 100 fen = one displayed credit. */
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
export interface ModelSwitchCostRange {
  lowFen: string
  expectedFen: string
  highFen: string
}
export interface ModelSwitchCostQuote {
  requestId: string
  targetModel: string
  targetName: string
  sourceModel: string | null
  sourceName: string | null
  contextTokens: number
  contextSource: 'last-call' | 'history-estimate' | 'empty'
  outputTokens: number
  sampleCount: number
  targetCost: ModelSwitchCostRange
  currentCost: ModelSwitchCostRange
  balanceFen: string
  requiresConfirmation: boolean
  canConfirm: boolean
  expiresAt: number
  quoteToken?: string
  consent?: string
}
