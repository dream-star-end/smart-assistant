import * as RD from '@radix-ui/react-dialog'
import {
  ArrowUpRight,
  BookOpen,
  Brain,
  CircleHelp,
  Clock3,
  LogIn,
  type LucideIcon,
  Plug,
  Sparkles,
  Store,
  WandSparkles,
  X,
} from 'lucide-react'
import { type KeyboardEvent, useRef } from 'react'
import { MANAGE_TABS, type ManageTab, SCOPED_MANAGE_TABS } from '../lib/manageTabs'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { CronPanel } from './manage/CronPanel'
import { LibraryPanel } from './manage/LibraryPanel'
import { MemoryPanel } from './manage/MemoryPanel'
import { OptimizationPanel } from './manage/OptimizationPanel'
import { SkillsPanel } from './manage/SkillsPanel'
import { ConnectorsTab } from './settings/ConnectorsTab'
import { Button, EmptyState, IconButton, Modal, ProjectScopeSelect, QuietSurface } from './ui'

export type { ManageTab }

/** 分区图标：导航栏与上下文条共用，同一分区处处同一个图形。 */
const TAB_ICONS: Record<ManageTab, LucideIcon> = {
  memory: Brain,
  skills: Sparkles,
  cron: Clock3,
  connectors: Plug,
  library: BookOpen,
  optimization: WandSparkles,
}

/**
 * 导航分组（只影响桌面导航栏的视觉分段；顺序与 MANAGE_TABS 一致，tablist 仍是一维的六项）。
 * 分组名是装饰性小标题，读屏跳过 —— 每个 tab 自己的名字 + 说明已经够用。
 */
const NAV_GROUPS: readonly { label: string; ids: readonly ManageTab[] }[] = [
  { label: '智能体', ids: ['memory', 'skills', 'cron'] },
  { label: '连接与资料', ids: ['connectors', 'library'] },
  { label: '建议', ids: ['optimization'] },
]

/** 「优化」没有独立教程(它的 featureId 借的是记忆),不挂帮助入口,免得点进去讲的是别的。 */
const HELP_TABS: ReadonlySet<ManageTab> = new Set([
  'memory',
  'skills',
  'cron',
  'connectors',
  'library',
])

/**
 * 管理中心：记忆 / 技能 / 定时 / 插件 / 文献 / 优化。均经 commercial router 容器代理
 * 读写用户容器内 gateway。与设置中心（账户/计费/偏好）分离 —— 这里是「智能体数据」管理。
 * 各 Tab 懒渲染，demo/未登录不渲染网络分区。
 *
 * ── 外壳（OCV5-344：第 1 轮易用性 + 第 3 轮视觉）──────────────────────
 * 第 3 轮是「安静的排版型工作面」（Linear 设置页 / Apple 系统设置一路）：层级靠字号、
 * 对齐与留白，不靠渐变方块、彩色药丸、每条一张卡。整棵树包在 QuietSurface 里，
 * Card / Badge / EmptyState / PanelHeader / Tabs 等原语据此换成安静形态（ui/Quiet.tsx），
 * 管理中心以外的界面零变化。强调色只用于选中指示、焦点环、开关、文字链接与待办圆点。
 * 导航栏是纯文字行（图标 + 名称 + 待办数），一句话说明不再挂在每一项下面 —— 它留作
 * 读屏的 aria-describedby，视觉上由分区自己的页面标题 + 说明承担。
 *
 * 桌面：左侧分区导航栏（图标 + 名称 + 待办数），右侧是当前分区；导航栏底部是
 * 「去市场添加」出口，「怎么用」在内容区工具条。窄屏：六等分的图标 + 两字标签条，
 * 六个分区一屏全见（改造前单行横滚，第 6 个「优化」连同它的待办徽标整个在视口外）。
 * 分区上方一条上下文条：作用范围（仅记忆/技能/定时）+ 帮助入口 —— 范围选择不再在
 * 切 Tab 时从导航上方忽隐忽现、把整条导航推上推下。
 * 导航仍是**一个** role=tablist（id/aria 关联、roving tabindex、方向键 + Home/End），
 * 桌面竖排、窄屏横排只是排布不同。
 *
 * 壳体收敛到 ui/Modal 的 size / fixedHeight / toolbar 三轴（改造前是手抄 ~250 字符的
 * Radix 类名，与市场壳 768×736 差一截 —— 两个中心互相跳转时窗口会跳一下）。
 * `size="xl" + fixedHeight` = 与市场壳同一尺寸；定高（非 max-h）保证切 Tab 时高度不跳。
 * 底色显式保持 bg-surface：四个中心壳同层级，且内部卡片就是 bg-surface，
 * 换 bg-elevated 会让深色主题下的卡片反而比壳更暗（层级倒挂）。
 *
 * ── 分区契约（新增/改面板的人请遵守）─────────────────────────────────
 * 1. 面板的**第一个子节点必须是 PanelHeader**，且面板自身不得再包一层水平 padding
 *    ——PanelHeader 自带 px-4，外面再套 px-5 会让标题左缘在切 Tab 时横向平移 20px。
 * 2. 加载态用 ListSkeleton 且**保留 PanelHeader 在骨架之上**，不要整面板早返：
 *    定高壳里的整面板早返 = 700px 空白 + 中间一个圈，观感等同整页重载。
 * 3. 错误渲染在**发起它的那个容器内**（弹窗内失败→弹窗内报）；成功且离开当前上下文
 *    （弹窗关闭 / 行消失）走 toast，留在原地则用内联 Alert。
 * 4. 空态必须有 icon + 说明 + 可点 CTA（EmptyState 的 action 槽）。
 */
export function ManageCenter({
  open,
  tab,
  auth,
  agentId,
  agents,
  autoAuthorizePluginSlug,
  optimizerPendingCount = 0,
  onAutoAuthorizeConsumed,
  onTabChange,
  onClose,
  onOpenMarketplace,
  onOpenHelp,
  onRequireLogin,
}: {
  open: boolean
  tab: ManageTab
  auth: AuthSession | null
  /** 记忆按 agent 维度；默认选中当前对话 agent。 */
  agentId: string
  /** 可切换的智能体（全能助手 + 已安装市场智能体），记忆面板内切换。 */
  agents: { id: string; name: string }[]
  /** 市场安装后一次性自动打开对应 Plugin 的授权弹层。 */
  autoAuthorizePluginSlug?: string | null
  /** Auto‑Dream 待确认建议数（与侧栏入口信号同源，见 hooks/useOptimizerPending）。 */
  optimizerPendingCount?: number
  onAutoAuthorizeConsumed?: () => void
  onTabChange: (t: ManageTab) => void
  onClose: () => void
  onOpenMarketplace?: () => void
  /** 「怎么用」：打开对应功能的教程。省略则不渲染帮助入口。 */
  onOpenHelp?: (featureId: ProductFeatureId) => void
  /** 未登录态 CTA：关闭本壳并把用户送到登录页。省略则空态只剩说明。 */
  onRequireLogin?: () => void
}) {
  const tabRefs = useRef<Partial<Record<ManageTab, HTMLButtonElement | null>>>({})
  const current = MANAGE_TABS.find((t) => t.id === tab) ?? MANAGE_TABS[0]
  const pendingLabel = optimizerPendingCount > 99 ? '99+' : String(optimizerPendingCount)

  const focusTab = (id: ManageTab) => {
    onTabChange(id)
    tabRefs.current[id]?.focus()
  }
  // 竖排(桌面)与横排(窄屏)共用一份 tablist：两组方向键都响应，Home/End 跳首尾。
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = MANAGE_TABS.findIndex((t) => t.id === tab)
    const last = MANAGE_TABS.length - 1
    let next: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      next = index >= last ? 0 : index + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      next = index <= 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    focusTab(MANAGE_TABS[next].id)
  }

  const scoped = SCOPED_MANAGE_TABS.has(current.id)
  const showHelp = Boolean(onOpenHelp) && HELP_TABS.has(current.id)

  const renderTab = (t: (typeof MANAGE_TABS)[number]) => {
    const Icon = TAB_ICONS[t.id]
    const featureId = t.featureId
    const selected = t.id === tab
    const pending = t.id === 'optimization' && optimizerPendingCount > 0
    return (
      <button
        key={t.id}
        ref={(el) => {
          tabRefs.current[t.id] = el
        }}
        type="button"
        role="tab"
        id={`manage-tab-${t.id}`}
        aria-selected={selected}
        // 只有当前分区真的挂了面板：其余 tab 不留悬空 aria-controls。
        aria-controls={selected ? `manage-panel-${t.id}` : undefined}
        // 名字只取「分区名 + 待办数」，一句话说明走 describedby —— 否则说明会被拼进名字里。
        aria-labelledby={`manage-tab-${t.id}-label`}
        aria-describedby={`manage-tab-${t.id}-blurb`}
        tabIndex={selected ? 0 : -1}
        data-product-feature={featureId}
        onClick={() => onTabChange(t.id)}
        onKeyDown={onTabKeyDown}
        className={cn(
          'oc-manage-tab group relative flex min-w-0 flex-col items-center gap-1 px-1 pb-2 pt-2.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:h-8 md:flex-row md:gap-2.5 md:rounded-[8px] md:px-2.5 md:py-0 md:text-left [@media(hover:none)]:min-h-11',
          selected ? 'text-fg' : 'text-muted hover:text-fg md:hover:bg-hover',
        )}
      >
        <span aria-hidden="true" className="relative flex shrink-0 items-center justify-center">
          <Icon
            size={16}
            strokeWidth={1.75}
            className={cn(
              'transition-colors duration-100',
              selected ? 'text-fg' : 'text-faint group-hover:text-muted',
            )}
          />
          {/* 窄屏只放得下一个小圆点：数量在下方待办提示里说全。 */}
          {pending && (
            <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-accent md:hidden" />
          )}
        </span>
        <span
          id={`manage-tab-${t.id}-label`}
          className={cn(
            'min-w-0 truncate text-[11px] leading-4 md:flex-1 md:text-[13px] md:leading-5',
            selected && 'font-medium',
          )}
        >
          {t.label}
          {pending && <span className="sr-only"> {pendingLabel} 项待确认</span>}
        </span>
        {pending && (
          <span
            aria-hidden="true"
            className="hidden shrink-0 items-center gap-1.5 text-meta tabular-nums text-muted md:inline-flex"
          >
            <span className="size-1.5 rounded-full bg-accent" />
            {pendingLabel}
          </span>
        )}
        {/* 一句话说明：读屏的 describedby；视觉上由分区页面标题下的说明承担。 */}
        <span id={`manage-tab-${t.id}-blurb`} className="sr-only">
          {t.blurb}
        </span>
      </button>
    )
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      // 可见标题在导航栏顶部；Dialog 的无障碍名仍是「管理中心」。
      srTitle="管理中心"
      size="xl"
      fixedHeight
      // mobile 显式取 center（= 默认）：只有 center 形态会挂 .oc-center-dialog，
      // 那是 iOS 键盘弹起时把弹层顶回可视视口的 visualViewport / safe-area 契约，
      // 四个中心壳都依赖它；fullscreen/sheet 挂上反而会被它反向覆盖定位。
      mobile="center"
      // 桌面放宽到能并排「导航栏 + 原分区宽度」，并略增高度：分区内容宽度与改造前一致。
      className="oc-manage rounded-2xl md:h-[min(88dvh,48rem)] md:max-w-[min(1060px,calc(100vw-2rem))]"
      // 面板自带内距（PanelHeader px-4 + 正文 px-5），壳体不再叠一层；滚动交给右侧分区自身。
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-0 md:flex-row"
    >
      <QuietSurface>
        <RD.Close asChild>
          <IconButton
            aria-label="关闭"
            size="sm"
            className="absolute right-2 top-1.5 z-20 text-faint hover:text-fg md:right-4 md:top-3"
          >
            <X size={16} strokeWidth={1.75} />
          </IconButton>
        </RD.Close>

        {/* 窄屏标题行（桌面在导航栏顶部）。 */}
        <div className="flex h-14 shrink-0 items-center px-4 md:hidden">
          <span className="text-[17px] font-semibold tracking-[-0.01em] text-fg">管理中心</span>
        </div>

        <nav
          aria-label="管理中心导航"
          className="oc-manage-rail shrink-0 md:flex md:w-[232px] md:flex-col md:border-r md:border-border"
        >
          <div className="hidden h-14 items-center px-5 md:flex">
            <span className="text-[14px] font-semibold tracking-[-0.005em] text-fg">管理中心</span>
          </div>
          <div
            role="tablist"
            aria-label="管理分区"
            className="oc-manage-tablist grid grid-cols-6 border-b border-border px-1 md:flex md:flex-1 md:flex-col md:gap-px md:overflow-y-auto md:border-b-0 md:px-2.5 md:pb-3"
          >
            {NAV_GROUPS.map((group, i) => (
              <div key={group.label} className="contents">
                <span
                  aria-hidden="true"
                  className={cn(
                    'hidden px-2.5 pb-1.5 text-[12px] font-medium leading-4 text-faint md:block',
                    i === 0 ? 'pt-2' : 'pt-5',
                  )}
                >
                  {group.label}
                </span>
                {MANAGE_TABS.filter((t) => group.ids.includes(t.id)).map(renderTab)}
              </div>
            ))}
          </div>
          {onOpenMarketplace && (
            <div className="hidden border-t border-border px-2.5 py-2.5 md:block">
              <button
                type="button"
                onClick={onOpenMarketplace}
                className="group flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-left text-[13px] text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Store size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint group-hover:text-muted" />
                <span className="flex-1 truncate">去市场添加</span>
                <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />
              </button>
            </div>
          )}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 工具条：作用范围 + 怎么用，右侧给关闭按钮留位。桌面恒定 56px 高（切分区不跳版）；
              窄屏只在有控件时出现。 */}
          <div
            className={cn(
              'oc-manage-toolbar flex shrink-0 items-center gap-2 px-4 py-1 md:h-14 md:justify-end md:gap-1 md:py-0 md:pl-10 md:pr-14',
              !scoped && !showHelp && 'max-md:hidden',
            )}
          >
            {scoped && (
              <div className="oc-manage-scope flex min-w-0 items-center gap-1 md:w-56 md:gap-2">
                {/* 可见标签是真 <label>：窄屏点「作用范围」也能拉起选择器（触控靶 = 标签 + 值）。 */}
                <label
                  htmlFor="manage-scope-select"
                  className="shrink-0 cursor-pointer text-body text-muted md:text-meta md:text-faint"
                >
                  作用范围
                </label>
                {/* 窄屏是行内值「全部项目 ⌄」（无填充框，按内容取宽，44px 触控高），
                    桌面是 224px 槽位里的安静填充小控件。 */}
                <ProjectScopeSelect
                  id="manage-scope-select"
                  className="w-auto min-w-0 max-w-full md:flex-1"
                />
              </div>
            )}
            {showHelp && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenHelp?.(current.featureId)}
                className="shrink-0 gap-1.5 text-muted hover:text-fg max-md:ml-auto"
              >
                <CircleHelp size={15} strokeWidth={1.75} aria-hidden="true" />
                怎么用
              </Button>
            )}
          </div>

          {/* 窄屏「优化」待办：导航上只有小圆点，这里把数量和出口说全；选中「优化」或计数为 0 时不渲染。 */}
          {optimizerPendingCount > 0 && tab !== 'optimization' && (
            <button
              type="button"
              onClick={() => onTabChange('optimization')}
              className="mx-4 mb-1 flex shrink-0 items-center gap-2 rounded-[8px] py-2 text-left text-meta text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden [@media(hover:none)]:min-h-11"
            >
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="flex-1">有 {pendingLabel} 项优化建议待确认</span>
              <span className="font-medium text-fg">查看</span>
            </button>
          )}

          {/* tabpanel 与 tablist 的 aria 关联：读屏才能把"当前面板"和"当前标签"对上，
              tabIndex=0 也让键盘用户能聚焦到内容区用方向键滚动。 */}
          <div
            role="tabpanel"
            id={`manage-panel-${tab}`}
            aria-labelledby={`manage-tab-${tab}`}
            tabIndex={0}
            className="oc-manage-panel flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {/* 内容列：左对齐、最宽 800px（面板自带 px-4，合计桌面 40px 左缘）；key 让切分区时淡入一次。 */}
            <div
              key={auth ? tab : 'login'}
              className="oc-manage-page flex w-full max-w-[800px] flex-1 flex-col pb-6 md:px-6 md:pb-10"
            >
              {!auth ? (
                <div className="pt-2">
                  <EmptyState
                    icon={LogIn}
                    title="登录后即可管理"
                    hint="记忆、技能、定时任务与插件都需要登录后才能读写。"
                    action={
                      onRequireLogin ? (
                        <Button variant="primary" onClick={onRequireLogin}>
                          去登录
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <>
                  {tab === 'memory' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.memory.id}>
                      {/* 工作项目作用域下的「项目资产」「智能体项目上下文预览」由 MemoryPanel 在
                        「项目记忆」页签内渲染（改造前追加在整个面板之后、不随页签切换）。 */}
                      <MemoryPanel auth={auth} agentId={agentId} agents={agents} />
                    </div>
                  )}
                  {tab === 'skills' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.skills.id}>
                      <SkillsPanel auth={auth} onOpenMarketplace={onOpenMarketplace} />
                    </div>
                  )}
                  {tab === 'cron' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.schedules.id}>
                      <CronPanel auth={auth} />
                    </div>
                  )}
                  {tab === 'connectors' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.connectors.id}>
                      <ConnectorsTab
                        auth={auth}
                        onOpenMarketplace={onOpenMarketplace}
                        autoAuthorizePluginSlug={autoAuthorizePluginSlug}
                        onAutoAuthorizeConsumed={onAutoAuthorizeConsumed}
                      />
                    </div>
                  )}
                  {tab === 'library' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.research.id}>
                      <LibraryPanel auth={auth} />
                    </div>
                  )}
                  {tab === 'optimization' && (
                    <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.memory.id}>
                      <OptimizationPanel auth={auth} agentId={agentId} agents={agents} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </QuietSurface>
    </Modal>
  )
}
