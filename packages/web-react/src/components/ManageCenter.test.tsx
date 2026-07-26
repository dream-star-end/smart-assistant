import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DEFAULT_MANAGE_TAB, MANAGE_TABS, type ManageTab } from '../lib/manageTabs'
import { ManageCenter } from './ManageCenter'

afterEach(cleanup)

/** auth=null 渲染未登录态：不触发任何面板网络请求，壳体断言天然稳定。 */
function renderShell(props: Partial<Parameters<typeof ManageCenter>[0]> = {}) {
  return render(
    <ManageCenter
      open
      tab={DEFAULT_MANAGE_TAB}
      auth={null}
      agentId="main"
      agents={[]}
      onTabChange={() => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

test('管理中心关闭按钮仅在粗指针扩大到 44px', () => {
  renderShell()
  // 触控靶已下沉进 IconButton 原语（改造前是壳体手写的补丁）。
  expect(screen.getByRole('button', { name: '关闭' })).toHaveClass('[@media(hover:none)]:size-11')
})

test('中心壳走 Modal 原语：定高 44rem + 与市场壳同宽 + 保留 visualViewport 契约', () => {
  renderShell()
  const dialog = screen.getByRole('dialog')
  // 定高（非 max-h）：切 Tab 时高度不跳。vh 回退与 safe-area 由 .oc-center-dialog 承担，
  // 该类是未分层的普通 CSS 规则，会盖掉 top-1/2 / max-h 等工具类 —— 故壳体必须挂它。
  expect(dialog).toHaveClass('oc-center-dialog', 'h-[min(85dvh,44rem)]', 'max-w-3xl')
})

test('首位 Tab 即默认落地页，且顺序/文案为已定案的六个分区', () => {
  // 契约：DEFAULT_MANAGE_TAB 由注册表首位派生。改造前 TABS[0]='optimization' 而 App
  // 默认 'memory'，首屏永远是"选中的不是第一个"。
  expect(DEFAULT_MANAGE_TAB).toBe(MANAGE_TABS[0].id)
  expect(MANAGE_TABS.map((t) => t.id)).toEqual([
    'memory',
    'skills',
    'cron',
    'connectors',
    'library',
    'optimization',
  ])
  renderShell()
  const tabs = screen.getAllByRole('tab')
  expect(tabs.map((t) => t.textContent)).toEqual(['记忆', '技能', '定时', '插件', '文献', '优化'])
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
})

test('窄屏主导航排成宫格，不靠横滚（6 个中文 tab 单行放不进 390px）', () => {
  renderShell()
  expect(screen.getByRole('tablist')).toHaveClass('grid', 'grid-cols-3')
})

test('tablist 与面板建立 aria 关联，键盘可聚焦内容区', () => {
  renderShell({ tab: 'skills' })
  const panel = screen.getByRole('tabpanel')
  expect(panel).toHaveAttribute('id', 'manage-panel-skills')
  expect(panel).toHaveAttribute('aria-labelledby', 'manage-tab-skills')
  expect(panel).toHaveAttribute('tabindex', '0')
  const skillsTab = screen.getByRole('tab', { name: '技能' })
  expect(skillsTab).toHaveAttribute('id', 'manage-tab-skills')
  expect(skillsTab).toHaveAttribute('aria-controls', 'manage-panel-skills')
})

test('有待确认建议时「优化」Tab 挂计数徽标，为 0 则不渲染噪声', () => {
  const { unmount } = renderShell({ optimizerPendingCount: 3 })
  expect(screen.getByRole('tab', { name: /优化\s*3\s*项待确认/ })).toBeInTheDocument()
  unmount()
  renderShell({ optimizerPendingCount: 0 })
  expect(screen.getByRole('tab', { name: '优化' })).toBeInTheDocument()
})

test('未登录态是带出口的空态，而不是一行灰字', () => {
  const onRequireLogin = vi.fn()
  renderShell({ onRequireLogin })
  expect(screen.getByText('登录后即可管理')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '去登录' }))
  expect(onRequireLogin).toHaveBeenCalledTimes(1)
})

test('切换分区回调透出的是分区 id', () => {
  const onTabChange = vi.fn<(t: ManageTab) => void>()
  renderShell({ onTabChange })
  fireEvent.click(screen.getByRole('tab', { name: '插件' }))
  expect(onTabChange).toHaveBeenCalledWith('connectors')
})
