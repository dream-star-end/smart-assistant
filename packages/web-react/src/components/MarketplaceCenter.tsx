import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, LogIn, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
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
import { Alert, Badge, Button, EmptyState, IconButton, Tabs } from './ui'

export type MarketplaceTab = 'browse' | 'installed' | 'publish' | 'review'
/** Legacy navigation/storage kind. Connector rows remain wire-compatible in PR1. */
export type MarketplaceKind = 'skill' | 'agent' | 'connector'

function artifactLabel(item: Pick<MarketplaceMyPublish, 'kind' | 'artifactKind'>): string {
  const kind = marketplaceArtifactKind(item)
  return kind === 'plugin' ? 'API 连接插件' : kind === 'agent' ? '智能体' : '技能'
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
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="oc-center-dialog fixed left-1/2 z-50 flex h-[min(85vh,46rem)] h-[min(85dvh,46rem)] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          {/* 标题区与下方内容同为 px-4:改造前 px-5 让标题比列表右缩 4px,是肉眼可见的错位缝。
              副标题在窄屏隐藏 —— 它在 375px 下必然折行,吃掉 40px 而信息量为零。 */}
          <div className="flex items-start justify-between gap-3 px-4 py-2.5 sm:py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-title font-semibold text-fg">AI 市场</Dialog.Title>
              <p className="mt-0.5 hidden text-meta text-faint sm:block">
                发现并安装技能、智能体与插件，也可以把自己的作品分享给大家。
              </p>
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭" size="sm">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-2.5">
            <Tabs
              aria-label="市场分区"
              idBase={TAB_ID_BASE}
              value={safeTab}
              onValueChange={(v) => onTabChange(v as MarketplaceTab)}
              items={tabs.map((t) => ({ value: t.value, label: t.label, featureId: t.featureId }))}
            />
          </div>

          {/* 发布结果通知:留在滚动区外,滚动时不丢;多条时给出剩余计数,不再"看起来只有一条"。 */}
          {auth && publishNotice && (
            <div className="border-b border-border px-4 py-2.5">
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
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {!auth ? (
              <EmptyState
                icon={LogIn}
                title="登录后即可浏览市场"
                hint="你安装的技能与智能体会跟随账号同步。"
                action={
                  <Button size="sm" variant="primary" onClick={onClose}>
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
