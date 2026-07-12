import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DemoShowcase } from './DemoShowcase'
import { DEMO_SCENARIOS } from './demoScripts'

afterEach(cleanup)

describe('DemoShowcase', () => {
  test('真实游戏案例展示已核验的公网游玩链接，示意案例不展示外链', () => {
    render(<DemoShowcase onTry={() => {}} />)

    const game = DEMO_SCENARIOS.find((scenario) => scenario.id === 'game')
    if (!game?.publicLink) throw new Error('missing game demo scenario')
    fireEvent.click(screen.getByRole('button', { name: game.tab }))

    expect(screen.getByText('真实公开案例')).toBeInTheDocument()
    expect(screen.getByText(/从零完成并公网发布/)).toBeInTheDocument()
    const play = screen.getByRole('link', {
      name: `${game.publicLink.label}（在新窗口打开）`,
    })
    expect(play).toHaveAttribute('href', 'https://dream-star-end.github.io/hello-world/')
    expect(play).toHaveAttribute('target', '_blank')
    expect(play).toHaveAttribute('rel', 'noopener noreferrer')

    const analysis = DEMO_SCENARIOS.find((scenario) => scenario.id === 'analysis')
    if (!analysis) throw new Error('missing analysis demo scenario')
    fireEvent.click(screen.getByRole('button', { name: analysis.tab }))
    expect(screen.getByText('动态演示 · 示意数据')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /立即游玩/ })).toBeNull()
  })
})
