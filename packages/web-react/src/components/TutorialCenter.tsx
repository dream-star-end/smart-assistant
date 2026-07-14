import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowRight,
  Bell,
  Bot,
  Brain,
  Building2,
  Check,
  Clock3,
  Copy,
  Cpu,
  Download,
  GitBranch,
  History,
  Image,
  Lightbulb,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Mic,
  Paperclip,
  Plug,
  Search,
  Settings,
  Sparkles,
  Store,
  TriangleAlert,
  Upload,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  PRODUCT_CAPABILITIES,
  PRODUCT_CAPABILITY_LIST,
  PRODUCT_FEATURE_CATEGORIES,
  type ProductCapability,
  type ProductFeatureCategory,
  type ProductFeatureId,
  capabilityById,
} from '../lib/productCapabilities'
import type { TutorialActionState } from '../lib/tutorialActions'
import {
  TUTORIAL_MEDIA,
  TUTORIAL_TOPICS,
  TUTORIAL_TOPIC_LIST,
  tutorialById,
} from '../lib/tutorialCatalog'
import { markTutorialRead, readTutorialProgress, tutorialIsRead } from '../lib/tutorialProgress'
import { cn } from '../lib/utils'
import { Badge, Button, IconButton } from './ui'

const ICONS: Record<string, LucideIcon> = {
  message: MessageCircle,
  history: History,
  cpu: Cpu,
  paperclip: Paperclip,
  mic: Mic,
  search: Search,
  download: Download,
  image: Image,
  git: GitBranch,
  bot: Bot,
  users: Users,
  brain: Brain,
  clock: Clock3,
  sparkles: Sparkles,
  plug: Plug,
  store: Store,
  upload: Upload,
  bell: Bell,
  settings: Settings,
  wallet: Wallet,
  building: Building2,
  'message-square': MessageSquare,
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
}

export function tutorialMatches(feature: ProductCapability, query: string): boolean {
  const q = normalizeSearch(query)
  if (!q) return true
  const topic = tutorialById(feature.id as ProductFeatureId)
  const haystack = normalizeSearch(
    [
      feature.title,
      feature.shortTitle,
      ...feature.aliases,
      topic.intro,
      topic.outcome,
      ...topic.scenarios,
      ...topic.steps.flatMap((step) => [step.title, step.body]),
    ].join(' '),
  )
  return q.split(' ').every((term) => haystack.includes(term))
}

export function TutorialCenter({
  open,
  topicId,
  onTopicChange,
  onClose,
  actionState,
  onRunAction,
}: {
  open: boolean
  topicId: ProductFeatureId
  onTopicChange: (id: ProductFeatureId) => void
  onClose: () => void
  actionState: (feature: ProductCapability) => TutorialActionState
  onRunAction: (feature: ProductCapability) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ProductFeatureCategory | 'all'>('all')
  const [progress, setProgress] = useState(() => readTutorialProgress())
  const [videoFailed, setVideoFailed] = useState<Record<string, boolean>>({})
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  const feature = capabilityById(topicId)
  const topic = tutorialById(topicId)
  const media = TUTORIAL_MEDIA[topic.media]
  const cta = actionState(feature)

  const filtered = useMemo(
    () =>
      PRODUCT_CAPABILITY_LIST.filter(
        (item) =>
          (category === 'all' || item.category === category) && tutorialMatches(item, query),
      ),
    [category, query],
  )
  const mobileOptions = filtered.some((item) => item.id === topicId)
    ? filtered
    : [feature, ...filtered]

  const readCount = TUTORIAL_TOPIC_LIST.filter((item) =>
    tutorialIsRead(progress, item.featureId),
  ).length

  useEffect(() => {
    if (!open) {
      setQuery('')
      setCategory('all')
      return
    }
    const timer = window.setTimeout(() => setProgress(markTutorialRead(topicId)), 900)
    return () => window.clearTimeout(timer)
  }, [open, topicId])

  useEffect(
    () => () => {
      if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const copyExample = () => {
    if (!topic.example) return
    void navigator.clipboard
      ?.writeText(topic.example)
      .then(() => {
        setCopied(true)
        if (copyTimer.current != null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {})
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="tutorial-shell fixed inset-x-2 bottom-2 top-2 z-50 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg shadow-float focus:outline-none data-[state=open]:animate-in sm:inset-x-4 sm:bottom-4 sm:top-4 lg:left-1/2 lg:w-[min(1180px,calc(100vw-2rem))] lg:-translate-x-1/2"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/90 px-3 py-3 backdrop-blur-xl sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-grad-cta text-white shadow-sm">
                <Lightbulb size={18} />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="truncate text-[15px] font-semibold text-fg sm:text-[17px]">
                  使用教程
                </Dialog.Title>
                <p className="hidden text-[11.5px] text-faint sm:block">
                  边看边用 · 每个入口都与真实功能相连
                </p>
              </div>
            </div>

            <label className="ml-auto flex h-9 min-w-0 max-w-md flex-1 items-center gap-2 rounded-xl bg-hover px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search size={15} className="shrink-0 text-faint" />
              <span className="sr-only">搜索教程</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索功能、场景或关键词"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
              />
            </label>

            <div className="hidden shrink-0 items-center gap-2 text-[11.5px] text-faint md:flex">
              <span>
                {readCount}/{TUTORIAL_TOPIC_LIST.length} 已读
              </span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-hover" aria-hidden>
                <span
                  className="block h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${(readCount / TUTORIAL_TOPIC_LIST.length) * 100}%` }}
                />
              </span>
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭教程" variant="muted" shape="square">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </header>

          <div className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-2 lg:hidden">
            <CategoryChip active={category === 'all'} onClick={() => setCategory('all')}>
              全部
            </CategoryChip>
            {PRODUCT_FEATURE_CATEGORIES.map((item) => (
              <CategoryChip
                key={item.id}
                active={category === item.id}
                onClick={() => setCategory(item.id)}
              >
                {item.label}
              </CategoryChip>
            ))}
          </div>

          <div className="flex min-h-0 flex-1">
            <aside className="hidden w-[292px] shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
              <div className="flex flex-col gap-1 p-3">
                <button
                  type="button"
                  onClick={() => setCategory('all')}
                  className={cn(
                    'rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    category === 'all'
                      ? 'bg-active text-fg'
                      : 'text-muted hover:bg-hover hover:text-fg',
                  )}
                >
                  全部功能{' '}
                  <span className="float-right text-faint">{PRODUCT_CAPABILITY_LIST.length}</span>
                </button>
                {PRODUCT_FEATURE_CATEGORIES.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => setCategory(item.id)}
                    title={item.description}
                    className={cn(
                      'rounded-lg px-3 py-2 text-left text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      category === item.id
                        ? 'bg-active text-fg'
                        : 'text-muted hover:bg-hover hover:text-fg',
                    )}
                  >
                    {item.label}
                    <span className="float-right text-faint">
                      {
                        PRODUCT_CAPABILITY_LIST.filter(
                          (featureItem) => featureItem.category === item.id,
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </div>

              <nav
                aria-label="教程目录"
                className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3"
              >
                <TopicList
                  items={filtered}
                  activeId={topicId}
                  isRead={(id) => tutorialIsRead(progress, id)}
                  onSelect={onTopicChange}
                />
              </nav>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col bg-bg">
              <div className="border-b border-border bg-surface px-3 py-2 lg:hidden">
                <select
                  aria-label="选择教程"
                  value={topicId}
                  onChange={(event) => onTopicChange(event.target.value as ProductFeatureId)}
                  className="h-9 w-full rounded-lg border border-border bg-bg px-3 text-[13px] text-fg outline-none focus:ring-2 focus:ring-ring"
                >
                  {mobileOptions.length > 0 ? (
                    mobileOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id === topicId && !filtered.some((match) => match.id === topicId)
                          ? `当前 · ${item.shortTitle}`
                          : item.shortTitle}
                      </option>
                    ))
                  ) : (
                    <option value={topicId}>没有匹配教程</option>
                  )}
                </select>
              </div>

              <main
                className="tutorial-detail min-h-0 flex-1 overflow-y-auto"
                data-topic-id={topicId}
              >
                <article className="mx-auto max-w-3xl px-4 pb-12 pt-7 sm:px-7 sm:pt-9">
                  <div className="flex items-start gap-4">
                    <FeatureIcon feature={feature} className="hidden sm:flex" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{categoryLabel(feature.category)}</Badge>
                        <span className="text-[11px] text-faint">
                          内容版本 {topic.contentVersion}
                        </span>
                        {tutorialIsRead(progress, topicId) && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-success">
                            <Check size={11} /> 已读
                          </span>
                        )}
                      </div>
                      <h1 className="text-balance text-[25px] font-bold leading-tight tracking-tight text-fg sm:text-[32px]">
                        {feature.title}
                      </h1>
                      <p className="mt-3 text-[14.5px] leading-7 text-muted">{topic.intro}</p>
                    </div>
                  </div>

                  <section className="mt-7 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                    <div className="aspect-video w-full bg-sidebar">
                      {videoFailed[topic.media] ? (
                        <div className="relative h-full w-full">
                          <img
                            src={media.poster}
                            alt={media.caption}
                            className="h-full w-full object-cover"
                          />
                          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-4 pb-3 pt-10 text-[12px] text-white">
                            演示视频暂不可播放，已显示同一功能截图。
                          </div>
                        </div>
                      ) : (
                        <video
                          key={media.video}
                          controls
                          playsInline
                          muted
                          preload="metadata"
                          poster={media.poster}
                          aria-label={`${feature.shortTitle}演示视频`}
                          onError={() =>
                            setVideoFailed((current) => ({ ...current, [topic.media]: true }))
                          }
                          className="h-full w-full object-cover"
                        >
                          <source src={media.video} type="video/webm; codecs=vp8" />
                        </video>
                      )}
                    </div>
                    <p className="border-t border-border px-4 py-2.5 text-[11.5px] text-faint">
                      {media.caption}
                    </p>
                  </section>

                  <section className="mt-7 rounded-2xl bg-accent-soft p-5">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
                      完成后你能
                    </div>
                    <p className="mt-1.5 text-[15px] font-medium leading-6 text-fg">
                      {topic.outcome}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {topic.scenarios.map((scenario) => (
                        <span
                          key={scenario}
                          className="rounded-full bg-surface px-2.5 py-1 text-[11.5px] text-muted shadow-sm"
                        >
                          {scenario}
                        </span>
                      ))}
                    </div>
                  </section>

                  <section className="mt-9">
                    <h2 className="text-[19px] font-semibold tracking-tight text-fg">跟着做</h2>
                    <ol className="mt-4 flex flex-col gap-5">
                      {topic.steps.map((step, index) => (
                        <li key={step.title} className="flex gap-3.5">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-grad-cta text-[12px] font-semibold text-white">
                            {index + 1}
                          </span>
                          <div>
                            <h3 className="text-[14px] font-semibold text-fg">{step.title}</h3>
                            <p className="mt-1 text-[13.5px] leading-6 text-muted">{step.body}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {topic.example && (
                    <section className="mt-9 rounded-2xl border border-border bg-surface p-4 sm:p-5">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="text-[14px] font-semibold text-fg">可以直接参考的说法</h2>
                        <Button variant="ghost" size="sm" onClick={copyExample}>
                          {copied ? <Check size={14} /> : <Copy size={14} />}
                          {copied ? '已复制' : '复制示例'}
                        </Button>
                      </div>
                      <blockquote className="mt-3 border-l-2 border-accent pl-3 text-[13.5px] leading-6 text-muted">
                        {topic.example}
                      </blockquote>
                    </section>
                  )}

                  <div className="mt-9 grid gap-4 sm:grid-cols-2">
                    <InfoBox icon={Lightbulb} title="实用建议" tone="accent" items={topic.tips} />
                    <InfoBox
                      icon={TriangleAlert}
                      title="使用前留意"
                      tone="warning"
                      items={topic.cautions}
                    />
                  </div>

                  <section className="mt-9 rounded-2xl border border-border bg-surface p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h2 className="text-[15px] font-semibold text-fg">
                          现在去真实功能里试一遍
                        </h2>
                        <p className="mt-1 text-[12.5px] text-muted">
                          教程不会替你发送消息、修改设置或执行付费操作。
                        </p>
                        {!cta.enabled && cta.disabledReason && (
                          <p className="mt-1.5 text-[12px] text-warning">{cta.disabledReason}</p>
                        )}
                      </div>
                      <Button
                        variant="primary"
                        disabled={!cta.enabled}
                        onClick={() => onRunAction(feature)}
                        className="shrink-0"
                      >
                        {cta.label} <ArrowRight size={15} />
                      </Button>
                    </div>
                  </section>

                  <section className="mt-9">
                    <h2 className="text-[14px] font-semibold text-fg">接着了解</h2>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {topic.related.map((relatedId) => {
                        const related = capabilityById(relatedId)
                        const RelatedIcon = ICONS[related.icon] ?? Sparkles
                        return (
                          <button
                            key={relatedId}
                            type="button"
                            onClick={() => onTopicChange(relatedId)}
                            className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-left text-[12px] text-muted outline-none transition-colors hover:border-accent/40 hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <RelatedIcon size={14} className="shrink-0 text-accent" />
                            <span className="min-w-0 flex-1 truncate">{related.shortTitle}</span>
                            <ArrowRight size={12} className="text-faint" />
                          </button>
                        )
                      })}
                    </div>
                  </section>
                </article>
              </main>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function TopicList({
  items,
  activeId,
  isRead,
  onSelect,
}: {
  items: ProductCapability[]
  activeId: ProductFeatureId
  isRead: (id: ProductFeatureId) => boolean
  onSelect: (id: ProductFeatureId) => void
}) {
  if (items.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-[12.5px] text-faint">
        没有匹配的教程，换个关键词试试。
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        const id = item.id as ProductFeatureId
        const Icon = ICONS[item.icon] ?? Sparkles
        return (
          <button
            key={id}
            type="button"
            aria-current={id === activeId ? 'page' : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              'group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              id === activeId ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
            )}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-faint shadow-sm group-hover:text-accent">
              <Icon size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {item.shortTitle}
            </span>
            {isRead(id) && <Check size={13} className="shrink-0 text-success" aria-label="已读" />}
          </button>
        )
      })}
    </div>
  )
}

function FeatureIcon({ feature, className }: { feature: ProductCapability; className?: string }) {
  const Icon = ICONS[feature.icon] ?? Sparkles
  return (
    <span
      className={cn(
        'size-12 shrink-0 items-center justify-center rounded-2xl bg-grad-cta text-white shadow-sm',
        className,
      )}
    >
      <Icon size={22} />
    </span>
  )
}

function InfoBox({
  icon: Icon,
  title,
  tone,
  items,
}: {
  icon: LucideIcon
  title: string
  tone: 'accent' | 'warning'
  items: readonly string[]
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border p-4',
        tone === 'accent' ? 'border-accent/20 bg-accent-soft' : 'border-warning/20 bg-warning-soft',
      )}
    >
      <h2
        className={cn(
          'flex items-center gap-1.5 text-[13px] font-semibold',
          tone === 'accent' ? 'text-accent' : 'text-warning',
        )}
      >
        <Icon size={15} /> {title}
      </h2>
      <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-5 text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

function categoryLabel(id: ProductFeatureCategory): string {
  return PRODUCT_FEATURE_CATEGORIES.find((item) => item.id === id)?.label ?? id
}

export const DEFAULT_TUTORIAL_TOPIC = PRODUCT_CAPABILITIES.chatBasics.id
