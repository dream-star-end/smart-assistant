import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import { type CostTotals, taskboardApi } from '../../lib/taskboard'
import { ToastProvider, TooltipProvider } from '../ui'
import { BoardSettingsPanel } from './BoardSettingsPanel'
import { CostCoverageBlock } from './CostCoverageBlock'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const empty = { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }

test('old full coverage with only unknown rows is not a recorded zero', () => {
  const totals: CostTotals = { ...empty, runCount: 1, coverage: 'full', priced: empty, unpriced: empty, unknownRunCount: 1 }
  render(<CostCoverageBlock totals={totals} />)
  expect(screen.getByTestId('cost-coverage-money')).toHaveTextContent('未记录')
  expect(screen.getByTestId('cost-coverage-money')).not.toHaveTextContent('$0')
})

test('a real recorded zero remains distinguishable from empty aggregate', () => {
  const totals: CostTotals = { ...empty, runCount: 1, coverage: 'full', priced: { ...empty, runCount: 1 }, unpriced: empty, unknownRunCount: 0 }
  render(<CostCoverageBlock totals={totals} />)
  expect(screen.getByTestId('cost-coverage-money')).toHaveTextContent('$0.0000（来源未证实）')
})

test.each([0, 2])('old settings retain unpriced information at total %s', async (amount) => {
  vi.spyOn(taskboardApi, 'getSettings').mockResolvedValue({ maxConcurrentRuns: 2, maxRunsPerDay: 200, maxCostPerDayUsd: null, quietHoursStart: 23, quietHoursEnd: 8, circuitBreakerThreshold: 3, maxStageLoops: 5, maxRunsPerTick: 2, patrolPaused: false, usage: { runsToday: 2, costTodayUsd: amount, activeRuns: 0, unpricedRunsToday: 1 } })
  const auth = createMemoryAuthSession(() => {}, 'cost-test')
  render(<ToastProvider><TooltipProvider><BoardSettingsPanel auth={auth} /></TooltipProvider></ToastProvider>)
  fireEvent.click(screen.getByTestId('board-settings-open'))
  const line = await screen.findByText(/今天已跑/)
  expect(line).toHaveTextContent('1 次有用量但无金额')
  if (amount === 0) expect(line).not.toHaveTextContent('$0')
  else expect(line).toHaveTextContent('参考费用 $2.0000（来源未证实）')
})
