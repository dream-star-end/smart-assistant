import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { AuthSession } from '../../lib/types'
import { MessageFeedbackDialog } from './MessageFeedbackDialog'
import type { FeedbackContext } from './cards'

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...original,
    api: { ...original.api, submitFeedback: vi.fn() },
  }
})

const friction = vi.hoisted(() =>
  vi.fn((_signal: Record<string, unknown>, _token?: string | null) => 'feedback-flow'),
)
vi.mock('../../lib/clientFriction', () => ({ reportClientFriction: friction }))

import { api } from '../../lib/api'

const submitFeedback = vi.mocked(api.submitFeedback)
const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')
const context: FeedbackContext = {
  traceId: 'trace-1',
  messageId: 'message-1',
  role: 'assistant',
  errorCode: 'UPSTREAM_TIMEOUT',
  textPreview: '这是当前回复的 120 字以内可见摘录。',
}

function Harness() {
  const [open, setOpen] = useState(false)
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null)
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          setReturnFocus(event.currentTarget)
          setOpen(true)
        }}
      >
        打开反馈
      </button>
      <MessageFeedbackDialog
        open={open}
        onOpenChange={setOpen}
        auth={auth}
        sessionId="session-1"
        context={context}
        returnFocus={returnFocus}
      />
    </>
  )
}

function RaceHarness() {
  const [open, setOpen] = useState(false)
  const [activeContext, setActiveContext] = useState(context)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setActiveContext(context)
          setOpen(true)
        }}
      >
        打开 A
      </button>
      <button
        type="button"
        onClick={() => {
          setActiveContext({ ...context, traceId: 'trace-2', messageId: 'message-2' })
          setOpen(true)
        }}
      >
        打开 B
      </button>
      <MessageFeedbackDialog
        open={open}
        onOpenChange={setOpen}
        auth={auth}
        sessionId="session-1"
        context={activeContext}
      />
    </>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  submitFeedback.mockResolvedValue({ ok: true, id: '901' })
})

afterEach(cleanup)

describe('MessageFeedbackDialog', () => {
  test('原因本身即可提交，只发送白名单字段并默认附上可见回复摘录', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '打开反馈' }))
    expect(await screen.findByRole('dialog', { name: '反馈这条回复' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '工具失败' }))
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback).toHaveBeenCalledWith(auth, {
      category: 'response',
      description: '工具失败',
      requestId: 'trace-1',
      sessionId: 'session-1',
      meta: expect.objectContaining({
        source: 'message',
        messageId: 'message-1',
        role: 'assistant',
        errorCode: 'UPSTREAM_TIMEOUT',
        reason: '工具失败',
        responseExcerpt: '这是当前回复的 120 字以内可见摘录。',
      }),
    })
    const payload = submitFeedback.mock.calls[0][1]
    expect(payload).not.toHaveProperty('conversation')
    expect(payload).not.toHaveProperty('messages')
    expect(payload.meta).not.toHaveProperty('url')
    expect(await screen.findByRole('status')).toHaveTextContent('#901')
  })

  test('用户取消摘录授权后 payload 不含 responseExcerpt', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '打开反馈' }))
    fireEvent.click(await screen.findByLabelText('附上以上回复摘录，帮助定位问题'))
    fireEvent.change(screen.getByLabelText('补充说明（可选）'), {
      target: { value: '这里没有执行我要求的最后一步' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].meta).not.toHaveProperty('responseExcerpt')
  })

  test('没有原因和说明时不提交；关闭后焦点回到触发按钮', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: '打开反馈' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: '提交反馈' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请选择一个原因')
    expect(submitFeedback).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  test('关键行为遥测只使用固定 stage/code，提交 pending 与结果复用 correlation', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '打开反馈' }))
    fireEvent.click(await screen.findByRole('button', { name: '不准确' }))
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))
    await screen.findByRole('status')

    expect(friction).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'message_open', code: 'MESSAGE_OPENED' }),
      'token',
    )
    const submitCalls = friction.mock.calls.filter(([signal]) => signal.stage === 'submit')
    expect(submitCalls.map(([signal]) => signal.outcome)).toEqual(['pending', 'succeeded'])
    expect(submitCalls.every(([signal]) => signal.eventId === 'feedback-flow')).toBe(true)
  })

  test('关闭后打开另一条消息时，旧请求结果不能覆盖或解锁新请求', async () => {
    const first = deferred<{ ok: true; id: string }>()
    const second = deferred<{ ok: true; id: string }>()
    submitFeedback.mockImplementation((_auth, input) =>
      input.category === 'response' && input.meta.messageId === 'message-1'
        ? first.promise
        : second.promise,
    )

    render(<RaceHarness />)
    fireEvent.click(screen.getByRole('button', { name: '打开 A' }))
    fireEvent.click(await screen.findByRole('button', { name: '不准确' }))
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    fireEvent.click(screen.getByRole('button', { name: '打开 B' }))
    fireEvent.click(await screen.findByRole('button', { name: '没完成' }))
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))
    expect(submitFeedback).toHaveBeenCalledTimes(2)

    first.resolve({ ok: true, id: '901' })
    await waitFor(() => expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled())
    expect(screen.queryByText('#901')).not.toBeInTheDocument()

    second.resolve({ ok: true, id: '902' })
    expect(await screen.findByRole('status')).toHaveTextContent('#902')
    expect(screen.queryByText('#901')).not.toBeInTheDocument()
  })
})
