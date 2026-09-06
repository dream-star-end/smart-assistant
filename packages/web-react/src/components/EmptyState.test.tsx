import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { MAIN_AGENT } from '../lib/agents'
import { EmptyState } from './EmptyState'

describe('EmptyState first-task starters', () => {
  test('shows useful starters and only asks the composer to prefill the chosen text', () => {
    const onPrefill = vi.fn()
    render(<EmptyState agent={MAIN_AGENT} onPrefill={onPrefill} onChangeAgent={() => {}} />)

    expect(MAIN_AGENT.starters).toHaveLength(3)
    for (const starter of MAIN_AGENT.starters ?? []) {
      expect(screen.getByRole('button', { name: starter })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: MAIN_AGENT.starters![0] }))
    expect(onPrefill).toHaveBeenCalledOnce()
    expect(onPrefill).toHaveBeenCalledWith(MAIN_AGENT.starters![0])
  })

  test('无 starters 时渲染 2 张兜底卡', () => {
    const onPrefill = vi.fn()
    render(
      <EmptyState
        agent={{ ...MAIN_AGENT, id: 'custom', starters: [] }}
        onPrefill={onPrefill}
        onChangeAgent={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '帮我把下面这段内容整理成要点' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '用一句话说明你能帮我做什么' })).toBeTruthy()
  })
})
