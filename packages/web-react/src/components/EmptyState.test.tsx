import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import { MAIN_AGENT } from '../lib/agents'
import { EmptyState } from './EmptyState'

describe('EmptyState first-task starters', () => {
  test('shows useful starters and only asks the composer to prefill the chosen text', () => {
    const onPrefill = vi.fn()
    render(<EmptyState agent={MAIN_AGENT} onPrefill={onPrefill} onChangeAgent={() => {}} />)

    expect(MAIN_AGENT.starters).toHaveLength(4)
    for (const starter of MAIN_AGENT.starters ?? []) {
      expect(screen.getByRole('button', { name: starter })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: MAIN_AGENT.starters![0] }))
    expect(onPrefill).toHaveBeenCalledOnce()
    expect(onPrefill).toHaveBeenCalledWith(MAIN_AGENT.starters![0])
  })
})
