import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AuthSession } from '../lib/types'
import { createMemoryAuthSession } from '../lib/authSession'
import { SettingsCenter } from './SettingsCenter'

vi.mock('./settings/AccountTab', () => ({ AccountTab: () => <div>账户页</div> }))
vi.mock('./settings/UsageTab', () => ({ UsageTab: () => <div>用量页</div> }))
vi.mock('./settings/PreferencesTab', () => ({ PreferencesTab: () => <div>偏好页</div> }))
vi.mock('./settings/SubscriptionDialog', () => ({ SubscriptionDialog: () => null }))

const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')

afterEach(cleanup)

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
