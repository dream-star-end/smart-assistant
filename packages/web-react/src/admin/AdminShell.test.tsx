import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./registry', () => ({
  adminGroups: [],
  getAdminPage: () => ({ title: '总览', Component: () => <div>总览内容</div> }),
}))
vi.mock('./router', () => ({
  useAdminRoute: () => ({ tab: 'dashboard', navigate: vi.fn() }),
}))

import { AdminShell } from './AdminShell'

afterEach(cleanup)

test('管理后台移动抽屉提供可见的 44px 关闭按钮', () => {
  render(<AdminShell user={null} onLogout={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '打开导航' }))
  const close = screen.getByRole('button', { name: '关闭导航' })
  expect(close).toHaveClass('size-11')
  fireEvent.click(close)
  expect(screen.queryByRole('button', { name: '关闭导航' })).not.toBeInTheDocument()
})
