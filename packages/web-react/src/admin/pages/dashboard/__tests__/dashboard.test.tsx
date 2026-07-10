import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ToastProvider, TooltipProvider } from '../../../../components/ui'

// 镜像 admin/main.tsx 的根 Provider 树（TimeAgo 依赖 TooltipProvider）。
function renderPage(node: ReactNode) {
  return render(
    <ToastProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ToastProvider>,
  )
}

// chart.js 走 canvas，jsdom 无 2d context —— 用轻量桩替掉，避免 useChart 抛错。
vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
  },
}))

// 数据层：按 path 返回 fixture（相对本测试文件解析到同一 src/admin/lib/adminApi 模块）。
vi.mock('../../../lib/adminApi', () => ({
  ApiError: class ApiError extends Error {},
  adminGet: vi.fn(),
  adminSend: vi.fn(),
  adminText: vi.fn(),
}))

import { adminGet } from '../../../lib/adminApi'
import DashboardPage from '../index'

const days14 = (fn: (i: number) => Record<string, unknown>) =>
  Array.from({ length: 14 }, (_, i) => fn(i))

function installFixtures() {
  ;(adminGet as unknown as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
    switch (path) {
      case '/stats/dau':
        return Promise.resolve({
          active_users: 120,
          new_users: 8,
          paying_users: 3,
          returning_users: 40,
        })
      case '/stats/revenue-by-day':
        return Promise.resolve({
          rows: days14((i) => ({
            day: `2026-06-${String(i + 1).padStart(2, '0')}`,
            paid_amount_cents: '12000',
            new_subscriptions: 2,
            orders_paid: 3,
          })),
        })
      case '/stats/signups-by-day':
        return Promise.resolve({
          rows: days14((i) => ({
            day: `2026-06-${String(i + 1).padStart(2, '0')}`,
            signups: 5,
            verified: 4,
          })),
        })
      case '/stats/request-series':
        return Promise.resolve({
          rows: Array.from({ length: 24 }, (_, i) => ({
            hour: `2026-07-10 ${String(i).padStart(2, '0')}:00`,
            success: 100,
            error: 2,
            total: 102,
            users: 30,
            tokens: '5000',
          })),
        })
      case '/stats/account-pool':
        return Promise.resolve({
          total: 10,
          active: 8,
          cooldown: 1,
          disabled: 1,
          banned: 0,
          avg_health: 92,
          today_requests: 500,
          today_success_rate: 0.98,
        })
      case '/stats/hosts-utilization':
        return Promise.resolve({
          used: 12,
          capacity: 20,
          per_host: [
            { uuid: 'h1', name: 'host-1', active: 6, max: 10, status: 'active' },
            { uuid: 'h2', name: 'host-2', active: 6, max: 10, status: 'active' },
          ],
        })
      case '/stats/alert-events-7d':
        return Promise.resolve({
          rows: [{ day: '2026-07-09', event_type: 'billing.failed', count: 3 }],
        })
      case '/stats/alerts-summary':
        return Promise.resolve({
          rules: {
            firing: 1,
            normal: 9,
            recent_firing: [{ rule_id: 'pg_idle_in_tx', fired_at: '2026-07-10T02:00:00.000Z' }],
          },
          outbox: { pending: 2, failed: 0, sent_24h: 5, oldest_pending_age_sec: 30 },
          events_24h_by_severity: { critical: 1, warning: 2, info: 4 },
        })
      case '/stats/lifetime':
        return Promise.resolve({
          total_users: 5000,
          total_paying_users: 300,
          total_revenue_cents: '1234500',
          total_orders_paid: 420,
          total_requests: '1500000',
          total_tokens: '9000000000',
          first_paid_at: '2026-01-01T00:00:00.000Z',
          days_in_operation: 190,
        })
      default:
        return Promise.reject(new Error(`unexpected path ${path}`))
    }
  })
}

beforeEach(() => {
  window.location.hash = ''
  installFixtures()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DashboardPage', () => {
  test('渲染 KPI / 累计 / 告警摘要（各端点 fixture）', async () => {
    renderPage(<DashboardPage />)
    // 每日 KPI
    expect(await screen.findByText('活跃用户 DAU')).toBeTruthy()
    expect(await screen.findByText('120')).toBeTruthy() // active_users
    expect(screen.getByText('7 天营收')).toBeTruthy()
    // 账号池可用 8 / 10
    expect(screen.getByText('8 / 10')).toBeTruthy()
    // 累计卡
    expect(await screen.findByText('累计用户')).toBeTruthy()
    expect(screen.getByText('5,000')).toBeTruthy()
    // 告警摘要
    expect(screen.getByText('告警摘要')).toBeTruthy()
    expect(await screen.findByText('触发中规则')).toBeTruthy()
    expect(screen.getByText('pg_idle_in_tx')).toBeTruthy()
  })

  test('点击「账号池可用」KPI → 深链 #tab=accounts', async () => {
    renderPage(<DashboardPage />)
    const card = await screen.findByRole('button', { name: '查看账号池' })
    fireEvent.click(card)
    expect(window.location.hash).toBe('#tab=accounts')
  })

  test('点击告警摘要卡 → 深链 #tab=alerts', async () => {
    renderPage(<DashboardPage />)
    const card = await screen.findByRole('button', { name: '打开告警中心' })
    fireEvent.click(card)
    expect(window.location.hash).toBe('#tab=alerts')
  })
})
