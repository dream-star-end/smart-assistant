import * as RD from '@radix-ui/react-dialog'
import {
  ArrowUpRight,
  Brain,
  CircleHelp,
  Clock3,
  LogIn,
  type LucideIcon,
  Plug,
  Sparkles,
  Store,
  X,
} from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import { MANAGE_TABS, type ManageTab, SCOPED_MANAGE_TABS } from '../lib/manageTabs'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { CronPanel } from './manage/CronPanel'
import { MemoryPanel } from './manage/MemoryPanel'
import { SkillsPanel } from './manage/SkillsPanel'
import { ConnectorsTab } from './settings/ConnectorsTab'
import {
  Button,
  EmptyState,
  HeaderSlotProvider,
  IconButton,
  Modal,
  ProjectScopeSelect,
  QuietSurface,
} from './ui'

export type { ManageTab }

/** 分区图标：桌面导航栏用；窄屏分段控件只放文字。 */
const TAB_ICONS: Record<ManageTab, LucideIcon> = {
  memory: Brain,
  skills: Sparkles,
  cron: Clock3,
  connectors: Plug,
}

/**
 * 管理中心：记忆 / 技能 / 定时 / 插件。均经 commercial router 容器代理读写用户容器内
 * gateway。与设置中心（账户/计费/偏好）分离 —— 这里是「智能体数据」管理。
 * 各 Tab 懒渲染，demo/未登录不渲染网络分区。
 * 「文献」「优化」两个分区已在 OCV5-360 下线（个人版现网 0 文档 / 0 条建议，证据见工单）；
 * 后端接口与数据原样保留，回退本提交即可恢复入口。
 *
 * ── 外壳（OCV5-344 第 1/3 轮 + OCV5-360 第 4 轮）────────────────────
 * 安静的排版型工作面（Linear 设置页 / Apple 系统设置一路）：层级靠字号、对齐与留白。
 * 整棵树包在 QuietSurface 里，Card / Badge / EmptyState / PanelHeader / Tabs 等原语据此
 * 换成安静形态（ui/Quiet.tsx），管理中心以外的界面零变化。
 *
 * 桌面：左侧导航栏（图标 + 名称），右侧是当前分区（页面标题 + 说明 + 内容），
 * 工具条放作用范围与「怎么用」。
 * 窄屏（第 4 轮，手机优先；容器仍是居中弹窗 —— 运营拍板「弹窗不变」）：
 *   标题行「管理中心」+ 怎么用(?) + 关闭；一条四等分的分段控件（只有文字）；
 *   一条上下文行：左边作用范围，右边是分区自己的操作（PanelHeader 的 action 经
 *   HeaderSlot portal 过来）。分区的 22px 页面标题在窄屏只留给读屏 —— 分段控件已经写明
 *   你在哪，改造前标题 + 两行说明 + 单独一行按钮把第一条内容挤到了半屏以下。
 *   内容滚动后，固定区下沿出现一条发丝线（Notion 式）—— 改造前没有边界，滚上去的搜索框
 *   看起来像被「作用范围」行切掉了一半（运营 11:54 截图）。
 * 导航仍是**一个** role=tablist（id/aria 关联、roving tabindex、方向键 + Home/End），
 * 桌面竖排、窄屏分段只是排布不同。
 *
 * 壳体收敛到 ui/Modal 的 size / fixedHeight 两轴；`size="xl" + fixedHeight` = 与市场壳
 * 同一尺寸，定高保证切 Tab 时高度不跳。
 *
 * ── 分区契约（新增/改面板的人请遵守）─────────────────────────────────
 * 1. 面板的**第一个子节点必须是 PanelHeader**，且面板自身不得再包一层水平 padding。
 *    分区唯一的主操作放 PanelHeader 的 action（窄屏会被搬进上下文行，要短、要小）。
 * 2. 加载态用 ListSkeleton 且**保留 PanelHeader 在骨架之上**，不要整面板早返。
 * 3. 错误渲染在**发起它的那个容器内**；成功且离开当前上下文走 toast，留在原地用内联 Alert。
 * 4. 空态 = 标题 + 一句说明 + 可点 CTA（EmptyState 的 action 槽）。
 */
export function ManageCenter({
  open,
  tab,
  auth,
  agentId,
  agents,
  autoAuthorizePluginSlug,
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
  // 窄屏上下文行右侧的插槽节点：PanelHeader 的 action 经 portal 渲染到这里。
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  // 内容是否已滚离顶部：决定固定区下沿的发丝线（切分区时面板重挂、回到顶部）。
  const [scrolled, setScrolled] = useState(false)

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
  const showHelp = Boolean(onOpenHelp)
  const openHelp = () => onOpenHelp?.(current.featureId)

  const renderTab = (t: (typeof MANAGE_TABS)[number]) => {
    const Icon = TAB_ICONS[t.id]
    // 教程门(check:tutorials)只认 `{featureId}` / `{it.featureId}` 形态的锚点表达式。
    const featureId = t.featureId
    const selected = t.id === tab
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
        // 名字只取分区名，一句话说明走 describedby —— 否则说明会被拼进名字里。
        aria-labelledby={`manage-tab-${t.id}-label`}
        aria-describedby={`manage-tab-${t.id}-blurb`}
        tabIndex={selected ? 0 : -1}
        data-product-feature={featureId}
        onClick={() => onTabChange(t.id)}
        onKeyDown={onTabKeyDown}
        // 窄屏分段是 32px 高的视觉块;styles.css 里透明 ::after 上下各外扩 6px,命中区 = 44px(Codex r1)。
        className={cn(
          'oc-manage-tab group relative flex min-w-0 items-center justify-center rounded-[7px] text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-md:h-8 md:h-8 md:justify-start md:gap-2.5 md:rounded-[8px] md:px-2.5 md:text-left',
          selected ? 'text-fg' : 'text-muted hover:text-fg md:hover:bg-hover',
        )}
      >
        <Icon
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={cn(
            'hidden shrink-0 transition-colors duration-100 md:block',
            selected ? 'text-fg' : 'text-faint group-hover:text-muted',
          )}
        />
        <span
          id={`manage-tab-${t.id}-label`}
          className="min-w-0 truncate text-[13px] font-medium leading-5 md:flex-1 md:font-normal md:group-aria-selected:font-medium"
        >
          {t.label}
        </span>
        {/* 一句话说明：读屏的 describedby；视觉上由分区页面标题下的说明（桌面）承担。 */}
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
      // 窄屏仍是居中弹窗（运营「弹窗不变」）：只有 center 形态会挂 .oc-center-dialog，
      // 那是 iOS 键盘弹起时把弹层顶回可视视口的 visualViewport / safe-area 契约。
      mobile="center"
      // 桌面放宽到能并排「导航栏 + 原分区宽度」，并略增高度：分区内容宽度与改造前一致。
      className="oc-manage rounded-2xl md:h-[min(88dvh,48rem)] md:max-w-[min(1060px,calc(100vw-2rem))]"
      // 面板自带内距（PanelHeader px-4 + 正文 px-5），壳体不再叠一层；滚动交给右侧分区自身。
      bodyClassName="flex min-h-0 flex-col overflow-hidden p-0 md:flex-row"
    >
      <QuietSurface>
        <HeaderSlotProvider value={slot}>
          {/* 窄屏标题行：怎么用(?) · 管理中心 · 关闭。两侧按钮是下方唯一的那一份，绝对定位到这一行
              （DOM 里各只有一个，读屏不会读到两次）；两侧等宽，标题光学居中。 */}
          <div className="flex h-12 shrink-0 items-center justify-center md:hidden">
            <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg">管理中心</span>
          </div>

          <nav
            aria-label="管理中心导航"
            className="oc-manage-rail shrink-0 md:flex md:w-[220px] md:flex-col md:border-r md:border-border"
          >
            <div className="hidden h-14 items-center px-5 md:flex">
              <span className="text-[14px] font-semibold tracking-[-0.005em] text-fg">管理中心</span>
            </div>
            <div
              role="tablist"
              aria-label="管理分区"
              className="oc-manage-tablist mx-4 grid grid-cols-4 gap-0.5 rounded-[9px] p-0.5 md:mx-0 md:flex md:flex-1 md:flex-col md:gap-px md:overflow-y-auto md:rounded-none md:p-0 md:px-2.5 md:pb-3 md:pt-1"
            >
              {MANAGE_TABS.map(renderTab)}
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
            {/* 工具条。桌面：作用范围 + 怎么用，恒定 56px（切分区不跳版），右侧给关闭留位。
                窄屏：上下文行 —— 左作用范围，右是分区操作插槽；两边都空时插槽仍在但行高收为 0。 */}
            <div
              data-scrolled={scrolled || undefined}
              className="oc-manage-toolbar flex shrink-0 items-center gap-2 px-4 max-md:min-h-2 max-md:pt-1 md:h-14 md:justify-end md:gap-1 md:pl-10 md:pr-14"
            >
              {scoped && (
                <div className="oc-manage-scope flex min-w-0 items-center gap-1 max-md:h-11 max-md:max-w-[62%] md:max-w-72">
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
                    className="w-auto min-w-0 max-w-full"
                  />
                </div>
              )}
              <div
                ref={setSlot}
                data-manage-slot=""
                className="ml-auto flex min-w-0 items-center justify-end gap-1 empty:hidden md:hidden"
              />
              {showHelp && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={openHelp}
                  className="shrink-0 gap-1.5 text-muted hover:text-fg max-md:absolute max-md:left-2 max-md:top-2 max-md:z-20 max-md:w-8 max-md:px-0 max-md:[@media(hover:none)]:left-0.5 max-md:[@media(hover:none)]:top-0.5 max-md:[@media(hover:none)]:w-11"
                >
                  <CircleHelp size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="max-md:sr-only">怎么用</span>
                </Button>
              )}
              <RD.Close asChild>
                <IconButton
                  aria-label="关闭"
                  size="sm"
                  className="oc-manage-close absolute right-2 top-2 z-20 text-faint hover:text-fg max-md:[@media(hover:none)]:right-0.5 max-md:[@media(hover:none)]:top-0.5 md:right-4 md:top-3"
                >
                  <X size={16} strokeWidth={1.75} />
                </IconButton>
              </RD.Close>
            </div>

            {/* tabpanel 与 tablist 的 aria 关联：读屏才能把"当前面板"和"当前标签"对上，
                tabIndex=0 也让键盘用户能聚焦到内容区用方向键滚动。 */}
            <div
              role="tabpanel"
              id={`manage-panel-${tab}`}
              aria-labelledby={`manage-tab-${tab}`}
              tabIndex={0}
              onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
              className="oc-manage-panel flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {/* 内容列：左对齐、最宽 800px（面板自带 px-4，合计桌面 40px 左缘）；key 让切分区时淡入一次。 */}
              <div
                key={auth ? tab : 'login'}
                className="oc-manage-page flex w-full max-w-[800px] flex-1 flex-col pb-6 max-md:pt-1 md:px-6 md:pb-10"
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
                          「项目记忆」页签内渲染。 */}
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
                  </>
                )}
              </div>
            </div>
          </div>
        </HeaderSlotProvider>
      </QuietSurface>
    </Modal>
  )
}
