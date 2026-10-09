import { ArrowUpRight, CircleHelp, LogIn, Store } from 'lucide-react'
import { useState } from 'react'
import { useMdViewport } from '../hooks/useMdViewport'
import { MANAGE_TABS, type ManageTab, SCOPED_MANAGE_TABS } from '../lib/manageTabs'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { CronPanel } from './manage/CronPanel'
import { MemoryPanel } from './manage/MemoryPanel'
import { SkillsPanel } from './manage/SkillsPanel'
import { ConnectorsTab } from './settings/ConnectorsTab'
import {
  Button,
  EmptyState,
  HeaderSlotProvider,
  Modal,
  ProjectScopeSelect,
  QuietSurface,
  SectionNav,
  Tabs,
} from './ui'

export type { ManageTab }

/**
 * 管理中心：记忆 / 技能 / 定时 / 插件。均经 commercial router 容器代理读写用户容器内
 * gateway。与设置中心（账户/计费/偏好）分离 —— 这里是「智能体数据」管理。
 * 各 Tab 懒渲染，demo/未登录不渲染网络分区。
 * 「文献」「优化」两个分区已在 OCV5-360 下线（个人版现网 0 文档 / 0 条建议，证据见工单）；
 * 后端接口与数据原样保留，回退本提交即可恢复入口。
 *
 * ── 外壳（OCV5-362 第 5 轮）────────────────────────────────────────
 * 与设置中心是同一个壳：Modal 自带标题行（左「管理中心」，右「怎么用」+ 关闭）；
 * 桌面左侧是与设置共用的 SectionNav，窄屏是与设置同款的宫格药丸 Tabs（一条带底线的色带）。
 * 第 3/4 轮另起了一套语言（居中 iOS 标题、方角分段、染色侧栏、把圆角 token 压到 10/8px），
 * 运营 19:56：「样式感觉和v5个人版的整体样式很割裂」—— 那套外壳已删除，圆角 / 阴影 / 页签
 * 全部回到 app 自己的 token。保留的只是行级的克制（一行一个点按目标、两行截断、一条元信息、
 * 圆点 + 文字的状态），见 ui/Quiet.tsx。
 *
 * 上下文行（两个断点同一条）：左作用范围，右是分区自己的操作（PanelHeader 的 action 经
 * HeaderSlot portal 过来）。分区标题只留给读屏 —— 导航已写明你在哪，设置中心同样没有页面大标题。
 * 内容滚动后上下文行下沿出现发丝线（第 4 轮修的「搜索框被切一半」）。
 *
 * ── 分区契约（新增/改面板的人请遵守）─────────────────────────────────
 * 1. 面板的**第一个子节点必须是 PanelHeader**，且面板自身不得再包一层水平 padding。
 *    分区唯一的主操作放 PanelHeader 的 action（会被搬进上下文行，要短、要小）。
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
  const desktop = useMdViewport()
  const current = MANAGE_TABS.find((t) => t.id === tab) ?? MANAGE_TABS[0]
  // 上下文行右侧的插槽节点：PanelHeader 的 action 经 portal 渲染到这里。
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  // 内容是否已滚离顶部：决定上下文行下沿的发丝线（切分区时面板重挂、回到顶部）。
  const [scrolled, setScrolled] = useState(false)
  const scoped = SCOPED_MANAGE_TABS.has(current.id)

  // 两种导航同一个 id 体系（manage-tab-<id> / manage-panel-<id>），任一时刻只挂一种。
  const navItems = MANAGE_TABS.map((t) => ({ id: t.id, label: t.label, featureId: t.featureId }))

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={<span className="text-title font-semibold text-fg">管理中心</span>}
      headerActions={
        onOpenHelp ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenHelp(current.featureId)}
            className="gap-1.5 text-muted hover:text-fg"
          >
            <CircleHelp size={15} strokeWidth={1.75} aria-hidden="true" />
            怎么用
          </Button>
        ) : undefined
      }
      size="xl"
      fixedHeight
      // 窄屏仍是居中弹窗（运营「弹窗不变」）：只有 center 形态会挂 .oc-center-dialog，
      // 那是 iOS 键盘弹起时把弹层顶回可视视口的 visualViewport / safe-area 契约。
      mobile="center"
      // 桌面比设置宽：记忆 / 技能列表需要行宽。高度与设置同档。
      className="bg-surface md:max-w-[min(1000px,calc(100vw-2rem))]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
    >
      <QuietSurface>
        <HeaderSlotProvider value={slot}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
            {desktop ? (
              <SectionNav
                aria-label="管理分区"
                idBase="manage-tab"
                panelIdBase="manage-panel"
                value={current.id}
                onChange={onTabChange}
                groups={[{ label: '管理', items: navItems }]}
                footer={
                  onOpenMarketplace && (
                    <button
                      type="button"
                      onClick={onOpenMarketplace}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-body text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Store size={15} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
                      <span className="flex-1 truncate">去市场添加</span>
                      <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />
                    </button>
                  )
                }
              />
            ) : (
              <div className="shrink-0 border-b border-border px-4 py-3">
                <Tabs
                  aria-label="管理分区"
                  idBase="manage"
                  layout="grid"
                  value={current.id}
                  onValueChange={(v) => onTabChange(v as ManageTab)}
                  items={navItems.map((it) => ({ value: it.id, label: it.label, featureId: it.featureId }))}
                  className="grid-cols-4 [&_[role=tab]]:px-2"
                />
              </div>
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* 上下文行：左作用范围，右分区操作插槽（四个分区都至少有其一）。 */}
              <div
                data-scrolled={scrolled || undefined}
                className="oc-manage-toolbar flex min-h-12 shrink-0 items-center gap-2 px-4 py-1 md:min-h-14 md:px-6"
              >
                {scoped && (
                  <div className="oc-manage-scope flex min-w-0 items-center gap-1 max-md:max-w-[62%] md:max-w-72">
                    {/* 可见标签是真 <label>：点「作用范围」也能拉起选择器（触控靶 = 标签 + 值）。 */}
                    <label
                      htmlFor="manage-scope-select"
                      className="shrink-0 cursor-pointer text-body text-muted"
                    >
                      作用范围
                    </label>
                    <ProjectScopeSelect id="manage-scope-select" className="w-auto min-w-0 max-w-full" />
                  </div>
                )}
                <div
                  ref={setSlot}
                  data-manage-slot=""
                  className="ml-auto flex min-w-0 items-center justify-end gap-1"
                />
              </div>

              {/* tabpanel 与 tablist 的 aria 关联：读屏才能把"当前面板"和"当前标签"对上，
                  tabIndex=0 也让键盘用户能聚焦到内容区用方向键滚动。 */}
              <div
                role="tabpanel"
                id={`manage-panel-${tab}`}
                aria-labelledby={`manage-tab-${tab}`}
                aria-describedby="manage-panel-blurb"
                tabIndex={0}
                onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
                className="oc-manage-panel flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span id="manage-panel-blurb" className="sr-only">
                  {current.blurb}
                </span>
                {/* 内容列：最宽 800px；key 让切分区时淡入一次。 */}
                <div
                  key={auth ? tab : 'login'}
                  className="oc-manage-page flex w-full max-w-[800px] flex-1 flex-col pb-6 pt-1 md:px-2 md:pb-10"
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
          </div>
        </HeaderSlotProvider>
      </QuietSurface>
    </Modal>
  )
}
