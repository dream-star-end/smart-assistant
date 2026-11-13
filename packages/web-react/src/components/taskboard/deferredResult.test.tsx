import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TimelineItem } from '../../lib/taskboard'
import { TicketTimeline } from './TicketTimeline'

const mocks = vi.hoisted(() => ({ markdown: vi.fn() }))
vi.mock('../Markdown', () => ({
  Markdown: (props: { children: string; readOnly?: boolean }) => {
    mocks.markdown(props)
    return <div data-testid="heavy-markdown">{props.children}</div>
  },
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const text = `FULL_RESULT_BEGIN ${'很长的付费结果'.repeat(2000)} FULL_RESULT_END`
const items = (body = text): TimelineItem[] => [
  {
    kind: 'comment',
    createdAt: 1,
    comment: {
      id: 'paid-comment',
      ticketId: 'ticket',
      authorKind: 'agent',
      author: 'main',
      body,
      runId: null,
      createdAt: 1,
    },
  },
]

test('long hidden results mount Markdown only after expansion and keep expansion through updates', () => {
  const props = { loading: false, stageName: null, stageById: new Map<string, string>() }
  const view = render(<TicketTimeline {...props} items={items()} />)
  expect(mocks.markdown).not.toHaveBeenCalled()
  expect(screen.queryByTestId('heavy-markdown')).toBeNull()
  const expand = screen.getByTestId('ticket-comment-expand')
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(expand)
  expect(screen.getByTestId('heavy-markdown')).toHaveTextContent('FULL_RESULT_END')
  expect(mocks.markdown.mock.lastCall?.[0].readOnly).toBe(true)
  const count = mocks.markdown.mock.calls.length
  view.rerender(<TicketTimeline {...props} items={items()} />)
  expect(mocks.markdown.mock.calls.length).toBe(count)
  view.rerender(<TicketTimeline {...props} items={items(`${text}\n最新归档内容`)} />)
  expect(screen.getByTestId('ticket-comment-expand')).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('heavy-markdown')).toHaveTextContent('最新归档内容')
})
