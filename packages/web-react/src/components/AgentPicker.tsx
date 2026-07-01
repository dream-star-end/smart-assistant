import { Check, Loader2, Store, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Agent, MAIN_AGENT, agentFromApiRow } from '../lib/agents'
import { api } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { Modal, Switch } from './ui'

/**
 * B-positioning agent picker: lists the user's agents from /api/marketplace/my-agents
 * (default 全能助手 + installed market agents), not a hardcoded set. "从市场添加"
 * routes to the marketplace agent tab.
 *
 * 团队模式(v5 轻量组队):开关只挂在「全能助手」(main)卡片上——开启后，用户发消息时 main
 * 队长会按任务自动选调已安装的 agent 组队(delegate_task)。开关是 turn 级 flag(App 持有
 * teamMode 状态，只在 agent.id==='main' 时随消息发送)，故换 agent 不影响、可随时切。
 * Radix Switch 本身是 <button>，不能嵌进卡片 <button>，所以做成主卡下方的独立 toggle 行。
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

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="选择智能体"
      description="默认配备「全能助手」，更多专业智能体可从市场安装。"
      className="max-w-2xl"
    >
      {loading && (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-faint">
          <Loader2 size={13} className="animate-spin" /> 加载你的智能体…
        </div>
      )}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {agents.map((a) => {
          const active = a.id === current.id
          const card = (
            <button
              type="button"
              onClick={() => onPick(a)}
              className={cn(
                'group flex w-full items-start gap-3 rounded-xl border p-3.5 text-left outline-none transition-[transform,box-shadow,border-color,background-color] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                active
                  ? 'border-accent bg-accent-soft'
                  : 'border-border bg-surface hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft',
              )}
            >
              <AgentAvatar agent={a} className="size-10 rounded-lg shadow-sm" iconSize={19} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-[14.5px] font-semibold text-fg">{a.name}</span>
                  {a.isDefault && (
                    <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">
                      默认
                    </span>
                  )}
                  {active && <Check size={14} className="text-accent" />}
                </span>
                <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
                  {a.description}
                </span>
              </span>
            </button>
          )

          // 团队模式开关：只在「全能助手」卡片下方渲染（非 demo）。
          if (a.isDefault && onToggleTeamMode) {
            return (
              <div key={a.id} className="flex flex-col gap-1.5">
                {card}
                <div
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 transition-colors',
                    teamMode ? 'border-accent/60 bg-accent-soft' : 'border-border bg-surface',
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg">
                      <Users size={13} className="text-accent" /> 团队模式
                    </span>
                    <span className="mt-0.5 text-[11.5px] leading-snug text-muted">
                      开启后，全能助手会按任务自动选调已安装的智能体组队协作；简单任务仍自己完成。
                    </span>
                  </span>
                  <Switch
                    checked={teamMode}
                    onCheckedChange={onToggleTeamMode}
                    aria-label="启用团队模式"
                  />
                </div>
              </div>
            )
          }

          return <div key={a.id}>{card}</div>
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
