import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../lib/api'
import { BRAND } from '../lib/brand'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { createMemoryAuthSession } from '../lib/authSession'
import { SettingsCenter } from './SettingsCenter'

vi.mock('./settings/AccountTab', () => ({ AccountTab: () => <div>账户页</div> }))
vi.mock('./settings/UsageTab', () => ({ UsageTab: () => <div>用量页</div> }))
const preferencesProps = vi.hoisted(() => vi.fn())
vi.mock('./settings/PreferencesTab', () => ({
  PreferencesTab: (props: unknown) => {
    preferencesProps(props)
    return <div>{(props as { pane?: string }).pane === 'hotkeys' ? '快捷键页' : '偏好页'}</div>
  },
}))
vi.mock('./settings/SubscriptionDialog', () => ({ SubscriptionDialog: () => null }))

const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')

const base = {
  open: true as const,
  auth,
  user: { id: 'u1', displayName: '用户', roles: ['user'] as string[], role: 'user' as const },
  theme: 'light' as const,
  onClose: () => {},
  onSetTheme: () => {},
  onOpenMemory: () => {},
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  preferencesProps.mockClear()
  window.matchMedia = originalMatchMedia
})

const originalMatchMedia = window.matchMedia

function stubMd(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('768') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

test('设置中心可发现反馈分区并进入真实反馈表单', () => {
  render(<SettingsCenter {...base} />)

  const feedbackTab = screen.getByRole('tab', { name: '反馈' })
  expect(feedbackTab).toBeVisible()
  expect(feedbackTab.closest('[role=tablist]')).toHaveClass('overflow-x-auto')

  fireEvent.click(feedbackTab)
  expect(screen.getByRole('form', { name: '反馈表单' })).toBeInTheDocument()
  expect(screen.getByRole('group', { name: '反馈类型' })).toBeInTheDocument()
  expect(screen.getByLabelText('反馈内容')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '关闭' })).toHaveClass('[@media(hover:none)]:size-11')
  expect(screen.getByRole('dialog')).toHaveClass('oc-center-dialog')
  expect(screen.getByRole('dialog').className).toMatch(/max-w-3xl/)
  expect(screen.getByText('设置')).toHaveClass('text-title')
})

test('关于分区说明使用 text-caption text-faint，标题保持 text-title', () => {
  render(<SettingsCenter {...base} initialSection="about" />)

  expect(screen.getByText('设置')).toHaveClass('text-title')
  expect(screen.getByText(BRAND.slogan)).toHaveClass('text-caption', 'text-faint')
})

test.each([
  ['preferences', '偏好', '偏好页'],
  ['account', '账户与计费', '账户页'],
  ['feedback', '反馈', null],
] as const)('教程深链 settings.section=%s 打开对应分区', async (section, tabName, panel) => {
  expect(PRODUCT_CAPABILITIES.preferences.destination).toEqual({
    kind: 'settings',
    section: 'preferences',
  })
  expect(PRODUCT_CAPABILITIES.billing.destination).toEqual({ kind: 'settings', section: 'account' })
  expect(PRODUCT_CAPABILITIES.feedback.destination).toEqual({ kind: 'settings', section: 'feedback' })
  expect(PRODUCT_CAPABILITIES.connectors.destination).toEqual({ kind: 'manage', tab: 'connectors' })

  if (section === 'preferences') {
    vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: {} } as never)
  }
  render(<SettingsCenter {...base} initialSection={section} />)
  expect(screen.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true')
  if (panel) expect(await screen.findByText(panel)).toBeInTheDocument()
  if (section === 'feedback') expect(screen.getByRole('form', { name: '反馈表单' })).toBeInTheDocument()
})

test('md 以上用 168px 竖导航，窄屏不并排', () => {
  stubMd(true)
  const { rerender } = render(<SettingsCenter {...base} />)
  const desktopNav = screen.getByRole('tablist', { name: '设置分区' })
  expect(desktopNav).toHaveAttribute('aria-orientation', 'vertical')
  expect(desktopNav).toHaveClass('w-[168px]')

  stubMd(false)
  rerender(<SettingsCenter {...base} />)
  const mobileNav = screen.getByRole('tablist', { name: '设置分区' })
  expect(mobileNav).not.toHaveAttribute('aria-orientation', 'vertical')
  expect(mobileNav.closest('.flex-col, .flex') ?? mobileNav.parentElement?.parentElement).toBeTruthy()
})

test('GitHub / 插件深链先关设置再打开目标', () => {
  const onClose = vi.fn()
  const onOpenRepo = vi.fn()
  const onOpenManage = vi.fn()
  render(
    <SettingsCenter
      {...base}
      onClose={onClose}
      onOpenRepo={onOpenRepo}
      onOpenManage={onOpenManage}
      initialSection="github"
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '绑定/更换仓库' }))
  expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onOpenRepo.mock.invocationCallOrder[0])

  onClose.mockClear()
  fireEvent.click(screen.getByRole('tab', { name: '插件' }))
  fireEvent.click(screen.getByRole('button', { name: '打开插件' }))
  expect(onClose).toHaveBeenCalled()
  expect(onOpenManage).toHaveBeenCalled()
})

test('快捷键分区仍拉同一份 prefs', async () => {
  vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: {} } as never)
  render(<SettingsCenter {...base} initialSection="hotkeys" />)
  expect(await screen.findByText('快捷键页')).toBeInTheDocument()
  expect(api.getPreferences).toHaveBeenCalled()
})

test('设置中心只把 API Key 管理权限授予 admin', async () => {
  vi.spyOn(api, 'getPreferences').mockResolvedValue({ prefs: {} } as never)

  const first = render(<SettingsCenter {...base} />)
  fireEvent.click(screen.getByRole('tab', { name: '偏好' }))
  await screen.findByText('偏好页')
  await waitFor(() => expect(preferencesProps).toHaveBeenCalled())
  expect((preferencesProps.mock.calls.at(-1)?.[0] as { canManageApiKeys?: boolean }).canManageApiKeys).toBe(false)
  first.unmount()
  preferencesProps.mockClear()

  render(
    <SettingsCenter
      {...base}
      user={{ id: '2', displayName: '管理员', roles: ['admin'], role: 'admin' }}
    />,
  )
  fireEvent.click(screen.getByRole('tab', { name: '偏好' }))
  await screen.findByText('偏好页')
  await waitFor(() => expect(preferencesProps).toHaveBeenCalled())
  expect((preferencesProps.mock.calls.at(-1)?.[0] as { canManageApiKeys?: boolean }).canManageApiKeys).toBe(true)
})

test('偏好首次加载失败可原地重试，成功后恢复完整偏好页', async () => {
  vi.spyOn(api, 'getPreferences')
    .mockRejectedValueOnce(new Error('backend unavailable'))
    .mockResolvedValueOnce({ prefs: {} } as never)
  render(<SettingsCenter {...base} user={null} />)

  fireEvent.click(screen.getByRole('tab', { name: '偏好' }))
  expect(await screen.findByText('加载偏好失败')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('偏好页')).toBeInTheDocument()
  expect(api.getPreferences).toHaveBeenCalledTimes(2)
})
