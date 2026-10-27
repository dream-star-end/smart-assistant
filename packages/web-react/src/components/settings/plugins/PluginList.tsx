/**
 * 管理中心 → 插件（OCV5-383）：一级列表只有「名称 + 一行状态 + 启用开关」，其余设置都在点进去的详情页里。
 *
 * - 列表行整行可点（进入详情），开关单独响应、不触发进入；
 * - 详情页顶部是返回 + 同一个启用开关；账号、写入、自动回复、更新/卸载等沿用各插件原有的卡片内容；
 * - 本机插件（随平台基线下发、在你的容器里运行，如同花顺行情）的详情由 LocalPluginDetail 渲染：
 *   能做什么、由什么组成、会访问哪些网站、要不要登录、数据声明。
 */
import { ArrowLeft, ChevronRight, Globe, MessageSquarePlus, Plug, SquareTerminal } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LocalPlugin } from '../../../lib/connectors'
import type { PluginEntry } from '../../../lib/pluginDirectory'
import { cn } from '../../../lib/utils'
import { Button, StatusDot, type StatusTone, Switch } from '../../ui'

export type PluginRowModel = {
  key: string
  label: string
  /** 一行状态：已连接 2 个账号 / 未连接 / 需重新授权 / 可直接使用 / 已停用。 */
  status: string
  tone: StatusTone
  runtime: PluginEntry['runtime']
  enabled: boolean
  enablementKnown?: boolean
}

function RuntimeIcon({ runtime }: { runtime: PluginEntry['runtime'] }) {
  const Icon = runtime === 'cli' ? SquareTerminal : runtime === 'browser' ? Globe : Plug
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover text-muted" aria-hidden>
      <Icon size={17} strokeWidth={1.75} />
    </span>
  )
}

export const RUNTIME_LABEL: Record<PluginEntry['runtime'], string> = {
  api: 'API 插件',
  browser: '浏览器插件',
  cli: '本机插件',
}

/** 一级列表的一行：点行进入详情；右侧开关只管启用。 */
export function PluginRow({
  row,
  busy,
  onOpen,
  onToggle,
  onConnect,
}: {
  row: PluginRowModel
  busy?: boolean
  onOpen: () => void
  onConnect?: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <li className="flex items-center gap-2 border-t border-border first:border-t-0" data-plugin-row={row.key}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${row.label}：${row.status}，打开设置`}
        className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-md py-2 pr-1 text-left outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RuntimeIcon runtime={row.runtime} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-fg">{row.label}</span>
          <span className={cn('flex items-center gap-1.5 text-meta', row.enabled ? 'text-muted' : 'text-faint')}>
            <StatusDot tone={row.enabled ? row.tone : 'neutral'} />
            <span className="truncate">{row.enablementKnown === false ? '启用状态暂不可用' : row.enabled ? row.status : '已停用'}</span>
          </span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden />
      </button>
      {onConnect && <Button size="sm" variant="secondary" onClick={onConnect} aria-label={`连接「${row.label}」`}>连接</Button>}
      <Switch
        aria-label={`启用「${row.label}」`}
        checked={row.enablementKnown !== false && row.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        className="mr-1"
      />
    </li>
  )
}

/** 详情页顶栏：返回 + 类型 + 启用开关（与列表里的是同一个状态）。 */
export function PluginDetailBar({
  row,
  busy,
  onBack,
  onToggle,
}: {
  row: PluginRowModel
  busy?: boolean
  onBack: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-3" data-testid="plugin-detail-bar">
      <Button size="sm" variant="ghost" onClick={onBack} aria-label="返回插件列表">
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden /> 插件
      </Button>
      <span className="ml-auto text-meta text-faint">{RUNTIME_LABEL[row.runtime]}</span>
      <span className="text-meta text-muted">{row.enablementKnown === false ? '状态未知' : row.enabled ? '已启用' : '已停用'}</span>
      <Switch aria-label={`启用「${row.label}」`} checked={row.enablementKnown !== false && row.enabled} disabled={busy} onCheckedChange={onToggle} />
    </div>
  )
}

/** 停用时详情页顶部的一句说明（设置仍可改，只是助手暂时用不到）。 */
export function DisabledNote({ label }: { label: string }) {
  return (
    <output className="mt-3 block rounded-md bg-hover px-3 py-2 text-meta text-muted">
      「{label}」已停用：助手暂时不会调用它，账号和设置都保留；打开右上角开关即可恢复。
    </output>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-4 first:border-t-0">
      <h3 className="mb-2 text-meta font-semibold uppercase tracking-[0.04em] text-faint">{title}</h3>
      {children}
    </section>
  )
}

/** 本机插件详情：说明、怎么用、组成、访问的网站、登录、数据声明。 */
export function LocalPluginDetail({
  plugin,
  onAskInChat,
}: {
  plugin: LocalPlugin
  onAskInChat?: (text: string) => void
}) {
  const login = plugin.auth.login
  return (
    <div className="flex flex-col" data-connector-card={plugin.name}>
      <section className="py-4">
        <h2 className="text-title font-semibold text-fg">{plugin.displayName}</h2>
        <p className="mt-1 text-body text-muted">{plugin.description}</p>
        <p className="mt-2 text-meta text-faint">
          {[`v${plugin.version}`, plugin.author.name, plugin.license].filter(Boolean).join(' · ')}
          {plugin.homepage && (
            <>
              {' · '}
              <a href={plugin.homepage} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                项目主页
              </a>
            </>
          )}
        </p>
      </section>

      {plugin.useCases.length > 0 && (
        <Section title="可以这样用">
          <ul className="flex flex-col gap-1.5">
            {plugin.useCases.map((u) => (
              <li key={u}>
                {onAskInChat ? (
                  <button
                    type="button"
                    onClick={() => onAskInChat(u)}
                    className="flex w-full min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-body text-fg hover:bg-hover"
                  >
                    <MessageSquarePlus size={15} className="shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1">{u}</span>
                  </button>
                ) : (
                  <span className="text-body text-fg">{u}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="登录">
        {login ? (
          <>
            <p className="text-body text-muted">{login.description}</p>
            {onAskInChat && login.start && (
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => onAskInChat(login.start!)}>
                在对话中登录
              </Button>
            )}
          </>
        ) : (
          <p className="text-body text-muted">不需要登录，打开就能用。</p>
        )}
      </Section>

      <Section title="组成">
        <ul className="flex flex-col gap-1 text-body text-muted">
          {plugin.components.skills.map((s) => (
            <li key={s.path}>技能说明：教助手什么时候用、怎么用（{s.path}）</li>
          ))}
          {plugin.components.bin.map((b) => (
            <li key={b.name}>
              命令 <code className="rounded bg-code px-1 font-mono text-meta">{b.name}</code>
              {b.description ? `：${b.description}` : ''}
            </li>
          ))}
          {plugin.components.data.map((d) => (
            <li key={d.path}>数据：{d.description ?? d.path}</li>
          ))}
        </ul>
        <p className="mt-2 text-meta text-faint">在你自己的容器里运行，登录信息也只保存在你的容器里。</p>
      </Section>

      <Section title="会访问的网站">
        {plugin.permissions.network.length === 0 ? (
          <p className="text-body text-muted">不访问网络。</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {plugin.permissions.network.map((o) => (
              <li key={o} className="rounded border border-border px-2 py-0.5 font-mono text-meta text-muted">
                {o.replace(/^https?:\/\//, '')}
              </li>
            ))}
          </ul>
        )}
        {plugin.permissions.writes.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-body text-muted">
            {plugin.permissions.writes.map((w) => (
              <li key={w.id}>会写入：{w.description}</li>
            ))}
          </ul>
        )}
      </Section>

      {plugin.disclaimer && (
        <Section title="数据声明">
          <p className="text-body text-muted">{plugin.disclaimer.text}</p>
        </Section>
      )}
    </div>
  )
}
