import { Sparkles } from 'lucide-react'
import type { Agent } from '../lib/agents'
import { cn } from '../lib/utils'

/**
 * Agent avatar that renders a market agent's emoji OR a built-in agent's lucide
 * icon, over its gradient. `className` controls the box size/shape (e.g. "size-7
 * rounded-lg"); `iconSize` the glyph size.
 */
export function AgentAvatar({
  agent,
  className,
  iconSize = 16,
}: {
  agent: Pick<Agent, 'icon' | 'grad' | 'avatarEmoji'>
  className?: string
  iconSize?: number
}) {
  const grad = agent.grad ?? 'from-violet-500 to-fuchsia-600'
  const Icon = agent.icon
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-gradient-to-br text-white',
        grad,
        className,
      )}
    >
      {agent.avatarEmoji ? (
        <span style={{ fontSize: iconSize + 2, lineHeight: 1 }}>{agent.avatarEmoji}</span>
      ) : Icon ? (
        <Icon size={iconSize} />
      ) : (
        <Sparkles size={iconSize} />
      )}
    </span>
  )
}
