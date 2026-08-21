import { type CostTotals, formatCostMoneyLine, formatTokenUsage } from '../../lib/taskboard'

export function CostCoverageBlock({
  totals,
  testId = 'cost-coverage',
}: {
  totals: CostTotals
  testId?: string
}) {
  const money = formatCostMoneyLine(totals)
  const warn = totals.coverage === 'partial' || totals.coverage === 'unpriced_only'
  return (
    <div data-testid={testId} data-coverage={totals.coverage} className="flex flex-col gap-1">
      <p data-testid={`${testId}-tokens`} className="text-title font-semibold tabular-nums text-fg">
        {formatTokenUsage(totals.tokensIn, totals.tokensOut)}
      </p>
      {money ? (
        <p
          data-testid={`${testId}-money`}
          className={`text-body ${warn ? 'text-warning' : 'text-muted'}`}
        >
          {money}
        </p>
      ) : (
        <p data-testid={`${testId}-money`} className="text-body text-muted">
          本区间没有可统计的执行记录
        </p>
      )}
      {totals.unknownRunCount > 0 && (
        <p className="text-caption text-faint">另有 {totals.unknownRunCount} 次未记下 token</p>
      )}
    </div>
  )
}
