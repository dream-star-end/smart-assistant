import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DemoShowcase } from './DemoShowcase'
import { DEMO_SCENARIOS } from './demoScripts'

afterEach(cleanup)

describe('DemoShowcase', () => {
  test('真实游戏案例展示两轮过程与三张实机截图，不暴露游玩地址', () => {
    render(<DemoShowcase onTry={() => {}} />)

    const game = DEMO_SCENARIOS.find((scenario) => scenario.id === 'game')
    if (!game) throw new Error('missing game demo scenario')
    fireEvent.click(screen.getByRole('button', { name: game.tab }))

    expect(screen.getByText('真实公开案例')).toBeInTheDocument()
    expect(screen.getByText(/保留两轮结构和非地址正文/)).toBeInTheDocument()
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
    expect(screen.queryByText(/dream-star-end/)).toBeNull()
    expect(screen.queryByRole('link', { name: /立即游玩/ })).toBeNull()

    const screenshots = screen.getAllByRole('img')
    expect(screenshots).toHaveLength(3)
    expect(screenshots.map((image) => image.getAttribute('src'))).toEqual([
      '/demo/wanjie/menu.webp',
      '/demo/wanjie/battle.webp',
      '/demo/wanjie/mobile.webp',
    ])
    for (const screenshot of screenshots) {
      expect(screenshot.closest('a')).toBeNull()
      expect(screenshot).not.toHaveAttribute('tabindex')
    }
    expect(screen.getByText('传承选择')).toBeInTheDocument()
    expect(screen.getByText('战斗实机')).toBeInTheDocument()
    expect(screen.getByText('移动端')).toBeInTheDocument()

    const analysis = DEMO_SCENARIOS.find((scenario) => scenario.id === 'analysis')
    if (!analysis) throw new Error('missing analysis demo scenario')
    fireEvent.click(screen.getByRole('button', { name: analysis.tab }))
    expect(screen.getByText('动态演示 · 示意数据')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /《万劫问仙》/ })).toBeNull()
  })

  // L-01:窗口顶栏图标压在柠檬绿渐变上,前景必须走 token 而不是 text-white。
  test('窗口顶栏的渐变图标前景走 text-primary-fg', () => {
    render(<DemoShowcase onTry={() => {}} />)
    const badge = document.querySelector('.bg-grad-cta')
    expect(badge).not.toBeNull()
    expect(badge?.className).toContain('text-primary-fg')
    expect(badge?.className).not.toMatch(/\btext-white\b/)
  })

  // L-08:能力 Tab 是切换按钮(type=button,不会在表单里误提交);窄屏右缘有渐隐暗示可滚动。
  test('能力 Tab 条:按钮显式 type=button,右缘渐隐仅窄屏出现', () => {
    render(<DemoShowcase onTry={() => {}} />)
    for (const scenario of DEMO_SCENARIOS) {
      expect(screen.getByRole('button', { name: scenario.tab })).toHaveAttribute('type', 'button')
    }
    const fade = document.querySelector('.bg-gradient-to-l.from-surface')
    expect(fade).not.toBeNull()
    expect(fade?.className).toContain('sm:hidden')
    expect(fade).toHaveAttribute('aria-hidden')
  })

  // L-08:答案气泡只在 md 起预留完整高度;窄屏随打字自然增长,不留一屏空白。
  test('答案气泡的撑位段只在 md 起生效', () => {
    render(<DemoShowcase onTry={() => {}} initialScenarioId="analysis" />)
    const spacer = document.querySelector('p.invisible')
    expect(spacer).not.toBeNull()
    expect(spacer?.className).toContain('hidden')
    expect(spacer?.className).toContain('md:block')
    const typed = spacer?.nextElementSibling
    expect(typed?.className).toContain('md:absolute')
    expect(typed?.className).not.toMatch(/(^|\s)absolute(\s|$)/)
  })
})
