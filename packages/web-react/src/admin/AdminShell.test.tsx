import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError } from '../lib/api/http'
import type { User } from '../lib/types'

const { mockGetGovernanceOverview, mockUseAdminRoute, MOCK_DASHBOARD, MOCK_GOVERNANCE } = vi.hoisted(() => ({
  mockGetGovernanceOverview: vi.fn(),
  mockUseAdminRoute: vi.fn(),
  MOCK_DASHBOARD: { key: 'dashboard', title: '总览', group: '经营驾驶舱', desc: '总览', icon: () => null, Component: () => <div>总览内容</div> },
  MOCK_GOVERNANCE: { key: 'governance', title: '自治治理', group: '审计与安全', desc: '治理', icon: () => null, selfhostOnly: true, Component: () => <div>自治治理页内容</div> },
}))

vi.mock('../lib/api/governanceApi', () => ({
  getGovernanceOverview: (...args: unknown[]) => mockGetGovernanceOverview(...args),
}))
vi.mock('./registry', () => ({
  adminGroups: [{ group: '经营驾驶舱', pages: [MOCK_DASHBOARD] }],
  getAdminPage: () => MOCK_DASHBOARD,
  getVisibleAdminGroups: (opts?: { selfhostGovernance?: boolean }) =>
    opts?.selfhostGovernance
      ? [{ group: '经营驾驶舱', pages: [MOCK_DASHBOARD] }, { group: '审计与安全', pages: [MOCK_GOVERNANCE] }]
      : [{ group: '经营驾驶舱', pages: [MOCK_DASHBOARD] }],
  getVisibleAdminPage: (tab: string, opts?: { selfhostGovernance?: boolean }) =>
    opts?.selfhostGovernance && tab === 'governance' ? MOCK_GOVERNANCE : MOCK_DASHBOARD,
}))
vi.mock('./router', () => ({
  useAdminRoute: (...args: unknown[]) => mockUseAdminRoute(...args),
}))

import { AdminShell } from './AdminShell'

beforeEach(() => {
  vi.clearAllMocks()
  mockUseAdminRoute.mockReturnValue({ tab: 'dashboard', navigate: vi.fn() })
})

afterEach(cleanup)

test('管理后台移动抽屉提供可见的 44px 关闭按钮', () => {
  render(<AdminShell user={null} onLogout={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '打开导航' }))
  const close = screen.getByRole('button', { name: '关闭导航' })
  expect(close).toHaveClass('size-11')
  fireEvent.click(close)
  expect(screen.queryByRole('button', { name: '关闭导航' })).not.toBeInTheDocument()
  expect(mockGetGovernanceOverview).not.toHaveBeenCalled()
})

test('B8: 非 uid3 管理员不发起治理探测且深链 #tab=governance 强制回落总览', () => {
  mockUseAdminRoute.mockImplementation((opts?: { selfhostGovernance?: boolean }) => ({
    tab: opts?.selfhostGovernance ? 'governance' : 'dashboard',
    navigate: vi.fn(),
  }))
  const nonUid3 = { id: '42', email: 'other@example.com', role: 'admin' } as unknown as User
  render(<AdminShell user={nonUid3} onLogout={() => {}} />)
  expect(mockGetGovernanceOverview).not.toHaveBeenCalled()
  expect(screen.getByText('总览内容')).toBeInTheDocument()
  expect(screen.queryByText('自治治理')).not.toBeInTheDocument()
  expect(screen.queryByText('自治治理页内容')).not.toBeInTheDocument()
})

test('B8: 商业版 uid3 探测 404 时仅探测一次、不展示入口且深链绝不挂载治理页', async () => {
  mockUseAdminRoute.mockImplementation((opts?: { selfhostGovernance?: boolean }) => ({
    tab: opts?.selfhostGovernance ? 'governance' : 'dashboard',
    navigate: vi.fn(),
  }))
  mockGetGovernanceOverview.mockRejectedValueOnce(new ApiError({ status: 404, message: 'disabled', code: 'SELFHOST_GOVERNANCE_DISABLED' }))
  const uid3 = { id: '3', email: 'owner@example.com', role: 'admin' } as unknown as User
  render(<AdminShell user={uid3} onLogout={() => {}} />)
  await waitFor(() => expect(mockGetGovernanceOverview).toHaveBeenCalledTimes(1))
  expect(screen.getByText('总览内容')).toBeInTheDocument()
  expect(screen.queryByText('自治治理')).not.toBeInTheDocument()
  expect(screen.queryByText('自治治理页内容')).not.toBeInTheDocument()
})

test('B8: 个人版 uid3 仅在挂载时探测一次（切 tab 不重复探测），展示入口、角标与治理页', async () => {
  let currentTab = 'governance'
  mockUseAdminRoute.mockImplementation((opts?: { selfhostGovernance?: boolean }) => ({
    tab: currentTab === 'governance' && !opts?.selfhostGovernance ? 'dashboard' : currentTab,
    navigate: vi.fn(),
  }))
  mockGetGovernanceOverview.mockResolvedValueOnce({
    enabled: true,
    pendingApprovals: [{ id: 'gov-blast_20261127_001' }, { id: 'gov-a0_20261127_002' }],
  })
  const uid3 = { id: '3', email: 'owner@example.com', role: 'admin' } as unknown as User
  const { rerender } = render(<AdminShell user={uid3} onLogout={() => {}} />)
  expect(await screen.findByText('自治治理页内容')).toBeInTheDocument()
  expect(screen.getAllByText('自治治理').length).toBeGreaterThanOrEqual(1)
  expect(screen.getByLabelText('2 项待拍板')).toHaveTextContent('2')
  expect(mockGetGovernanceOverview).toHaveBeenCalledTimes(1)

  currentTab = 'dashboard'
  rerender(<AdminShell user={uid3} onLogout={() => {}} />)
  expect(screen.getByText('总览内容')).toBeInTheDocument()
  expect(mockGetGovernanceOverview).toHaveBeenCalledTimes(1)
})
