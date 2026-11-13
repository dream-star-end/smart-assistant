/** Public data contracts. Executable arguments and approval grants never come from model UI JSON. */
export const SYSTEM_ACTION_STATES = [
  'prepared', 'approved_waiting_browser', 'executing',
  'succeeded', 'failed', 'denied', 'expired', 'unknown',
] as const
export type SystemActionState = (typeof SYSTEM_ACTION_STATES)[number]
export type SystemActionExecutor = 'master' | 'control' | 'browser'
export interface SystemActionField { label: string; value: string }
export interface SystemActionPrice {
  kind: 'none' | 'fixed' | 'usage'
  label: string
  /** Integer minor units, never a floating point quote. 100 fen = 1 CNY/credit. */
  amountFen?: string
  unit?: 'CNY' | 'credits'
  rates?: SystemActionField[]
  note?: string
}
export interface SystemActionPreview {
  title: string
  description: string
  scope: string
  before: SystemActionField[]
  after: SystemActionField[]
  consequences: string[]
  price: SystemActionPrice
  destructive: boolean
}
export interface SystemActionResult {
  summary: string
  /** Creating an order/job/authorization is not the same as paying/completing it. */
  completion: 'done' | 'accepted' | 'awaiting_user'
  effectReference?: string
  code?: string
}
export interface SystemActionSummary {
  id: string
  operationId: string
  title: string
  state: SystemActionState
  executor: SystemActionExecutor
  createdAt: number
  expiresAt: number
  updatedAt: number
  result: SystemActionResult | null
}
export interface SystemActionDetail extends SystemActionSummary {
  preview: SystemActionPreview | null
  previewHash: string
}
export interface SystemActionReference { type: 'system_action'; proposalId: string }

/** Privileged references do not use the content renderer's JSON repair/coercion. */
export function parseSystemActionReference(raw: string, complete = true): SystemActionReference | null {
  if (!complete || raw.length > 4096) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const v = value as Record<string, unknown>
    if (Object.keys(v).length !== 2 || v.type !== 'system_action' || typeof v.proposalId !== 'string') return null
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.proposalId)) return null
    return { type: 'system_action', proposalId: v.proposalId }
  } catch { return null }
}
