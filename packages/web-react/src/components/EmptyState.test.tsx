import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Agent, MAIN_AGENT } from '../lib/agents'
import { EmptyState, greetingFor, greetingName } from './EmptyState'

afterEach(cleanup)

const AGENT: Agent = {
  id: 'main',
  name: '全能助手',
  description: '写邮件、做规划、查资料。',
  starters: ['帮我规划一次旅行', '把这段话改得更礼貌', '解释量子纠缠', '压缩周报'],
  isDefault: true,
  installed: true,
  ready: true,
}

describe('EmptyState first-task starters', () => {
  it('shows useful starters and only asks the composer to prefill the chosen text', () => {
    const onPrefill = vi.fn()
    render(<EmptyState agent={MAIN_AGENT} onPrefill={onPrefill} onChangeAgent={() => {}} />)

    expect(MAIN_AGENT.starters).toHaveLength(3)
    for (const starter of MAIN_AGENT.starters ?? []) {
      expect(screen.getByRole('button', { name: starter })).toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('button', { name: MAIN_AGENT.starters![0] }))
    expect(onPrefill).toHaveBeenCalledOnce()
    expect(onPrefill).toHaveBeenCalledWith(MAIN_AGENT.starters![0])
  })

  it('无 starters 时渲染 2 张兜底卡', () => {
    render(
      <EmptyState
        agent={{ ...MAIN_AGENT, id: 'custom', starters: [] }}
        onPrefill={() => {}}
        onChangeAgent={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '帮我把下面这段内容整理成要点' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '用一句话说明你能帮我做什么' })).toBeInTheDocument()
  })
})

describe('EmptyState(空会话欢迎页,shell 审计 S-09 / S-10 / S-15)', () => {
  it('标题是 h2,不与 App 的 sr-only h1 抢文档大纲', () => {
    render(<EmptyState agent={AGENT} onPrefill={() => {}} onChangeAgent={() => {}} />)
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: '全能助手' })).toBeInTheDocument()
  })

  it('起步语卡片显式 type=button,点击回填', () => {
    const onPrefill = vi.fn()
    render(<EmptyState agent={AGENT} onPrefill={onPrefill} onChangeAgent={() => {}} />)
    const card = screen.getByRole('button', { name: '帮我规划一次旅行' })
    expect(card).toHaveAttribute('type', 'button')
    fireEvent.click(card)
    expect(onPrefill).toHaveBeenCalledWith('帮我规划一次旅行')
  })

  it('「为这次会话设定目标」走 Button 原语:触屏下有 44px 命中兜底', () => {
    const onOpenGoal = vi.fn()
    render(
      <EmptyState
        agent={AGENT}
        onPrefill={() => {}}
        onChangeAgent={() => {}}
        onOpenGoal={onOpenGoal}
      />,
    )
    const goal = screen.getByRole('button', { name: '为这次会话设定目标' })
    expect(goal.className).toContain('[@media(hover:none)]:min-h-11')
    fireEvent.click(goal)
    expect(onOpenGoal).toHaveBeenCalledTimes(1)
  })

  it('不传 onOpenGoal 时不渲染目标入口', () => {
    render(<EmptyState agent={AGENT} onPrefill={() => {}} onChangeAgent={() => {}} />)
    expect(screen.queryByRole('button', { name: '为这次会话设定目标' })).toBeNull()
  })
})

describe('EmptyState 问候(OCV5-342)', () => {
  it('有用户名时标题是按时段的问候，副标题点出当前智能体', () => {
    render(
      <EmptyState
        agent={AGENT}
        userName="Alice"
        now={new Date(2026, 9, 8, 15, 0)}
        onPrefill={() => {}}
        onChangeAgent={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { level: 2, name: '下午好，Alice' })).toBeInTheDocument()
    expect(screen.getByText('今天想让全能助手帮你完成什么？')).toBeInTheDocument()
    // 智能体身份与切换入口仍在
    expect(screen.getByText('全能助手')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '换一个智能体' })).toBeInTheDocument()
  })

  it('没有用户名时回落为智能体名 + 描述', () => {
    render(<EmptyState agent={AGENT} userName="  " onPrefill={() => {}} onChangeAgent={() => {}} />)
    expect(screen.getByRole('heading', { level: 2, name: '全能助手' })).toBeInTheDocument()
    expect(screen.getByText('写邮件、做规划、查资料。')).toBeInTheDocument()
  })

  it('时段划分', () => {
    const at = (h: number) => greetingFor(new Date(2026, 0, 1, h, 30))
    expect(at(3)).toBe('夜深了')
    expect(at(7)).toBe('上午好')
    expect(at(12)).toBe('中午好')
    expect(at(16)).toBe('下午好')
    expect(at(20)).toBe('晚上好')
    expect(at(23)).toBe('夜深了')
  })

  it('邮箱 / 「用户」兜底名不进问候', () => {
    expect(greetingName({ displayName: 'Alice', email: 'a@b.com' })).toBe('Alice')
    expect(greetingName({ displayName: 'a@b.com', email: 'a@b.com' })).toBeUndefined()
    expect(greetingName({ displayName: '用户' })).toBeUndefined()
    expect(greetingName({ displayName: ' ' })).toBeUndefined()
    expect(greetingName(null)).toBeUndefined()
  })
})
