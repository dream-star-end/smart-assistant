import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

// OCV5-365: 一个页面渲染崩溃后，切到别的 tab 必须恢复，而不是整个后台停在「此页面加载出错」。
let currentTab = 'broken'
function Broken(): never {
  throw new Error('page render failed')
}
vi.mock('./registry', () => ({
  adminGroups: [],
  getAdminPage: (tab: string) =>
    tab === 'broken'
      ? { title: '坏页', Component: Broken }
      : { title: '总览', Component: () => <div>总览内容</div> },
}))
vi.mock('./router', () => ({
  useAdminRoute: () => ({ tab: currentTab, navigate: vi.fn() }),
}))

import { AdminShell } from './AdminShell'

afterEach(cleanup)

test('页面崩溃只影响当前 tab，切页后错误边界重置', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const { rerender } = render(<AdminShell user={null} onLogout={() => {}} />)
    expect(screen.getByText('此页面加载出错')).toBeInTheDocument()
    currentTab = 'dashboard'
    rerender(<AdminShell user={null} onLogout={() => {}} />)
    expect(screen.queryByText('此页面加载出错')).not.toBeInTheDocument()
    expect(screen.getByText('总览内容')).toBeInTheDocument()
  } finally {
    err.mockRestore()
  }
})
