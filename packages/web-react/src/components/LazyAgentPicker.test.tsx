import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { MAIN_AGENT } from '../lib/agents'
import { LazyAgentPicker } from './LazyAgentPicker'

const { loaded } = vi.hoisted(() => ({ loaded: vi.fn() }))
vi.mock('./AgentPicker', async () => {
  loaded()
  const { useState } = await import('react')
  return {
    AgentPicker: ({ open, onPick }: { open: boolean; onPick: (agent: typeof MAIN_AGENT) => void }) => {
      const [value, setValue] = useState('')
      if (!open) return null
      return (
        <div>
          <input aria-label="picker state" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" onClick={() => onPick(MAIN_AGENT)}>pick</button>
        </div>
      )
    },
  }
})

afterEach(cleanup)

test('loads on first open, forwards actions and retains state after reopening', async () => {
  const onPick = vi.fn()
  const props = { current: MAIN_AGENT, auth: null, onClose: vi.fn(), onPick }
  const { rerender } = render(<LazyAgentPicker {...props} open={false} />)
  expect(loaded).not.toHaveBeenCalled()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

  rerender(<LazyAgentPicker {...props} open />)
  const input = await screen.findByRole('textbox', { name: 'picker state' })
  fireEvent.change(input, { target: { value: 'retained' } })
  fireEvent.click(screen.getByRole('button', { name: 'pick' }))
  expect(onPick).toHaveBeenCalledExactlyOnceWith(MAIN_AGENT)

  rerender(<LazyAgentPicker {...props} open={false} />)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  rerender(<LazyAgentPicker {...props} open />)
  expect(await screen.findByRole('textbox', { name: 'picker state' })).toHaveValue('retained')
  expect(loaded).toHaveBeenCalledTimes(1)
})
