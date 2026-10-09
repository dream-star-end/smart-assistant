import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DEFAULT_MANAGE_TAB, MANAGE_TABS, type ManageTab } from '../lib/manageTabs'
import { expectAriaControlsResolvable } from '../test/ariaControls'
import { ManageCenter } from './ManageCenter'

const originalMatchMedia = window.matchMedia
afterEach(() => {
  cleanup()
  window.matchMedia = originalMatchMedia
})

/** 桌面(≥768px)/ 窄屏切换:壳体按 useMdViewport 挂竖导航或宫格页签,与设置中心同一套。 */
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

test('标题行与设置中心同款：可见标题「管理中心」即无障碍名，只有一个关闭按钮', () => {
  renderShell()
  expect(screen.getByRole('dialog', { name: '管理中心' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '管理中心' })).toBeVisible()
  expect(screen.getAllByRole('button', { name: '关闭' })).toHaveLength(1)
})

test('管理中心关闭按钮仅在粗指针扩大到 44px', () => {
  renderShell()
  // 触控靶已下沉进 IconButton 原语（改造前是壳体手写的补丁）。
  expect(screen.getByRole('button', { name: '关闭' })).toHaveClass('[@media(hover:none)]:size-11')
})

test('中心壳走 Modal 原语：与设置同高 + 桌面放宽容纳导航栏 + 保留 visualViewport 契约', () => {
  renderShell()
  const dialog = screen.getByRole('dialog')
  // 定高（非 max-h）：切 Tab 时高度不跳。vh 回退与 safe-area 由 .oc-center-dialog 承担，
  // 该类是未分层的普通 CSS 规则，会盖掉 top-1/2 / max-h 等工具类 —— 故壳体必须挂它。
  expect(dialog).toHaveClass(
    'oc-center-dialog',
    'h-[min(85dvh,44rem)]',
    'bg-surface',
    'md:max-w-[min(1000px,calc(100vw-2rem))]',
  )
  // OCV5-362：不再有把 app 圆角 token 压到 10/8px 的独立外壳类（「和 v5 个人版的整体样式很割裂」）。
  expect(dialog).not.toHaveClass('oc-manage')
  expect(dialog).not.toHaveClass('oc-quiet')
})

test('首位 Tab 即默认落地页，且顺序/文案为已定案的四个分区（文献/优化已下线）', () => {
  // 契约：DEFAULT_MANAGE_TAB 由注册表首位派生。改造前 TABS[0]='optimization' 而 App
  // 默认 'memory'，首屏永远是"选中的不是第一个"。
  expect(DEFAULT_MANAGE_TAB).toBe(MANAGE_TABS[0].id)
  expect(MANAGE_TABS.map((t) => t.id)).toEqual([
    'memory',
    'skills',
    'cron',
    'connectors',
  ])
  renderShell()
  const tabs = screen.getAllByRole('tab')
  // 名字只是分区名；一句话说明是当前面板的 aria-describedby，不拼进名字（OCV5-344）。
  expect(MANAGE_TABS.map((t) => t.label)).toEqual(['记忆', '技能', '定时', '插件'])
  for (const [i, def] of MANAGE_TABS.entries()) expect(tabs[i]).toHaveAccessibleName(def.label)
  expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tabpanel')).toHaveAccessibleDescription(MANAGE_TABS[0].blurb)
})

test('主导航与设置中心同款：窄屏四列宫格药丸页签，桌面 168px 纯文字竖导航', () => {
  stubMd(false)
  const { rerender } = renderShell()
  const mobile = screen.getByRole('tablist', { name: '管理分区' })
  expect(mobile).not.toHaveAttribute('aria-orientation', 'vertical')
  expect(mobile).toHaveClass('grid', 'grid-cols-4')
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveClass('rounded-full')

  stubMd(true)
  rerender(
    <ManageCenter open tab="memory" auth={null} agentId="main" agents={[]} onTabChange={() => {}} onClose={() => {}} />,
  )
  const desktop = screen.getByRole('tablist', { name: '管理分区' })
  expect(desktop).toHaveAttribute('aria-orientation', 'vertical')
  expect(desktop.closest('.w-\\[168px\\]')).not.toBeNull()
  // 纯文字：不再有第 3/4 轮的图标列。
  for (const tab of screen.getAllByRole('tab')) expect(tab.querySelector('svg')).toBeNull()
  expect(screen.getByRole('tab', { name: '记忆' })).toHaveAttribute('id', 'manage-tab-memory')
})

test('方向键 / Home / End 在分区间移动并切换（roving tabindex）', () => {
  const onTabChange = vi.fn<(t: ManageTab) => void>()
  stubMd(true)
  renderShell({ tab: 'skills', onTabChange })
  const skills = screen.getByRole('tab', { name: '技能' })
  expect(skills).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('tab', { name: '记忆' })).toHaveAttribute('tabindex', '-1')
  fireEvent.keyDown(skills, { key: 'ArrowDown' })
  expect(onTabChange).toHaveBeenLastCalledWith('cron')
  fireEvent.keyDown(skills, { key: 'ArrowUp' })
  expect(onTabChange).toHaveBeenLastCalledWith('memory')
  fireEvent.keyDown(skills, { key: 'End' })
  expect(onTabChange).toHaveBeenLastCalledWith('connectors')
  fireEvent.keyDown(skills, { key: 'Home' })
  expect(onTabChange).toHaveBeenLastCalledWith('memory')
})

test('作用范围只在记忆/技能/定时出现，并带可见说明；切到其他分区不显示', () => {
  renderShell({ tab: 'memory' })
  expect(screen.getByText('作用范围')).toBeInTheDocument()
  // 可见标签就是选择器的 <label>：窄屏点标签也能拉起选择器（行内值没有框，触控靶靠标签 + 值）。
  const label = screen.getByText('作用范围')
  expect(label.tagName).toBe('LABEL')
  const select = screen.getByRole('combobox', { name: '项目范围' })
  expect(label).toHaveAttribute('for', select.id)
  // 窄屏按内容取宽，不再给固定宽度的框。
  expect(select.parentElement).not.toHaveClass('w-40')
  cleanup()
  renderShell({ tab: 'connectors' })
  expect(screen.queryByText('作用范围')).not.toBeInTheDocument()
})

test('「怎么用」打开当前分区的教程（四个分区都有），DOM 里只有一个入口；未传回调不渲染', () => {
  const onOpenHelp = vi.fn()
  const { unmount } = renderShell({ tab: 'cron', onOpenHelp })
  // 标题行右侧、关闭按钮之前（Modal headerActions），两个断点同一个按钮。
  expect(screen.getAllByRole('button', { name: '怎么用' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '怎么用' }))
  expect(onOpenHelp).toHaveBeenCalledWith(MANAGE_TABS.find((t) => t.id === 'cron')?.featureId)
  unmount()
  renderShell({ tab: 'connectors', onOpenHelp })
  fireEvent.click(screen.getByRole('button', { name: '怎么用' }))
  expect(onOpenHelp).toHaveBeenLastCalledWith(
    MANAGE_TABS.find((t) => t.id === 'connectors')?.featureId,
  )
  cleanup()
  renderShell({ tab: 'cron' })
  expect(screen.queryByRole('button', { name: '怎么用' })).not.toBeInTheDocument()
})

test('分区说明只作读屏描述、不再挂在每个导航项下；工具条不再有面包屑', () => {
  renderShell({ tab: 'connectors' })
  // 第 3 轮：说明只出现一次，且是 sr-only 的 aria-describedby 目标（视觉由页面标题下的说明承担）。
  const blurb = screen.getByText('已连接的应用和账号')
  expect(blurb).toHaveClass('sr-only')
  expect(screen.getAllByText('已连接的应用和账号')).toHaveLength(1)
  // 不再有面包屑：页面标题本身就说明了位置。
  expect(document.querySelector('.oc-manage-toolbar')).not.toHaveTextContent('管理中心')
})

test('上下文行（两个断点同一条）：分区的 PanelHeader 操作经插槽搬进来；内容滚离顶部才出现下沿发丝线', () => {
  renderShell({ tab: 'memory' })
  const toolbar = document.querySelector('.oc-manage-toolbar') as HTMLElement
  // 插槽在作用范围之后、靠右；桌面不再隐藏（OCV5-362：分区不再有可见的页面大标题）。
  const slot = toolbar.querySelector('[data-manage-slot]')
  expect(slot).toHaveClass('ml-auto')
  expect(slot).not.toHaveClass('md:hidden')
  expect(toolbar).not.toHaveAttribute('data-scrolled')
  const panel = screen.getByRole('tabpanel')
  Object.defineProperty(panel, 'scrollTop', { configurable: true, value: 120 })
  fireEvent.scroll(panel)
  expect(toolbar).toHaveAttribute('data-scrolled', 'true')
  Object.defineProperty(panel, 'scrollTop', { configurable: true, value: 0 })
  fireEvent.scroll(panel)
  expect(toolbar).not.toHaveAttribute('data-scrolled')
})

test('外壳是安静表面：没有渐变标识方块 / 渐变图标，原语拿到 QuietSurface', () => {
  renderShell()
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector('.bg-grad-cta, .tut-mark, .oc-manage-tab-icon')).toBeNull()
  // 未登录空态由 EmptyState 原语渲染；安静形态带 data-empty-state 且不渲染图标方块。
  const empty = dialog.querySelector('[data-empty-state]')
  expect(empty).not.toBeNull()
  expect(empty?.querySelector('svg')).toBeNull()
})

test('导航栏底部「去市场添加」直达市场', () => {
  const onOpenMarketplace = vi.fn()
  stubMd(true)
  renderShell({ onOpenMarketplace })
  fireEvent.click(screen.getByRole('button', { name: /去市场添加/ }))
  expect(onOpenMarketplace).toHaveBeenCalledTimes(1)
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

test('四个分区只挂一个面板，其余 tab 不得留悬空 aria-controls', () => {
  // 壳体是「只渲染当前面板」的典型:4 个 tab 共用一个 tabpanel 容器。
  // 若每个 tab 都落 aria-controls,另外 3 个就都指向不存在的节点 —— DOM 上看不出异常,
  // 读屏的「跳到被控元素」却会静默失败。
  renderShell({ tab: 'skills' })
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
  expect(screen.getByRole('tab', { name: '定时' })).not.toHaveAttribute('aria-controls')
  expect(screen.getByRole('tab', { name: '记忆' })).not.toHaveAttribute('aria-controls')
  expectAriaControlsResolvable()
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

test('窄屏页签在粗指针下有 44px 触控靶（Tabs 原语自带）', () => {
  stubMd(false)
  renderShell()
  for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveClass('[@media(hover:none)]:min-h-11')
})
