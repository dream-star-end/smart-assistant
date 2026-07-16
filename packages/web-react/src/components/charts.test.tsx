import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { ChartCard } from './charts'

afterEach(cleanup)

test('ChartCard 保留可视画布，并向读屏提供同源文本数据表', () => {
  render(
    <ChartCard
      title="积分趋势"
      ariaLabel="近 7 天积分趋势"
      dataTable={{
        columns: ['日期', '积分'],
        rows: [['7/16', '1,234 积分']],
      }}
    >
      <canvas data-testid="chart-canvas" />
    </ChartCard>,
  )

  expect(screen.getByTestId('chart-canvas').parentElement).toHaveAttribute('aria-hidden', 'true')
  const table = screen.getByRole('table', { name: '近 7 天积分趋势' })
  expect(within(table).getByRole('columnheader', { name: '日期' })).toBeInTheDocument()
  expect(within(table).getByRole('cell', { name: '1,234 积分' })).toBeInTheDocument()
})
