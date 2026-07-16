import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import { marketplaceArtifactKind } from '../lib/marketplace'
import type { AuthSession, MarketplaceMyPublish } from '../lib/types'
import { cn } from '../lib/utils'
import { BrowsePanel } from './marketplace/BrowsePanel'
import { InstalledPanel } from './marketplace/InstalledPanel'
import { PublishPanel } from './marketplace/PublishPanel'
import { ReviewPanel } from './marketplace/ReviewPanel'
import {
  type MarketplacePublishTransition,
  useMarketplacePublishes,
} from './marketplace/useMarketplacePublishes'
import { useMarketplaceRevision } from './marketplace/useMarketplaceRevision'
import { Alert, Button, Tabs } from './ui'

export type MarketplaceTab = 'browse' | 'installed' | 'publish' | 'review'
/** Legacy navigation/storage kind. Connector rows remain wire-compatible in PR1. */
export type MarketplaceKind = 'skill' | 'agent' | 'connector'
type MarketplaceBrowseKind = 'skill' | 'agent' | 'plugin'

function browseKindFor(kind: MarketplaceKind): MarketplaceBrowseKind {
  return kind === 'connector' ? 'plugin' : kind
}

function storageKindFor(kind: MarketplaceBrowseKind): MarketplaceKind {
  return kind === 'plugin' ? 'connector' : kind
}

function artifactLabel(item: Pick<MarketplaceMyPublish, 'kind' | 'artifactKind'>): string {
  const kind = marketplaceArtifactKind(item)
  return kind === 'plugin' ? 'API 连接插件' : kind === 'agent' ? '智能体' : '技能'
}

/**
 * AI 市场：发现 / 已安装 / 发布 /（管理员）审核。
 * 复用 ManageCenter 的 Dialog + Tabs 结构。后端 marketplace 路由不在 bridge
 * allowlist、强制浏览器 JWT —— 容器/agent 无法绕过自装自发。demo/未登录不渲染。
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
  onOpenConnectors?: () => void
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

  const [browseKind, setBrowseKind] = useState<MarketplaceBrowseKind>(() =>
    browseKindFor(initialBrowseKind),
  )
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
    if (open) setBrowseKind(browseKindFor(initialBrowseKind))
    else {
      setPublishNotices([])
      setBrowseFocus(null)
    }
  }, [open, initialBrowseKind])

  const openApprovedPublish = (transition: MarketplacePublishTransition) => {
    setBrowseKind(browseKindFor(transition.publish.kind))
    setBrowseFocus({ slug: transition.publish.slug, nonce: Date.now() })
    setPublishNotices((notices) => notices.slice(1))
    onTabChange('browse')
  }

  const dismissPublishNotice = () => setPublishNotices((notices) => notices.slice(1))
  const consumeBrowseFocus = useCallback((nonce: number) => {
    setBrowseFocus((current) => (current?.nonce === nonce ? null : current))
  }, [])

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(85vh,46rem)] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-fg">AI 市场</Dialog.Title>
              <p className="mt-0.5 text-[12px] text-faint">
                发现并安装技能、智能体与插件，也可以把自己的作品分享给大家。
              </p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-border px-4 pb-3">
            <Tabs
              aria-label="市场分区"
              value={safeTab}
              onValueChange={(v) => onTabChange(v as MarketplaceTab)}
              items={tabs.map((t) => ({ value: t.value, label: t.label, featureId: t.featureId }))}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!auth ? (
              <p className="px-5 py-10 text-center text-[13px] text-faint">请先登录。</p>
            ) : (
              <>
                {publishNotice && (
                  <output className="block px-4 pt-3">
                    <Alert
                      tone={publishNotice.publish.status === 'approved' ? 'success' : 'danger'}
                      title={
                        publishNotice.publish.status === 'approved'
                          ? `${artifactLabel(publishNotice.publish)}已实时上架`
                          : `${artifactLabel(publishNotice.publish)}未通过审核`
                      }
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          「{publishNotice.publish.name}」v{publishNotice.publish.version}
                          {publishNotice.publish.status === 'approved'
                            ? ' 已发布到市场。'
                            : `：${publishNotice.publish.reviewNote || '请在「我的发布」查看并修改后重新提交。'}`}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              if (publishNotice.publish.status === 'approved') {
                                openApprovedPublish(publishNotice)
                              } else {
                                dismissPublishNotice()
                                onTabChange('publish')
                              }
                            }}
                          >
                            {publishNotice.publish.status === 'approved'
                              ? '在市场查看'
                              : '查看我的发布'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={dismissPublishNotice}>
                            关闭
                          </Button>
                        </div>
                      </div>
                    </Alert>
                  </output>
                )}
                {safeTab === 'browse' && (
                  <div className="flex flex-col" data-product-feature={PRODUCT_CAPABILITIES.marketplace.id}>
                    <div className="flex gap-1 px-4 pt-3">
                      {(['skill', 'agent', 'plugin'] as const).map((k) => (
                        <button
                          type="button"
                          key={k}
                          onClick={() => setBrowseKind(k)}
                          className={cn(
                            'rounded-full px-3 py-1 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            browseKind === k
                              ? 'bg-accent-soft text-accent'
                              : 'text-muted hover:bg-hover hover:text-fg',
                          )}
                        >
                          {k === 'skill' ? '技能' : k === 'agent' ? '智能体' : '插件'}
                        </button>
                      ))}
                    </div>
                    <BrowsePanel
                      auth={auth}
                      kind={storageKindFor(browseKind)}
                      revision={browseRevision}
                      focusRequest={browseFocus}
                      onFocusRequestConsumed={consumeBrowseFocus}
                      onAskAiInChat={onAskAiInChat}
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
