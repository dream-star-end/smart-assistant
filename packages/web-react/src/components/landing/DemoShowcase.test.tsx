import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DemoShowcase } from './DemoShowcase'
import { DEMO_SCENARIOS } from './demoScripts'

afterEach(cleanup)

describe('DemoShowcase', () => {
  test('真实游戏案例按顺序完整展示两轮正文、执行阶段和公网链接', () => {
    render(<DemoShowcase onTry={() => {}} />)

    const game = DEMO_SCENARIOS.find((scenario) => scenario.id === 'game')
    if (!game?.publicLink) throw new Error('missing game demo scenario')
    fireEvent.click(screen.getByRole('button', { name: game.tab }))

    expect(screen.getByText('真实公开案例')).toBeInTheDocument()
    expect(screen.getByText(/两轮用户与助手正文未删节/)).toBeInTheDocument()
    expect(screen.getByText(/第 1 轮 · 用户/)).toBeInTheDocument()
    expect(screen.getByText(/把当前项目已有内容清空下/)).toBeInTheDocument()
    expect(screen.getByText('第一轮 · 从零开发到完整实测')).toBeInTheDocument()
    expect(screen.getByText('生产记录 · 61 次工具调用')).toBeInTheDocument()
    expect(screen.getByText(/3 种本命传承、3 档难度/)).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument()
    expect(screen.getByText(/第 2 轮 · 用户/)).toBeInTheDocument()
    expect(screen.getByText('我要公网可访问游玩')).toBeInTheDocument()
    expect(screen.getByText('第二轮 · 从已完成项目到公网可玩')).toBeInTheDocument()
    expect(screen.getByText('生产记录 · 20 次工具调用')).toBeInTheDocument()
    expect(screen.getByText(/已公网发布并验证可正常进入游戏/)).toBeInTheDocument()

    const playLinks = screen.getAllByRole('link', {
      name: `${game.publicLink.label}（在新窗口打开）`,
    })
    expect(playLinks).toHaveLength(2)
    for (const play of playLinks) {
      expect(play).toHaveAttribute('href', 'https://dream-star-end.github.io/hello-world/')
      expect(play).toHaveAttribute('target', '_blank')
      expect(play).toHaveAttribute('rel', 'noopener noreferrer')
    }

    const analysis = DEMO_SCENARIOS.find((scenario) => scenario.id === 'analysis')
    if (!analysis) throw new Error('missing analysis demo scenario')
    fireEvent.click(screen.getByRole('button', { name: analysis.tab }))
    expect(screen.getByText('动态演示 · 示意数据')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /立即游玩/ })).toBeNull()
  })
})
