import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, LogIn, TriangleAlert, X } from 'lucide-react'
import { type CSSProperties, useCallback, useEffect, useState } from 'react'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import { marketplaceArtifactKind } from '../lib/marketplace'
import type { AuthSession, MarketplaceMyPublish } from '../lib/types'
import { BrowsePanel } from './marketplace/BrowsePanel'
import { InstalledPanel } from './marketplace/InstalledPanel'
import { PublishPanel } from './marketplace/PublishPanel'
import { ReviewPanel } from './marketplace/ReviewPanel'
import {
  type MarketplacePublishTransition,
  useMarketplacePublishes,
} from './marketplace/useMarketplacePublishes'
import { useMarketplaceRevision } from './marketplace/useMarketplaceRevision'
import { Alert, Badge, Button, EmptyState, IconButton, Tabs, useToast } from './ui'

export type MarketplaceTab = 'browse' | 'installed' | 'publish' | 'review'
/** Legacy navigation/storage kind. Connector rows remain wire-compatible in PR1. */
export type MarketplaceKind = 'skill' | 'agent' | 'connector'

function artifactLabel(item: Pick<MarketplaceMyPublish, 'kind' | 'artifactKind'>): string {
  const kind = marketplaceArtifactKind(item)
  return kind === 'plugin' ? '插件' : kind === 'agent' ? '智能体' : '技能'
}

/** Tabs 的 id 前缀:tab ↔ 面板的 aria 关联(aria-controls / aria-labelledby)由它派生。 */
const TAB_ID_BASE = 'marketplace'

/**
 * AI 市场：发现 / 已安装 / 发布 /（管理员）审核。
 * 复用 ManageCenter 的 Dialog + Tabs 结构。后端 marketplace 路由不在 bridge
 * allowlist、强制浏览器 JWT —— 容器/agent 无法绕过自装自发。demo/未登录不渲染。
 *
 * ── 2026-07-26 门面改造(呈现层,功能不变) ─────────────────────────────────
 * 1. 「技能/智能体/插件」的手写 pill 下沉进 BrowsePanel,与搜索框同处一条 sticky 头带
 *    (kind 状态仍由本壳持有 —— 审核通过的 CTA 要能把类目切过去)。这样第一屏不再是
 *    「标题+副标题+Tabs+pill+搜索+chips」六层横向控件,滚动时 kind 上下文也不会丢。
 * 2. 发布结果通知移出滚动区:它是「刚发生的事」,滚一下就找不回来是反的。
 * 3. 未登录态从一行灰字换成带出口的 EmptyState。
 *
 * ── 2026-10-29 UI-5「素净工作台」 ─────────────────────────────────────────
 * 头部只剩一行:标题 · 分区 · 关闭(手机上分区换到第二行)。青柠色标、英文字标和标语都去掉了 ——
 * 市场和主应用用同一套 token,不再像另一个产品(UI-SPEC §1.3 M1–M3)。
 */
export function MarketplaceCenter({
  open,
  tab,
  auth,
  isAdmin,
  initialBrowseKind = 'skill',
  onCreateInChat,
  onAskAiInChat,
  onOpenConnectors,
  onRequireLogin,
  onTabChange,
  onClose,
}: {
  open: boolean
  tab: MarketplaceTab
  auth: AuthSession | null
  isAdmin: boolean
  /** Which category the 发现 tab opens to (e.g. 'agent' when opened via「从市场添加智能体」). */
  initialBrowseKind?: MarketplaceKind
  /** 「在对话中创建」:关闭市场 → 新会话 → 输入框预填引导模板。 */
  onCreateInChat?: (kind: MarketplaceKind) => void
  /** AI 导购入口(批3):关闭市场 → 新会话 → 输入框预填(text 已拼好);不 autoSend。 */
  onAskAiInChat?: (text: string) => void
  /** 安装连接器后跳到管理中心完成账号绑定。 */
  onOpenConnectors?: (pluginSlug?: string) => void
  /**
   * 未登录空态的「去登录」出口(K-24):与 ManageCenter 同款 —— 由壳外(App)负责关市场并切到登录;
   * 没传时回落为只关弹窗(改造前的行为),按钮文案与行为的错位留给接线补齐。
   */
  onRequireLogin?: () => void
  onTabChange: (t: MarketplaceTab) => void
  onClose: () => void
}) {
  const tabs: { value: MarketplaceTab; label: string; featureId?: ProductFeatureId }[] = [
    { value: 'browse', label: '发现', featureId: PRODUCT_CAPABILITIES.marketplace.id },
    { value: 'installed', label: '已安装', featureId: PRODUCT_CAPABILITIES.marketplace.id },
    { value: 'publish', label: '发布', featureId: PRODUCT_CAPABILITIES.publish.id },
    ...(isAdmin ? [{ value: 'review' as const, label: '审核' }] : []),
  ]
  // admin 关闭时若停在 review，回落到 browse。
  const safeTab: MarketplaceTab = tab === 'review' && !isAdmin ? 'browse' : tab

  const [browseKind, setBrowseKind] = useState<MarketplaceKind>(initialBrowseKind)
  const [browseRevision, setBrowseRevision] = useState(0)
  const [browseFocus, setBrowseFocus] = useState<{ slug: string; nonce: number } | null>(null)
  const [publishNotices, setPublishNotices] = useState<MarketplacePublishTransition[]>([])
  const publishNotice = publishNotices[0] ?? null
  // 发布表单有未提交内容时关弹窗（Esc / 点遮罩 / ✕ / 切中心）：草稿已由 PublishPanel 落盘，
  // 这里只补一句"已暂存、下次接着填"，不拦截关闭（K-01）。
  const [publishDirty, setPublishDirty] = useState(false)
  const toast = useToast()
  const requestClose = () => {
    if (publishDirty) toast('发布草稿已暂存，下次打开「发布」可以接着填', 'info')
    onClose()
  }

  const onPublishTransition = useCallback((transition: MarketplacePublishTransition) => {
    setBrowseRevision((revision) => revision + 1)
    setPublishNotices((notices) => [...notices, transition])
  }, [])
  const publishes = useMarketplacePublishes({
    auth,
    enabled: open && !!auth,
    onTransition: onPublishTransition,
  })
  const onCatalogRevision = useCallback(() => {
    setBrowseRevision((revision) => revision + 1)
    publishes.refresh()
  }, [publishes.refresh])
  useMarketplaceRevision({
    auth,
    enabled: open && !!auth,
    onChange: onCatalogRevision,
  })

  // when (re)opened, honor the requested category (e.g. opened to 智能体)
  useEffect(() => {
    if (open) setBrowseKind(initialBrowseKind)
    else {
      setPublishNotices([])
      setBrowseFocus(null)
    }
  }, [open, initialBrowseKind])

  const openApprovedPublish = (transition: MarketplacePublishTransition) => {
    setBrowseKind(transition.publish.kind)
    setBrowseFocus({ slug: transition.publish.slug, nonce: Date.now() })
    setPublishNotices((notices) => notices.slice(1))
    onTabChange('browse')
  }

  const dismissPublishNotice = () => setPublishNotices((notices) => notices.slice(1))
  const consumeBrowseFocus = useCallback((nonce: number) => {
    setBrowseFocus((current) => (current?.nonce === nonce ? null : current))
  }, [])

  const noticeApproved = publishNotice?.publish.status === 'approved'

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && requestClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          // 高度上限覆盖 oc-center-dialog 的默认 85dvh:市场是浏览型大弹层,要更高。该变量在未分层的
          // .oc-center-dialog 规则里有默认值,工具类盖不过,只能走内联样式(取小的兜底仍由该规则负责)。
          style={{ '--oc-center-max-h': 'calc(var(--oc-visual-height, 100dvh) - 24px)' } as CSSProperties}
          className="marketplace-window oc-center-dialog fixed left-1/2 z-50 flex h-[calc(100dvh-24px)] w-[calc(100vw-16px)] max-w-[1120px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-float focus:outline-none data-[state=open]:animate-in sm:h-[min(91dvh,940px)] sm:w-[calc(100vw-32px)] lg:w-[calc(100vw-64px)]"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:flex-nowrap sm:px-6">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-title font-semibold text-fg">AI 市场</Dialog.Title>
            </div>
            <Tabs
              aria-label="市场分区"
              idBase={TAB_ID_BASE}
              value={safeTab}
              onValueChange={(v) => onTabChange(v as MarketplaceTab)}
              items={tabs.map((t) => ({ value: t.value, label: t.label, featureId: t.featureId }))}
              className="order-last max-sm:w-full max-sm:[&>[role=tab]]:flex-1 sm:order-none"
            />
            <Dialog.Close asChild>
              <IconButton aria-label="关闭" size="sm" className="ml-auto">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>

          {/* 发布结果通知:留在滚动区外,滚动时不丢;多条时给出剩余计数,不再"看起来只有一条"。 */}
          {auth && publishNotice && (
            <div className="border-b border-border px-4 py-2.5 sm:px-6">
              <Alert
                density="compact"
                tone={noticeApproved ? 'success' : 'warning'}
                icon={noticeApproved ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
                title={
                  <span className="flex flex-wrap items-center gap-1.5">
                    {noticeApproved
                      ? `${artifactLabel(publishNotice.publish)}已实时上架`
                      : `${artifactLabel(publishNotice.publish)}未通过审核`}
                    {publishNotices.length > 1 && (
                      <Badge tone="neutral" size="sm">
                        还有 {publishNotices.length - 1} 条
                      </Badge>
                    )}
                  </span>
                }
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (noticeApproved) {
                        openApprovedPublish(publishNotice)
                      } else {
                        dismissPublishNotice()
                        onTabChange('publish')
                      }
                    }}
                  >
                    {noticeApproved ? '在市场查看' : '查看我的发布'}
                  </Button>
                }
                onDismiss={dismissPublishNotice}
              >
                「{publishNotice.publish.name}」v{publishNotice.publish.version}
                {noticeApproved
                  ? ' 已发布到市场。'
                  : `：${publishNotice.publish.reviewNote || '请到「发布」页的「我的发布」查看并修改后重新提交。'}`}
              </Alert>
            </div>
          )}

          <div
            role="tabpanel"
            id={`${TAB_ID_BASE}-panel-${safeTab}`}
            aria-labelledby={`${TAB_ID_BASE}-tab-${safeTab}`}
            className="marketplace-content min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pt-28 [scrollbar-gutter:stable]"
          >
            {!auth ? (
              <EmptyState
                icon={LogIn}
                title="登录后即可浏览市场"
                hint="你安装的技能与智能体会跟随账号同步。"
                action={
                  <Button size="sm" variant="primary" onClick={onRequireLogin ?? onClose}>
                    去登录
                  </Button>
                }
              />
            ) : (
              <>
                {safeTab === 'browse' && (
                  <div
                    className="contents"
                    data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}
                  >
                    <BrowsePanel
                      auth={auth}
                      kind={browseKind}
                      onKindChange={setBrowseKind}
                      revision={browseRevision}
                      focusRequest={browseFocus}
                      onFocusRequestConsumed={consumeBrowseFocus}
                      onAskAiInChat={onAskAiInChat}
                      onCreateInChat={
                        onCreateInChat ? () => onCreateInChat(browseKind) : undefined
                      }
                      onGoPublish={() => onTabChange('publish')}
                      onOpenConnectors={onOpenConnectors}
                    />
                  </div>
                )}
                {safeTab === 'installed' && (
                  <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}>
                    <InstalledPanel
                      auth={auth}
                      onGoBrowse={() => onTabChange('browse')}
                      onOpenConnectors={onOpenConnectors}
                    />
                  </div>
                )}
                {safeTab === 'publish' && (
                  <div className="contents" data-product-feature={PRODUCT_CAPABILITIES.publish.id}>
                    <PublishPanel
                      auth={auth}
                      onCreateInChat={onCreateInChat}
                      publishes={publishes.rows}
                      publishesLoading={publishes.loading}
                      publishesError={publishes.error}
                      onRefreshPublishes={publishes.refresh}
                      onMutePublishTransition={publishes.muteTransition}
                      onDirtyChange={setPublishDirty}
                    />
                  </div>
                )}
                {safeTab === 'review' && isAdmin && <ReviewPanel auth={auth} />}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
