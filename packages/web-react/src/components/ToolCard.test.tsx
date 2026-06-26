import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { ToolCard } from './ToolCard'

afterEach(cleanup)

describe('ToolCard 状态渲染 (P4)', () => {
  test('running → 显示「运行中」标签 + spinner（animate-spin）', () => {
    const { container } = render(<ToolCard card={{ id: 't1', title: '终端命令', status: 'running', evidence: ['$ ls'] }} />)
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  test('ok → 「完成」无 spinner；error → 「失败」', () => {
    const { container, rerender } = render(<ToolCard card={{ id: 't2', title: '联网请求', status: 'ok', evidence: [] }} />)
    expect(screen.getByText('完成')).toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument()
    rerender(<ToolCard card={{ id: 't2', title: '联网请求', status: 'error', evidence: [] }} />)
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  test('有 evidence 可展开查看', () => {
    render(<ToolCard card={{ id: 't3', title: '终端命令', status: 'ok', evidence: ['line-A', 'line-B'] }} />)
    // 展开前 evidence 不可见。
    expect(screen.queryByText('line-A')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('终端命令'))
    expect(screen.getByText('line-A')).toBeInTheDocument()
    expect(screen.getByText('line-B')).toBeInTheDocument()
  })

  test('未知 status 回退显示原值，不崩', () => {
    render(<ToolCard card={{ id: 't4', title: 'X', status: 'weird', evidence: [] }} />)
    expect(screen.getByText('weird')).toBeInTheDocument()
  })
})
