/**
 * 详情面板「产出」页(OCV5-372 / OCV5-687):默认汇总展示本会话全部产出(按轮分组,当前轮在上),
 * 主产物直接渲染在顶部卡片里;后续轮无新增文件时无需点箭头翻找历史轮次;首轮及运行中展示安静
 * 进行态,绝不先闪「还没有产出 / 这一轮没有产出文件」。
 * 数据全部来自 workbench.ts 的纯函数;正文渲染在懒加载块 OutputPreview 里,不进首屏。
 */
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  ImageIcon,
  Inbox,
  MonitorPlay,
} from 'lucide-react'
import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../lib/chat/model'
import { cn } from '../../lib/utils'
import type { ToolLike } from '../tool/format'
import { SegmentedControl, Skeleton, Spinner } from '../ui'
import { useSignedDownload, useSignedSrc } from './media'
import { CopyIconButton, FileChangeEntryView, LineCounts } from './paneParts'
import type { WorkTurn } from './workTurns'
import {
  type HeroRef,
  type OutputFile,
  type OutputKind,
  type OutputMedia,
  type TurnOutputs,
  baseName,
  collectTurnOutputs,
  displayDir,
  extOf,
  fileSnapshot,
  fileTouchFingerprint,
  formatDuration,
  outputKindOf,
  pickHero,
  turnSummary,
} from './workbench'

const FilePreview = lazy(() => import('./OutputPreview').then((m) => ({ default: m.FilePreview })))
const MediaPreview = lazy(() =>
  import('./OutputPreview').then((m) => ({ default: m.MediaPreview })),
)

type HeroView = 'preview' | 'source' | 'changes'

/** 参考来源默认只列前几条,其余收在「显示全部」里:一次搜索常带回十来条,全列会把面板拉得很长。 */
const SOURCES_PREVIEW = 5

const KIND_LABEL: Record<OutputKind, string> = {
  html: '网页',
  markdown: '文档',
  csv: '表格',
  office: '文档',
  image: '图片',
  code: '代码',
  text: '文本',
  file: '文件',
}

const sectionLabel =
  'mb-2 flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-faint'
const quietRow =
  'group flex w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11'

function ExtTile({
  path,
  kind,
  className,
}: { path: string; kind: OutputKind; className?: string }) {
  const ext = extOf(path).slice(0, 4).toUpperCase() || 'FILE'
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-surface font-mono text-[9.5px] font-semibold tracking-tight',
        kind === 'html'
          ? 'text-accent'
          : kind === 'markdown' || kind === 'office'
            ? 'text-info'
            : kind === 'csv'
              ? 'text-success'
              : 'text-muted',
        className,
      )}
    >
      {ext}
    </span>
  )
}

/** 本轮标题 + 翻轮 + 一行摘要(BrowserView 浏览器视图继续复用)。 */
export function TurnBar({
  turn,
  index,
  total,
  running,
  fileCount,
  onPrev,
  onNext,
  onOpenSteps,
}: {
  turn: WorkTurn
  index: number
  total: number
  running: boolean
  fileCount: number
  onPrev: () => void
  onNext: () => void
  onOpenSteps: () => void
}) {
  const s = turnSummary(turn, running)
  const parts: ReactNode[] = []
  if (s.durationMs !== null && !running) parts.push(`用时 ${formatDuration(s.durationMs)}`)
  if (s.steps > 0)
    parts.push(`${s.steps} 步${s.failedSteps > 0 ? `（${s.failedSteps} 步失败）` : ''}`)
  if (fileCount > 0) parts.push(`${fileCount} 个文件`)
  return (
    <div className="px-4 pt-4 pb-3" data-testid="outputs-turn">
      <div className="mb-1.5 flex items-center gap-1 text-caption text-faint">
        <button
          type="button"
          aria-label="上一轮"
          disabled={index <= 0}
          onClick={onPrev}
          className="rounded-full p-1 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="tabular-nums" data-testid="outputs-turn-counter">
          第 {index + 1} / {total} 轮
        </span>
        <button
          type="button"
          aria-label="下一轮"
          disabled={index >= total - 1}
          onClick={onNext}
          className="rounded-full p-1 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight size={14} />
        </button>
        <span className="flex-1" />
        {s.status === 'running' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
            <Spinner size={11} />
            进行中
          </span>
        ) : s.status === 'error' ? (
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-danger">出错</span>
        ) : null}
      </div>
      <h3
        className="line-clamp-2 text-section font-semibold leading-snug text-fg"
        title={turn.title}
      >
        {turn.title}
      </h3>
      <p
        className="mt-1 flex flex-wrap items-center gap-x-1.5 text-meta text-faint"
        data-testid="outputs-summary"
      >
        {parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 摘要片段按位置
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            {p}
          </span>
        ))}
        {s.steps > 0 && (
          <button
            type="button"
            onClick={onOpenSteps}
            data-testid="outputs-open-steps"
            className={cn(
              'inline-flex items-center rounded text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring',
              parts.length > 0 && 'ml-1',
            )}
          >
            查看步骤
            <ChevronRight size={13} aria-hidden />
          </button>
        )}
      </p>
    </div>
  )
}

/** 产出页按轮分组的轮次头:直接显示第几轮与摘要,无需用户点左右箭头翻找。 */
function TurnGroupHeader({
  turn,
  turnIndex,
  totalTurns,
  running,
  fileCount,
  onOpenSteps,
}: {
  turn: WorkTurn
  turnIndex: number
  totalTurns: number
  running: boolean
  fileCount: number
  onOpenSteps: () => void
}) {
  const s = turnSummary(turn, running)
  const parts: ReactNode[] = []
  if (s.durationMs !== null && !running) parts.push(`用时 ${formatDuration(s.durationMs)}`)
  if (s.steps > 0)
    parts.push(`${s.steps} 步${s.failedSteps > 0 ? `（${s.failedSteps} 步失败）` : ''}`)
  if (fileCount > 0) parts.push(`${fileCount} 个文件`)
  const isLatest = turnIndex === totalTurns - 1
  return (
    <div className="px-4 pt-4 pb-2" data-testid="outputs-turn">
      <div className="mb-1 flex items-center gap-2 text-caption text-faint">
        <span className="tabular-nums font-medium text-muted" data-testid="outputs-turn-counter">
          第 {turnIndex + 1} 轮
        </span>
        {isLatest && totalTurns > 1 && !running && (
          <span className="rounded-full bg-hover px-2 py-0.5 text-muted">当前轮</span>
        )}
        <span className="flex-1" />
        {s.status === 'running' ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-accent">
            <Spinner size={11} />
            进行中
          </span>
        ) : s.status === 'error' ? (
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-danger">出错</span>
        ) : null}
      </div>
      <h3 className="line-clamp-2 text-body font-semibold leading-snug text-fg" title={turn.title}>
        {turn.title}
      </h3>
      {(parts.length > 0 || s.steps > 0) && (
        <p
          className="mt-1 flex flex-wrap items-center gap-x-1.5 text-meta text-faint"
          data-testid="outputs-summary"
        >
          {parts.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 摘要片段按位置
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden>·</span>}
              {p}
            </span>
          ))}
          {s.steps > 0 && (
            <button
              type="button"
              onClick={onOpenSteps}
              data-testid="outputs-open-steps"
              className={cn(
                'inline-flex items-center rounded text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring',
                parts.length > 0 && 'ml-1',
              )}
            >
              查看步骤
              <ChevronRight size={13} aria-hidden />
            </button>
          )}
        </p>
      )}
    </div>
  )
}

function PreviewFallback() {
  return (
    <div className="space-y-2 px-5 py-5">
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  )
}

function DownloadButton({ path, name }: { path: string; name: string }) {
  const { state, start } = useSignedDownload(path, name)
  const busy = state.phase === 'downloading'
  return (
    <button
      type="button"
      aria-label={`下载 ${name}`}
      title="下载"
      onClick={() => void start()}
      disabled={busy}
      className="inline-flex size-7 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {busy ? <Spinner size={13} /> : <Download size={15} />}
    </button>
  )
}

/** 主卡片:文件。 */
function FileHero({
  file,
  messages,
  turnEnd,
  onOpenStep,
}: {
  file: OutputFile
  messages: readonly ChatMessage[]
  turnEnd: ChatMessage | undefined
  onOpenStep: (message: ToolLike) => void
}) {
  const previewable =
    file.kind === 'html' ||
    file.kind === 'markdown' ||
    file.kind === 'csv' ||
    file.kind === 'office'
  const textual = file.kind !== 'file' && file.kind !== 'office'
  const canRenderBody = textual || file.kind === 'office'
  const change = file.change
  const options = [
    ...(previewable ? [{ value: 'preview' as const, label: '预览' }] : []),
    ...(textual ? [{ value: 'source' as const, label: previewable ? '源码' : '内容' }] : []),
    ...(change ? [{ value: 'changes' as const, label: `改动 ${change.entries.length}` }] : []),
  ]
  const [chosen, setChosen] = useState<HeroView | null>(null)
  const view: HeroView =
    chosen && options.some((o) => o.value === chosen) ? chosen : (options[0]?.value ?? 'changes')
  // 不按 messages 引用记忆:流式期间消息就地增长,数组引用不变(同 collectPaneSteps,每次渲染重算)。
  const replayed = file.kind === 'office' ? null : fileSnapshot(messages, file.path, turnEnd)
  const dir = displayDir(file.path)
  return (
    <article
      className="overflow-hidden rounded-xl border border-border/70 bg-surface shadow-soft"
      data-testid="outputs-hero"
      aria-label={`${KIND_LABEL[file.kind]} ${file.name}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3.5 py-2.5">
        <ExtTile path={file.path} kind={file.kind} />
        <div className="min-w-[8rem] flex-1" title={file.path}>
          <div className="truncate text-body font-medium text-fg" data-testid="outputs-hero-name">
            {file.name}
          </div>
          {dir && <div className="truncate text-caption text-faint">{dir}</div>}
        </div>
        {options.length > 1 && (
          <SegmentedControl
            className="ml-auto"
            size="sm"
            value={view}
            onValueChange={(v) => setChosen(v)}
            options={options}
            aria-label="查看方式"
          />
        )}
      </header>
      <div
        className={cn(
          'min-h-24',
          view === 'preview' && file.kind === 'csv'
            ? 'overflow-hidden'
            : 'max-h-[68vh] overflow-auto [overflow-wrap:anywhere]',
        )}
        data-testid="outputs-hero-body"
      >
        {view === 'changes' && change ? (
          <div className="space-y-5 px-4 py-3">
            {change.entries.map((entry, i) => (
              <FileChangeEntryView
                key={`${entry.message.id}:${i}`}
                entry={entry}
                n={i + 1}
                onOpenStep={onOpenStep}
              />
            ))}
          </div>
        ) : canRenderBody ? (
          <Suspense fallback={<PreviewFallback />}>
            <FilePreview
              path={file.path}
              name={file.name}
              kind={file.kind}
              replayed={replayed}
              refreshKey={fileTouchFingerprint(messages, file.path)}
              view={view === 'preview' ? 'preview' : 'source'}
            />
          </Suspense>
        ) : (
          <div className="px-5 py-8 text-center text-meta text-muted">
            这类文件不在面板里预览，可以下载查看。
          </div>
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-border/60 px-3.5 py-1.5 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="outputs-hero-origin">
          {view === 'changes'
            ? `${change?.entries.length ?? 0} 次改动`
            : file.kind === 'office'
              ? '容器里的当前文件'
              : !textual
                ? KIND_LABEL[file.kind]
                : replayed !== null
                  ? '内容来自会话记录'
                  : '容器里的当前文件'}
        </span>
        {change && !change.hasError && <LineCounts added={change.added} removed={change.removed} />}
        <CopyIconButton getText={() => file.path} label="复制路径" doneText="已复制路径" />
        {file.path.startsWith('/') && <DownloadButton path={file.path} name={file.name} />}
      </footer>
    </article>
  )
}

function MediaHero({ media }: { media: OutputMedia }) {
  return (
    <article
      className="overflow-hidden rounded-xl border border-border/70 bg-surface shadow-soft"
      data-testid="outputs-hero"
      aria-label={`图片 ${media.name}`}
    >
      <Suspense fallback={<PreviewFallback />}>
        <MediaPreview src={media.src} kind={media.kind} name={media.name} />
      </Suspense>
      <footer className="flex items-center gap-2 border-t border-border/60 px-3.5 py-1.5 text-caption text-faint">
        <span className="min-w-0 flex-1 truncate" data-testid="outputs-hero-name" title={media.src}>
          {media.name}
        </span>
        <CopyIconButton getText={() => media.src} label="复制路径" doneText="已复制路径" />
        {media.src.startsWith('/') && <DownloadButton path={media.src} name={media.name} />}
      </footer>
    </article>
  )
}

function Thumb({
  media,
  active,
  onPick,
}: { media: OutputMedia; active: boolean; onPick: () => void }) {
  const { url, onError } = useSignedSrc(media.kind === 'image' ? media.src : null)
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`查看 ${media.name}`}
      aria-pressed={active}
      data-testid="outputs-media"
      className={cn(
        'relative aspect-square overflow-hidden rounded-lg border bg-hover outline-none transition focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-accent ring-2 ring-accent/25'
          : 'border-border/70 hover:border-border-strong',
      )}
    >
      {url ? (
        <img src={url} alt="" onError={onError} className="size-full object-cover" loading="lazy" />
      ) : (
        <span className="flex size-full items-center justify-center text-faint">
          <ImageIcon size={16} />
        </span>
      )}
    </button>
  )
}

function Section({
  icon: Icon,
  title,
  count,
  children,
  testId,
}: {
  icon: typeof Globe
  title: string
  count: number
  children: ReactNode
  testId: string
}) {
  return (
    <section data-testid={testId}>
      <h4 className={sectionLabel}>
        <Icon size={12} aria-hidden />
        {title}
        <span className="tabular-nums font-normal">{count}</span>
      </h4>
      {children}
    </section>
  )
}

function OtherOutputs({
  outputs,
  hero,
  onPick,
}: {
  outputs: TurnOutputs
  hero: HeroRef | null
  onPick: (ref: HeroRef) => void
}) {
  const { files, media, links, sources } = outputs
  const [allSources, setAllSources] = useState(false)
  const shownSources = allSources ? sources : sources.slice(0, SOURCES_PREVIEW)
  return (
    <div className="space-y-4 px-4 pt-2 pb-5">
      {files.length > 0 && (
        <Section icon={FileCode2} title="文件" count={files.length} testId="outputs-files">
          <ul className="-mx-2">
            {files.map((f) => {
              const active = hero?.type === 'file' && hero.path === f.path
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    data-testid="outputs-file"
                    aria-current={active ? 'true' : undefined}
                    className={cn(quietRow, active && 'bg-accent-soft hover:bg-accent-soft')}
                    onClick={() => onPick({ type: 'file', path: f.path })}
                    title={f.path}
                  >
                    <ExtTile path={f.path} kind={f.kind} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-fg">{f.name}</span>
                      <span className="block truncate text-caption text-faint">
                        {f.change
                          ? `${KIND_LABEL[f.kind]} · ${f.change.entries.length} 次改动`
                          : `${KIND_LABEL[f.kind]} · 回答里提到`}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-meta">
                      {f.change?.running && <Spinner size={12} className="text-accent" />}
                      {f.change?.hasError && <span className="text-danger">有失败</span>}
                      {f.change && <LineCounts added={f.change.added} removed={f.change.removed} />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      )}
      {media.length > 0 && (
        <Section
          icon={ImageIcon}
          title="图片与媒体"
          count={media.length}
          testId="outputs-media-grid"
        >
          <div className="grid grid-cols-3 gap-2">
            {media.map((m) => (
              <Thumb
                key={m.src}
                media={m}
                active={hero?.type === 'media' && hero.src === m.src}
                onPick={() => onPick({ type: 'media', src: m.src })}
              />
            ))}
          </div>
        </Section>
      )}
      {links.length > 0 && (
        <Section icon={MonitorPlay} title="本机预览" count={links.length} testId="outputs-links">
          <ul className="-mx-2">
            {links.map((l) => (
              <li key={l.url}>
                {/* 普通链接:App 的全局点击监听会把容器回环地址交给「容器预览」打开。 */}
                <a href={l.url} className={quietRow} data-testid="outputs-link">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <MonitorPlay size={15} />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg">
                    {l.label}
                  </span>
                  <span className="shrink-0 text-caption text-faint">打开预览</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {sources.length > 0 && (
        <Section icon={Globe} title="参考来源" count={sources.length} testId="outputs-sources">
          <ul className="-mx-2">
            {shownSources.map((s) => (
              <li key={s.url} data-container-preview-ignore="">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={quietRow}
                  data-testid="outputs-source"
                  title={s.url}
                >
                  <span
                    aria-hidden
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold uppercase text-muted"
                  >
                    {s.domain.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{s.title}</span>
                    <span className="block truncate text-caption text-faint">{s.domain}</span>
                  </span>
                  <ExternalLink
                    size={13}
                    className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  />
                </a>
              </li>
            ))}
          </ul>
          {sources.length > SOURCES_PREVIEW && (
            <button
              type="button"
              onClick={() => setAllSources((v) => !v)}
              aria-expanded={allSources}
              data-testid="outputs-sources-more"
              className="mt-1 rounded-full px-2 py-1 text-meta text-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              {allSources ? '收起' : `显示全部 ${sources.length} 条`}
            </button>
          )}
        </Section>
      )}
    </div>
  )
}

type TurnEntry = {
  turn: WorkTurn
  turnIndex: number
  isLatest: boolean
  turnRunning: boolean
  outputs: TurnOutputs
  fileCount: number
  hasOutputs: boolean
}

type PickedHero = {
  turnKey: string | null
  hero: HeroRef
  fromNonce: number
}

export function OutputsView({
  messages,
  turns,
  focusTurnKey = null,
  focusFile = null,
  running,
  onOpenSteps,
  onOpenStep,
}: {
  messages: readonly ChatMessage[]
  turns: readonly WorkTurn[]
  /** 兼容旧入参。 */
  index?: number
  /** 从某轮过程摘要「查看文件」点开时优先聚焦该轮主产物(下方仍展示全会话产出)。 */
  focusTurnKey?: string | null
  /** 从聊天文件卡片点击预览时聚焦的文件。 */
  focusFile?: { path: string; nonce: number } | null
  /** 当前会话是否正在运行。 */
  running: boolean
  onSelectTurn?: (index: number) => void
  onOpenSteps: () => void
  onOpenStep: (message: ToolLike) => void
}) {
  const [picked, setPicked] = useState<PickedHero | null>(() =>
    focusFile
      ? { turnKey: null, hero: { type: 'file', path: focusFile.path }, fromNonce: focusFile.nonce }
      : null,
  )
  const lastFocusNonce = useRef<number | undefined>(focusFile?.nonce)
  useEffect(() => {
    if (!focusFile || focusFile.nonce === lastFocusNonce.current) return
    lastFocusNonce.current = focusFile.nonce
    setPicked({
      turnKey: null,
      hero: { type: 'file', path: focusFile.path },
      fromNonce: focusFile.nonce,
    })
  }, [focusFile])

  // 当前同一渲染帧内 focusFile 刚更新时立即生效,不等 effect 下一拍。
  const effectivePicked: PickedHero | null =
    focusFile && focusFile.nonce !== lastFocusNonce.current
      ? { turnKey: null, hero: { type: 'file', path: focusFile.path }, fromNonce: focusFile.nonce }
      : picked

  // 按轮倒序(当前轮在上)。
  const turnEntries: TurnEntry[] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const outputs = collectTurnOutputs(turn)
    const fileCount = outputs.files.filter((f) => f.change).length
    const hasOutputs =
      outputs.files.length + outputs.media.length + outputs.links.length + outputs.sources.length >
      0
    turnEntries.push({
      turn,
      turnIndex: i,
      isLatest: i === turns.length - 1,
      turnRunning: running && i === turns.length - 1,
      outputs,
      fileCount,
      hasOutputs,
    })
  }

  // 会话尚未产生任何轮次
  if (turnEntries.length === 0 && !focusFile) {
    if (running) {
      return (
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="outputs-view">
          <div
            className="mx-4 mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center"
            data-testid="outputs-running"
          >
            <Spinner size={18} className="text-accent" />
            <p className="text-body font-medium text-fg">正在处理中</p>
            <p className="text-meta text-muted">
              写出的文件、生成的图片和查过的网页会实时出现在这里。
            </p>
          </div>
        </div>
      )
    }
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
        data-testid="outputs-empty"
      >
        <Inbox size={22} className="text-faint" aria-hidden />
        <p className="text-body font-medium text-fg">还没有产出</p>
        <p className="text-meta text-muted">
          助手写的文件、生成的图片、查过的网页会按轮汇总在这里。
        </p>
      </div>
    )
  }

  const entriesWithOutputs = turnEntries.filter((e) => e.hasOutputs)
  const latest = turnEntries[0]

  // 整个会话目前所有轮次都没有产出,且没有外部点选文件
  if (entriesWithOutputs.length === 0 && !focusFile) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="outputs-view">
        {latest && (
          <TurnGroupHeader
            turn={latest.turn}
            turnIndex={latest.turnIndex}
            totalTurns={turns.length}
            running={latest.turnRunning}
            fileCount={0}
            onOpenSteps={onOpenSteps}
          />
        )}
        {running ? (
          <div
            className="mx-4 mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center"
            data-testid="outputs-running"
          >
            <Spinner size={18} className="text-accent" />
            <p className="text-body font-medium text-fg">正在处理中</p>
            <p className="text-meta text-muted">
              写出的文件、生成的图片和查过的网页会实时出现在这里。
            </p>
          </div>
        ) : (
          <div
            className="mx-4 mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center"
            data-testid="outputs-none"
          >
            <FileText size={20} className="text-faint" aria-hidden />
            <p className="text-body font-medium text-fg">还没有产出文件</p>
            <p className="text-meta text-muted">
              回答在左侧对话里；想看助手做了什么，可以查看步骤。
            </p>
          </div>
        )}
      </div>
    )
  }

  // 解析顶部主产物(优先: 用户点选 / 聊天卡片聚焦 → 指定轮次 → 最近有主产物的轮次)
  let heroTurn: TurnEntry | undefined
  let activeHero: HeroRef | null = null
  let heroFile: OutputFile | undefined
  let heroMedia: OutputMedia | undefined

  const findHeroInEntries = (ref: HeroRef, preferredTurnKey: string | null): boolean => {
    const ordered = preferredTurnKey
      ? [
          ...entriesWithOutputs.filter((e) => e.turn.key === preferredTurnKey),
          ...entriesWithOutputs.filter((e) => e.turn.key !== preferredTurnKey),
        ]
      : entriesWithOutputs
    for (const entry of ordered) {
      if (ref.type === 'file') {
        const found = entry.outputs.files.find((f) => f.path === ref.path)
        if (found) {
          heroTurn = entry
          activeHero = ref
          heroFile = found
          return true
        }
      } else {
        const found = entry.outputs.media.find((m) => m.src === ref.src)
        if (found) {
          heroTurn = entry
          activeHero = ref
          heroMedia = found
          return true
        }
      }
    }
    return false
  }

  if (effectivePicked) {
    const matched = findHeroInEntries(effectivePicked.hero, effectivePicked.turnKey)
    if (!matched && effectivePicked.hero.type === 'file') {
      // 聊天中点击了附件或卡片链接(尚未落进某轮输出列表时),直接合成文件预览对象
      const p = effectivePicked.hero.path
      activeHero = effectivePicked.hero
      heroFile = { path: p, name: baseName(p), kind: outputKindOf(p) }
      heroTurn = latest
    }
  }

  if (!activeHero && focusTurnKey) {
    const target = entriesWithOutputs.find((e) => e.turn.key === focusTurnKey)
    const h = target ? pickHero(target.outputs) : null
    if (target && h) findHeroInEntries(h, target.turn.key)
  }

  if (!activeHero) {
    for (const entry of entriesWithOutputs) {
      const h = pickHero(entry.outputs)
      if (h && findHeroInEntries(h, entry.turn.key)) break
    }
  }

  const heroTurnEnd = heroTurn?.turn.rows.at(-1) ?? turns.at(-1)?.rows.at(-1)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="outputs-view">
      {/* 当前轮正在运行但尚未写出新文件时:顶部给一行安静状态,下方保留历史产出预览,不闪空态 */}
      {latest?.turnRunning && !latest.hasOutputs && (
        <div
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-hover/40 px-3 py-2 text-meta text-muted"
          data-testid="outputs-running"
        >
          <Spinner size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-fg">
            第 {latest.turnIndex + 1} 轮进行中 · {latest.turn.title}
          </span>
          {latest.turn.steps.length > 0 && (
            <button
              type="button"
              onClick={onOpenSteps}
              data-testid="outputs-open-steps"
              className="inline-flex shrink-0 items-center text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              查看步骤
              <ChevronRight size={13} aria-hidden />
            </button>
          )}
        </div>
      )}

      {/* 当前轮已结束且无新增文件,但历史轮次有产出:给一行安静提示,直接展示下方历史产出 */}
      {latest && !latest.turnRunning && !latest.hasOutputs && entriesWithOutputs.length > 0 && (
        <div
          className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-hover/35 px-3 py-2 text-caption text-faint"
          data-testid="outputs-latest-note"
        >
          <span className="min-w-0 flex-1 truncate">
            第 {latest.turnIndex + 1} 轮「{latest.turn.title}」无新增产出
          </span>
          {latest.turn.steps.length > 0 && (
            <button
              type="button"
              onClick={onOpenSteps}
              data-testid="outputs-open-steps"
              className="inline-flex shrink-0 items-center text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              查看步骤
              <ChevronRight size={13} aria-hidden />
            </button>
          )}
        </div>
      )}

      {(heroFile || heroMedia) && (
        <div className="px-4 pt-3 pb-1">
          {heroFile ? (
            <FileHero
              key={`${heroTurn?.turn.key ?? 'ext'}:${heroFile.path}`}
              file={heroFile}
              messages={messages}
              turnEnd={heroTurnEnd}
              onOpenStep={onOpenStep}
            />
          ) : heroMedia ? (
            <MediaHero media={heroMedia} />
          ) : null}
        </div>
      )}

      <div className="divide-y divide-border/60">
        {entriesWithOutputs.map((entry) => {
          const groupHero = heroTurn?.turn.key === entry.turn.key ? activeHero : null
          return (
            <div key={entry.turn.key} data-testid="outputs-turn-group">
              <TurnGroupHeader
                turn={entry.turn}
                turnIndex={entry.turnIndex}
                totalTurns={turns.length}
                running={entry.turnRunning}
                fileCount={entry.fileCount}
                onOpenSteps={onOpenSteps}
              />
              <OtherOutputs
                outputs={entry.outputs}
                hero={groupHero}
                onPick={(ref) =>
                  setPicked({
                    turnKey: entry.turn.key,
                    hero: ref,
                    fromNonce: focusFile?.nonce ?? 0,
                  })
                }
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
