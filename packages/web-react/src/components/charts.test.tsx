import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { type ChartTheme, ChartCard, barConfig, lineConfig } from './charts'

afterEach(cleanup)

const theme: ChartTheme = {
  color: () => '#123456',
  palette: ['#1', '#2', '#3', '#4', '#5', '#6'],
  grid: 'rgba(0,0,0,0.06)',
  text: '#666',
  border: '#ddd',
  elevated: '#fff',
  fg: '#000',
  isDark: false,
}

describe('双 y 轴（审计 SET-17：收入与日扣费量级差太多，同轴把支出压成一条线）', () => {
  test('没有序列标 right → 只有一条 y 轴，dataset 全挂 y', () => {
    const cfg = barConfig(theme, {
      labels: ['a', 'b'],
      series: [{ label: '支出', data: [1, 2] }],
    })
    const scales = cfg.options?.scales as Record<string, unknown>
    expect(scales.y).toBeDefined()
    expect(scales.y1).toBeUndefined()
    expect(cfg.data.datasets.map((d) => (d as { yAxisID?: string }).yAxisID)).toEqual(['y'])
  })

  test('标 right 的序列挂到右侧 y1，y1 不画网格；折线图同样支持', () => {
    const cfg = barConfig(theme, {
      labels: ['a', 'b'],
      series: [
        { label: '收入', data: [4_000_000, 0], axis: 'right' },
        { label: '支出', data: [120_000, 90_000] },
      ],
    })
    const scales = cfg.options?.scales as Record<string, { position?: string; grid?: { drawOnChartArea?: boolean } }>
    expect(scales.y1?.position).toBe('right')
    expect(scales.y1?.grid?.drawOnChartArea).toBe(false)
    expect(cfg.data.datasets.map((d) => (d as { yAxisID?: string }).yAxisID)).toEqual(['y1', 'y'])

    const line = lineConfig(theme, {
      labels: ['a'],
      series: [{ label: 'r', data: [1], axis: 'right' }],
    })
    expect((line.options?.scales as Record<string, unknown>).y1).toBeDefined()
    expect(line.data.datasets.map((d) => (d as { yAxisID?: string }).yAxisID)).toEqual(['y1'])
  })
})

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
