import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Agent, MAIN_AGENT } from '../lib/agents'
import { EmptyState } from './EmptyState'

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
