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
    return <div>偏好页</div>
  },
  BuiltinHotkeysTable: () => <div>快捷键页</div>,
}))
vi.mock('./settings/SubscriptionDialog', () => ({ SubscriptionDialog: () => null }))
vi.mock('./settings/ApiAccessTab', () => ({ ApiAccessTab: () => <div>API 接入页</div> }))

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
  expect(feedbackTab.closest('[role=tablist]')).toHaveClass('grid', 'grid-cols-3')

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
  expect(screen.getByText(`${BRAND.nameEn} · ${BRAND.slogan}`)).toHaveClass(
    'text-caption',
    'text-faint',
  )
})

test.each([
  ['preferences', '偏好', '偏好页'],
  // 窄屏（本文件默认视口）账户分区渲染短名「账户」
  ['account', '账户', '账户页'],
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
  expect(screen.getByRole('tab', { name: '账户与计费' })).toHaveAttribute(
    'aria-controls',
    'settings-panel-account',
  )

  stubMd(false)
  rerender(<SettingsCenter {...base} />)
  const mobileNav = screen.getByRole('tablist', { name: '设置分区' })
  expect(mobileNav).not.toHaveAttribute('aria-orientation', 'vertical')
  expect(mobileNav.closest('.flex-col, .flex') ?? mobileNav.parentElement?.parentElement).toBeTruthy()
})

test('桌面竖导航方向键移动焦点到新 tab', () => {
  stubMd(true)
  render(<SettingsCenter {...base} />)
  const current = screen.getByRole('tab', { name: '账户与计费' })
  current.focus()
  fireEvent.keyDown(screen.getByRole('tablist', { name: '设置分区' }), { key: 'ArrowDown' })
  expect(screen.getByRole('tab', { name: '用量' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: '用量' })).toHaveFocus()
  expect(screen.getByRole('tab', { name: '用量' })).toHaveAttribute('aria-controls', 'settings-panel-usage')
  expect(screen.getByRole('tab', { name: '账户与计费' })).not.toHaveAttribute('aria-controls')
})

test('设置中心不再有 GitHub / 插件分区，未知 section 回落账户', () => {
  render(<SettingsCenter {...base} initialSection={'github' as never} />)
  expect(screen.queryByRole('tab', { name: 'GitHub' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '插件' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '绑定/更换仓库' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '打开插件' })).not.toBeInTheDocument()
  // 窄屏宫格里账户分区用短名「账户」（审计 SET-12：长标签会被列宽截断）
  expect(screen.getByRole('tab', { name: '账户' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('账户页')).toBeInTheDocument()
})

test('窄屏宫格:6 项三列、admin 的 7 项改四列，账户用短名不截断（审计 SET-12）', () => {
  const plain = render(<SettingsCenter {...base} />)
  const list6 = screen.getByRole('tablist', { name: '设置分区' })
  expect(list6).toHaveClass('grid-cols-3')
  expect(list6).not.toHaveClass('grid-cols-4')
  expect(screen.getByRole('tab', { name: '账户' })).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: '账户与计费' })).not.toBeInTheDocument()
  plain.unmount()

  render(
    <SettingsCenter
      {...base}
      user={{ id: '2', displayName: '管理员', roles: ['admin'], role: 'admin' }}
    />,
  )
  expect(screen.getByRole('tablist', { name: '设置分区' })).toHaveClass('grid-cols-4')
  expect(screen.getAllByRole('tab').length).toBe(7)
})

test('快捷键分区是静态表:不拉 prefs,偏好接口故障也照常渲染', async () => {
  // 审计 SET-02:此前快捷键复用偏好页的加载链,接口失败时整页只剩「加载偏好失败」。
  vi.spyOn(api, 'getPreferences').mockRejectedValue(new Error('backend unavailable'))
  vi.spyOn(api, 'getPublicModels').mockRejectedValue(new Error('backend unavailable'))
  render(<SettingsCenter {...base} initialSection="hotkeys" />)
  expect(await screen.findByText('快捷键页')).toBeInTheDocument()
  expect(screen.queryByText('加载偏好失败')).not.toBeInTheDocument()
  expect(api.getPreferences).not.toHaveBeenCalled()
  expect(api.getPublicModels).not.toHaveBeenCalled()
  expect(preferencesProps).not.toHaveBeenCalled()
})

test('关于页显示构建号与法务入口', () => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'oc-build')
  meta.setAttribute('content', 'build-2026.09.15-abc')
  document.head.appendChild(meta)
  try {
    render(<SettingsCenter {...base} initialSection="about" />)
    expect(screen.getByTestId('about-build')).toHaveTextContent('build-2026.09.15-abc')
    // 术语与落地页 / 登录页一致：「用户协议」而非「服务条款」
    expect(screen.getByRole('link', { name: '用户协议' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: '隐私政策' })).toHaveAttribute('href', '/privacy')
  } finally {
    meta.remove()
  }
})

test('「API 接入」分区只对 admin 可见;普通用户深链回落账户页', async () => {
  const first = render(<SettingsCenter {...base} initialSection="api-access" />)
  expect(screen.queryByRole('tab', { name: 'API 接入' })).not.toBeInTheDocument()
  expect(screen.queryByText('API 接入页')).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: '账户' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('账户页')).toBeInTheDocument()
  first.unmount()

  render(
    <SettingsCenter
      {...base}
      user={{ id: '2', displayName: '管理员', roles: ['admin'], role: 'admin' }}
    />,
  )
  const tab = screen.getByRole('tab', { name: 'API 接入' })
  fireEvent.click(tab)
  expect(tab).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByText('API 接入页')).toBeInTheDocument()
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
