import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TUTORIAL_SHOWCASES } from '../../lib/tutorialShowcase'
import { CaseShowroom, ShowcaseDetail } from './CaseShowroom'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
describe('CaseShowroom', () => {
  it('delegates one editable personal request without sending it', () => {
    const run = vi.fn()
    const select = vi.fn()
    render(<CaseShowroom onSelect={select} onRun={run} />)
    fireEvent.click(screen.getAllByRole('button', { name: /^做一个我的版本：/ })[0])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'research-bike-demand', starterPrompt: TUTORIAL_SHOWCASES[0].prompt }))
    expect(select).not.toHaveBeenCalled()
  })
  it('shows screenshots of actual artifacts and retains data when an image fails', () => {
    render(<CaseShowroom onSelect={vi.fn()} />)
    const cover = screen.getByRole('img', { name: TUTORIAL_SHOWCASES[0].title + '实际看板截图' })
    expect(cover).toHaveAttribute('src', '/tutorials/showcase-covers/research-bike-demand.png')
    fireEvent.error(cover)
    expect(screen.getByLabelText('实作结果摘要')).toBeInTheDocument()
  })
  it('shows login intent without silently starting a run', () => {
    render(<CaseShowroom onSelect={vi.fn()} onRun={vi.fn()} actionLabel="登录后试用" />)
    expect(screen.getAllByText('登录后做我的版本')).toHaveLength(2)
  })
  it('loads the real artifact on demand in an opaque-origin sandbox', () => {
    render(<ShowcaseDetail item={TUTORIAL_SHOWCASES[0]} onBack={vi.fn()} onRun={vi.fn()} />)
    expect(document.querySelector('iframe')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开交互看板' }))
    const frame = screen.getByTitle(TUTORIAL_SHOWCASES[0].title + '交互看板')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame).toHaveAttribute('src', '/tutorials/cases/research-bike-demand/showcase/dashboard.html')
    expect(frame).toHaveAttribute('referrerPolicy', 'no-referrer')
    expect(screen.getByRole('link', { name: '下载分析报告' })).toHaveAttribute('download')
    expect(screen.getByRole('link', { name: '下载分析数据' })).toHaveAttribute('href', '/tutorials/cases/research-bike-demand/showcase/derived.csv')
    expect(screen.getByText(/不会自动发送/)).toBeInTheDocument()
  })
  it('keeps manual copy available when clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    render(<ShowcaseDetail item={TUTORIAL_SHOWCASES[1]} onBack={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '复制任务指令' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('未能复制'))
    expect(screen.getByText(TUTORIAL_SHOWCASES[1].prompt)).toBeInTheDocument()
  })
})
