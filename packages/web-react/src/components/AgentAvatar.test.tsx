import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Bot } from 'lucide-react'
import { afterEach, describe, expect, test } from 'vitest'
import { AgentAvatar } from './AgentAvatar'

afterEach(cleanup)

describe('AgentAvatar 可访问性与溢出防护(T-25)', () => {
  test('传 name → role=img + aria-label,emoji 不再被逐字朗读', () => {
    render(
      <AgentAvatar
        agent={{ avatarEmoji: '🧑‍🚀', grad: 'from-a to-b' }}
        name="航天助手"
        className="size-7 rounded-lg"
      />,
    )
    const img = screen.getByRole('img', { name: '航天助手' })
    expect(img).toBeInTheDocument()
    expect(img.className).toContain('overflow-hidden')
    expect(img.className).toContain('leading-none')
    expect(img.textContent).toBe('🧑‍🚀')
  })

  test('不传 name → 对读屏隐藏(旁边已有可见名字)', () => {
    const { container } = render(<AgentAvatar agent={{ avatarEmoji: '🤖' }} />)
    const root = container.firstElementChild
    expect(root).toHaveAttribute('aria-hidden', 'true')
    expect(root).not.toHaveAttribute('role')
    expect(screen.queryByRole('img')).toBeNull()
  })

  test('lucide 图标 / Sparkles 兜底同样 aria-hidden,渐变缺省回落紫色', () => {
    const { container, rerender } = render(
      <AgentAvatar agent={{ icon: Bot }} name="内置" iconSize={12} />,
    )
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.firstElementChild?.className).toContain('from-violet-500')
    rerender(<AgentAvatar agent={{}} name="兜底" />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('img', { name: '兜底' })).toBeInTheDocument()
  })
})
