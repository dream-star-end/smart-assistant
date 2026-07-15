import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { SettingsCenter } from './SettingsCenter'

vi.mock('./settings/AccountTab', () => ({ AccountTab: () => <div>账户页</div> }))
vi.mock('./settings/UsageTab', () => ({ UsageTab: () => <div>用量页</div> }))
const preferencesProps = vi.hoisted(() => vi.fn())
vi.mock('./settings/PreferencesTab', () => ({
  PreferencesTab: (props: unknown) => {
    preferencesProps(props)
    return <div>偏好页</div>
  },
}))
vi.mock('./settings/SubscriptionDialog', () => ({ SubscriptionDialog: () => null }))

const auth: AuthSession = {
  getToken: () => 'token',
  setToken: () => {},
  onExpired: () => {},
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  preferencesProps.mockClear()
})

test('设置中心可发现反馈分区并进入真实反馈表单', () => {
  render(
    <SettingsCenter
      open
      auth={auth}
      user={null}
      theme="light"
      onClose={() => {}}
      onSetTheme={() => {}}
      onOpenMemory={() => {}}
    />,
  )

  const feedbackTab = screen.getByRole('tab', { name: '反馈' })
  expect(feedbackTab).toBeVisible()
  expect(feedbackTab.closest('[role=tablist]')).toHaveClass('min-w-max')

  fireEvent.click(feedbackTab)
  expect(screen.getByRole('form', { name: '反馈表单' })).toBeInTheDocument()
  expect(screen.getByLabelText('反馈类型')).toBeInTheDocument()
  expect(screen.getByLabelText('反馈内容')).toBeInTheDocument()
})

test('设置中心只把 API Key 管理权限授予 admin', async () => {
  vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: {} } as never)
  const common = {
    open: true, auth, theme: 'light' as const,
    onClose: () => {}, onSetTheme: () => {}, onOpenMemory: () => {},
  }

  const first = render(
    <SettingsCenter
      {...common}
      user={{ id: '1', displayName: '普通用户', roles: ['user'], role: 'user' }}
    />,
  )
  fireEvent.click(screen.getByRole('tab', { name: '偏好' }))
  await screen.findByText('偏好页')
  await waitFor(() => expect(preferencesProps).toHaveBeenCalled())
  expect((preferencesProps.mock.calls.at(-1)?.[0] as { canManageApiKeys?: boolean }).canManageApiKeys).toBe(false)
  first.unmount()
  preferencesProps.mockClear()

  render(
    <SettingsCenter
      {...common}
      user={{ id: '2', displayName: '管理员', roles: ['admin'], role: 'admin' }}
    />,
  )
  fireEvent.click(screen.getByRole('tab', { name: '偏好' }))
  await screen.findByText('偏好页')
  await waitFor(() => expect(preferencesProps).toHaveBeenCalled())
  expect((preferencesProps.mock.calls.at(-1)?.[0] as { canManageApiKeys?: boolean }).canManageApiKeys).toBe(true)
})
