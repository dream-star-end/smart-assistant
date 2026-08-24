import { LogIn } from "lucide-react";
import { MANAGE_TABS, type ManageTab } from "../lib/manageTabs";
import { PRODUCT_CAPABILITIES } from "../lib/productCapabilities";
import type { AuthSession } from "../lib/types";
import { CronPanel } from "./manage/CronPanel";
import { LibraryPanel } from "./manage/LibraryPanel";
import { MemoryPanel } from "./manage/MemoryPanel";
import { OptimizationPanel } from "./manage/OptimizationPanel";
import { SkillsPanel } from "./manage/SkillsPanel";
import { ConnectorsTab } from "./settings/ConnectorsTab";
import { Badge, Button, EmptyState, Modal, ProjectScopeSelect, Tabs } from "./ui";
import { AgentProjectPreview } from "./manage/AgentProjectPreview";
import { ProjectAssetsManagePanel } from "./manage/ProjectAssetsManagePanel";
import { isWorkScope } from "../lib/projectScope";
import { useProjectScope } from "../hooks/useProjectScope";

export type { ManageTab };

/**
 * 管理中心：记忆 / 技能 / 定时 / 插件 / 文献 / 优化。均经 commercial router 容器代理
 * 读写用户容器内 gateway。与设置中心（账户/计费/偏好）分离 —— 这里是「智能体数据」管理。
 * 各 Tab 懒渲染，demo/未登录不渲染网络分区。
 *
 * ── 外壳 ─────────────────────────────────────────────────────────────
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
  onRequireLogin,
}: {
  open: boolean;
  tab: ManageTab;
  auth: AuthSession | null;
  /** 记忆按 agent 维度；默认选中当前对话 agent。 */
  agentId: string;
  /** 可切换的智能体（全能助手 + 已安装市场智能体），记忆面板内切换。 */
  agents: { id: string; name: string }[];
  /** 市场安装后一次性自动打开对应 Plugin 的授权弹层。 */
  autoAuthorizePluginSlug?: string | null;
  /** Auto‑Dream 待确认建议数（与侧栏入口信号同源，见 hooks/useOptimizerPending）。 */
  optimizerPendingCount?: number;
  onAutoAuthorizeConsumed?: () => void;
  onTabChange: (t: ManageTab) => void;
  onClose: () => void;
  onOpenMarketplace?: () => void;
  /** 未登录态 CTA：关闭本壳并把用户送到登录页。省略则空态只剩说明。 */
  onRequireLogin?: () => void;
}) {
  const { scope } = useProjectScope();
  const items = MANAGE_TABS.map((t) => ({
    value: t.id,
    featureId: t.featureId,
    // 「优化」是收件箱型分区：有待办才值得看。徽标是它唯一的曝光位（改造前 Tab 上
    // 没有任何数量信号，用户点进去才知道有事要办）；0 时不渲染，避免恒亮的噪声。
    label:
      t.id === "optimization" && optimizerPendingCount > 0 ? (
        <span className="inline-flex min-w-0 items-center gap-1">
          <span className="truncate">{t.label}</span>
          <Badge tone="accent" size="sm">
            {optimizerPendingCount > 99 ? "99+" : optimizerPendingCount}
            <span className="sr-only"> 项待确认</span>
          </Badge>
        </span>
      ) : (
        t.label
      ),
  }));

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="管理中心"
      description="记忆、技能、定时任务与插件都在这里"
      size="xl"
      fixedHeight
      // mobile 显式取 center（= 默认）：只有 center 形态会挂 .oc-center-dialog，
      // 那是 iOS 键盘弹起时把弹层顶回可视视口的 visualViewport / safe-area 契约，
      // 四个中心壳都依赖它；fullscreen/sheet 挂上反而会被它反向覆盖定位。
      mobile="center"
      className="bg-surface"
      // layout="grid"：6 个中文 tab 单行需 ~467px，390px 屏上容器只有 ~326px ——
      // 横滚形态下末尾两个 tab 在所有主流手机上默认不可见。宫格 3×2 让主导航整屏可见。
      toolbar={
        <div className="flex flex-col gap-2">
          {tab === "memory" || tab === "skills" ? (
            <ProjectScopeSelect className="w-full sm:w-56" />
          ) : null}
          <Tabs
            aria-label="管理分区"
            idBase="manage"
            layout="grid"
            value={tab}
            onValueChange={(v) => onTabChange(v as ManageTab)}
            items={items}
          />
        </div>
      }
      // 面板自带内距（PanelHeader px-4 + 正文 px-5），壳体不再叠一层。
      bodyClassName="p-0"
    >
      {/* tabpanel 与 tablist 的 aria 关联：读屏才能把"当前面板"和"当前标签"对上，
          tabIndex=0 也让键盘用户能聚焦到内容区用方向键滚动。 */}
      <div
        role="tabpanel"
        id={`manage-panel-${tab}`}
        aria-labelledby={`manage-tab-${tab}`}
        tabIndex={0}
        className="flex min-h-full flex-col outline-none"
      >
        {!auth ? (
          <div className="flex flex-1 items-center justify-center">
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
            {tab === "memory" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.memory.id}>
                <MemoryPanel auth={auth} agentId={agentId} agents={agents} />
                {isWorkScope(scope) ? (
                  <>
                    <ProjectAssetsManagePanel auth={auth} />
                    <AgentProjectPreview auth={auth} agentId={agentId} />
                  </>
                ) : null}
              </div>
            )}
            {tab === "skills" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.skills.id}>
                <SkillsPanel auth={auth} />
              </div>
            )}
            {tab === "cron" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.schedules.id}>
                <CronPanel auth={auth} />
              </div>
            )}
            {tab === "connectors" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.connectors.id}>
                <ConnectorsTab
                  auth={auth}
                  onOpenMarketplace={onOpenMarketplace}
                  autoAuthorizePluginSlug={autoAuthorizePluginSlug}
                  onAutoAuthorizeConsumed={onAutoAuthorizeConsumed}
                />
              </div>
            )}
            {tab === "library" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.research.id}>
                <LibraryPanel auth={auth} />
              </div>
            )}
            {tab === "optimization" && (
              <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.memory.id}>
                <OptimizationPanel auth={auth} agentId={agentId} agents={agents} />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
