import { Sparkles } from 'lucide-react'
import type { Agent } from '../lib/agents'
import { cn } from '../lib/utils'

/**
 * Agent avatar that renders a market agent's emoji OR a built-in agent's lucide
 * icon, over its gradient. `className` controls the box size/shape (e.g. "size-7
 * rounded-lg"); `iconSize` the glyph size.
 *
 * 可访问性(tools 审计 T-25):传 `name` 时整枚头像是 `role="img"` + aria-label,读屏念一次名字;
 * 不传则 `aria-hidden` —— 旁边通常已有可见名字,emoji 再被逐码点朗读只是噪音。
 * `overflow-hidden leading-none`:多码点/宽 emoji 在不支持 ZWJ 的平台不会溢出圆角框。
 */
export function AgentAvatar({
  agent,
  className,
  iconSize = 16,
  name,
}: {
  agent: Pick<Agent, 'icon' | 'grad' | 'avatarEmoji'>
  className?: string
  iconSize?: number
  /** 可及名;有则 role="img",无则对读屏隐藏。 */
  name?: string
}) {
  const grad = agent.grad ?? 'from-violet-500 to-fuchsia-600'
  const Icon = agent.icon
  const a11y = name ? { role: 'img' as const, 'aria-label': name } : { 'aria-hidden': true as const }
  return (
    <span
      {...a11y}
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br leading-none text-white',
        grad,
        className,
      )}
    >
      {agent.avatarEmoji ? (
        <span style={{ fontSize: iconSize + 2, lineHeight: 1 }}>{agent.avatarEmoji}</span>
      ) : Icon ? (
        <Icon size={iconSize} aria-hidden="true" />
      ) : (
        <Sparkles size={iconSize} aria-hidden="true" />
      )}
    </span>
  )
}
