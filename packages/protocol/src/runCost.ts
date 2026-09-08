/** Recorded reference costs, NOT platform settlement evidence. */
export type RunCostClass = 'estimated' | 'unflagged' | 'unverified' | 'unpriced' | 'unknown'
export interface RecordedCostSlice {
  runCount: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}
export interface RecordedCostAmounts {
  estimated: RecordedCostSlice
  unflagged: RecordedCostSlice
  unverified: RecordedCostSlice
}
export const RECORDED_COST_LABELS = {
  estimated: '估算', unflagged: '未标估算', unverified: '来源未证实',
  unpriced: '有用量但无金额', unknown: '费用未记录',
} as const

/** Shared by run details, all aggregation buckets and reports. Missing flags stay unknown. */
export function classifyRecordedRunCost(
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  costUsd: number | null | undefined,
  costImprecise?: boolean | number | null,
): RunCostClass {
  if ((tokensIn ?? 0) + (tokensOut ?? 0) > 0 && (costUsd == null || costUsd === 0)) return 'unpriced'
  if (costUsd == null) return 'unknown'
  if (costImprecise === true || costImprecise === 1) return 'estimated'
  if (costImprecise === false || costImprecise === 0) return 'unflagged'
  return 'unverified'
}

/** Old servers without the composition field must never be labelled exact. */
export function formatRecordedCostTotal(costUsd: number, amounts?: RecordedCostAmounts): string {
  const parts = amounts
    ? (['estimated', 'unflagged', 'unverified'] as const)
      .filter(k => amounts[k].runCount > 0)
      .map(k => `${RECORDED_COST_LABELS[k]} $${amounts[k].costUsd.toFixed(4)}`)
    : ['来源未证实']
  return `参考费用 $${costUsd.toFixed(4)}${parts.length ? `（${parts.join('；')}）` : ''}`
}
