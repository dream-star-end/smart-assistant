import { Check, Loader2, Store, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Agent, MAIN_AGENT, agentFromApiRow } from '../lib/agents'
import { api } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { Badge, Modal, Switch } from './ui'

/**
 * B-positioning agent picker: lists the user's agents from /api/marketplace/my-agents
 * (default 全能助手 + installed market agents), not a hardcoded set. "从市场添加"
 * routes to the marketplace agent tab.
 *
 * 布局:「全能助手」(main,默认) 单独占满宽度作 featured 卡,团队模式开关是它的**内嵌页脚**
 * (同一 bordered 块,顶部分隔线)——开关语义上属于全能助手,视觉上不打乱下方 agent 网格。
 * 其它已安装 agent + 市场入口走 2 列均匀网格。团队模式是 turn 级 flag(App 持 teamMode,
 * 只在 agent.id==='main' 时随消息发送),故换 agent 不影响、可随时切。
 */
export function AgentPicker({
  open,
  current,
  auth,
  teamMode = false,
  onClose,
  onPick,
  onAddFromMarket,
  onToggleTeamMode,
}: {
  open: boolean
  current: Agent
  auth: AuthSession | null
  teamMode?: boolean
  onClose: () => void
  onPick: (a: Agent) => void
  onAddFromMarket?: () => void
  onToggleTeamMode?: (v: boolean) => void
}) {
  const [agents, setAgents] = useState<Agent[]>([MAIN_AGENT])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !auth) return
    let alive = true
    setLoading(true)
    api
      .listMyAgents(auth)
      .then((rows) => {
        if (!alive) return
        const mapped = rows.map(agentFromApiRow)
        setAgents(mapped.length > 0 ? mapped : [MAIN_AGENT])
      })
      .catch(() => alive && setAgents([MAIN_AGENT]))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [open, auth])

  const defaultAgent = agents.find((a) => a.isDefault) ?? MAIN_AGENT
  const others = agents.filter((a) => !a.isDefault)
  const defaultActive = defaultAgent.id === current.id

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="选择智能体"
      description="全能助手与官方预设助手开箱即用，更多智能体可从市场安装。"
      className="max-w-2xl"
    >
      {loading && (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-faint">
          <Loader2 size={13} className="animate-spin" /> 加载你的智能体…
        </div>
      )}

      {/* 全能助手(默认)—— featured 整块占满宽度,团队模式开关为其内嵌页脚 */}
      <div
        className={cn(
          'mb-3 overflow-hidden rounded-xl border transition-colors',
          defaultActive ? 'border-accent' : 'border-accent/35',
        )}
      >
        <button
          type="button"
          onClick={() => onPick(defaultAgent)}
          className={cn(
            'flex w-full items-start gap-3 p-3.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            defaultActive ? 'bg-accent-soft' : 'bg-accent-soft/40 hover:bg-accent-soft',
          )}
        >
          <AgentAvatar
            agent={defaultAgent}
            className="size-10 rounded-lg shadow-sm"
            iconSize={19}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-[14.5px] font-semibold text-fg">{defaultAgent.name}</span>
              <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                默认
              </span>
              {defaultActive && <Check size={14} className="text-accent" />}
            </span>
            <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
              {defaultAgent.description}
            </span>
          </span>
        </button>

        {onToggleTeamMode && (
          <div className="flex items-center justify-between gap-3 border-t border-accent/20 bg-surface/70 px-3.5 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg">
                <Users size={13} className="text-accent" /> 团队模式
              </span>
              <span className="mt-0.5 text-[11.5px] leading-snug text-muted">
                开启后队长引擎将切换为 GPT-5.5（计费高于默认模型），并按需委派已安装智能体组队协作。每次委派按对应智能体的模型计费。
              </span>
            </span>
            <Switch checked={teamMode} onCheckedChange={onToggleTeamMode} aria-label="启用团队模式" />
          </div>
        )}
      </div>

      {/* 其它已安装 agent + 市场入口 —— 2 列均匀网格 */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {others.map((a) => {
          const active = a.id === current.id
          return (
            <button
              type="button"
              key={a.id}
              onClick={() => onPick(a)}
              className={cn(
                'group flex items-start gap-3 rounded-xl border p-3.5 text-left outline-none transition-[transform,box-shadow,border-color,background-color] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                active
                  ? 'border-accent bg-accent-soft'
                  : 'border-border bg-surface hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft',
              )}
            >
              <AgentAvatar agent={a} className="size-10 rounded-lg shadow-sm" iconSize={19} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[14.5px] font-semibold text-fg">{a.name}</span>
                  {a.preset && <Badge tone="accent">预设</Badge>}
                  {active && <Check size={14} className="text-accent" />}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
                  {a.description}
                </span>
              </span>
            </button>
          )
        })}

        {onAddFromMarket && (
          <button
            type="button"
            onClick={onAddFromMarket}
            className="group flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-3.5 text-[13.5px] text-muted outline-none transition-colors hover:border-accent/50 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Store size={16} />
            从市场添加更多智能体
          </button>
        )}
      </div>
    </Modal>
  )
}
