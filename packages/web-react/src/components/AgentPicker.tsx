import { Check, Loader2, Store } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type Agent, MAIN_AGENT, agentFromApiRow } from '../lib/agents'
import { api } from '../lib/api'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { AgentAvatar } from './AgentAvatar'
import { Modal } from './ui'

/**
 * B-positioning agent picker: lists the user's agents from /api/marketplace/my-agents
 * (default 全能助手 + installed market agents), not a hardcoded set. "从市场添加"
 * routes to the marketplace agent tab.
 */
export function AgentPicker({
  open,
  current,
  auth,
  onClose,
  onPick,
  onAddFromMarket,
}: {
  open: boolean
  current: Agent
  auth: AuthSession | null
  onClose: () => void
  onPick: (a: Agent) => void
  onAddFromMarket?: () => void
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
