import { type CostTotals, formatCostMoneyLine, formatTokenUsage } from '../../lib/taskboard'

export function CostCoverageBlock({
  totals,
  testId = 'cost-coverage',
}: {
  totals: CostTotals
  testId?: string
}) {
  const money = formatCostMoneyLine(totals)
  const warn = totals.coverage === 'partial' || totals.coverage === 'unpriced_only' ||
    !totals.amounts || totals.amounts.estimated.runCount > 0 || totals.amounts.unverified.runCount > 0
  return (
    <div data-testid={testId} data-coverage={totals.coverage} className="flex flex-col gap-2">
      <p
        data-testid={`${testId}-tokens`}
        className="text-title font-semibold tracking-tight tabular-nums text-fg"
      >
        {formatTokenUsage(totals.tokensIn, totals.tokensOut)}
      </p>
      {money ? (
        <p
          data-testid={`${testId}-money`}
          className={
            warn
              ? 'oc-callout oc-callout-warning rounded-lg px-3 py-1.5 text-body text-warning'
              : 'text-body tabular-nums text-muted'
          }
        >
          {money}
        </p>
      ) : (
        <p
          data-testid={`${testId}-money`}
          className="oc-surface-recessed rounded-lg px-3 py-1.5 text-body text-muted"
        >
          本区间没有可统计的执行记录
        </p>
      )}
      {totals.unknownRunCount > 0 && (
        <p className="text-caption tabular-nums text-faint">
          另有 {totals.unknownRunCount} 次未记下 token
        </p>
      )}
    </div>
  )
}
