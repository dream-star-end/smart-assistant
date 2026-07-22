import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { AuthSession } from '../../lib/types'
import { FEEDBACK_DESCRIPTION_MAX, FeedbackTab } from './FeedbackTab'

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...original,
    api: { ...original.api, submitFeedback: vi.fn() },
  }
})

const friction = vi.hoisted(() =>
  vi.fn((_signal: Record<string, unknown>, _token?: string | null) => 'settings-feedback-flow'),
)
vi.mock('../../lib/clientFriction', () => ({ reportClientFriction: friction }))

import { api } from '../../lib/api'

const submitFeedback = vi.mocked(api.submitFeedback)
const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  document.querySelector('meta[name="oc-build"]')?.remove()
})

beforeEach(() => {
  vi.clearAllMocks()
  submitFeedback.mockResolvedValue({ ok: true, id: '88' })
})

describe('FeedbackTab', () => {
  test('trim 后为空不提交，并将错误关联到输入框', () => {
    render(<FeedbackTab auth={auth} userId="u1" />)
    const input = screen.getByLabelText('反馈内容')

    fireEvent.change(input, { target: { value: '      ' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(submitFeedback).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('请填写反馈内容')
    expect(input.getAttribute('aria-describedby')).toContain(alert.id)
  })

  test('trim 后非空即可提交，只附允许的设置元数据', async () => {
    const meta = document.createElement('meta')
    meta.name = 'oc-build'
    meta.content = 'build-1234567890'
    document.head.append(meta)

    render(<FeedbackTab auth={auth} userId="u1" />)
    fireEvent.click(screen.getByRole('button', { name: '功能建议' }))
    fireEvent.change(screen.getByLabelText('反馈内容'), {
      target: { value: '   好   ' },
    })
    fireEvent.submit(screen.getByRole('form', { name: '反馈表单' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    const [, payload] = submitFeedback.mock.calls[0]
    expect(payload.category).toBe('feature')
    if (payload.category === 'response') throw new Error('expected settings feedback payload')
    expect(payload.description).toBe('好')
    expect(payload.version).toBe('build-1234567890')
    expect(payload.meta).toMatchObject({ source: 'settings' })
    expect(Object.keys(payload).sort()).toEqual(['category', 'description', 'meta', 'version'])
    expect(Object.keys(payload.meta ?? {}).sort()).toEqual(['locale', 'source', 'timezone'])
    expect(payload).not.toHaveProperty('session_id')
    expect(payload).not.toHaveProperty('request_id')
  })

  test('10000 字符边界可提交，Textarea 同步限制最大长度', async () => {
    render(<FeedbackTab auth={auth} userId="u1" />)
    const input = screen.getByLabelText('反馈内容')
    expect(input).toHaveAttribute('maxlength', String(FEEDBACK_DESCRIPTION_MAX))

    const text = '好'.repeat(FEEDBACK_DESCRIPTION_MAX)
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(screen.getByRole('form', { name: '反馈表单' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].description).toHaveLength(FEEDBACK_DESCRIPTION_MAX)
  })

  test('程序化输入超过 10000 字符仍会在提交边界拦截', () => {
    render(<FeedbackTab auth={auth} userId="u1" />)
    fireEvent.change(screen.getByLabelText('反馈内容'), {
      target: { value: '好'.repeat(FEEDBACK_DESCRIPTION_MAX + 1) },
    })
    fireEvent.submit(screen.getByRole('form', { name: '反馈表单' }))

    expect(submitFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('不能超过 10,000 个字符')
  })

  test('pending 期间防重复提交，成功后显示编号并可复位下一条', async () => {
    const pending = deferred<{ ok: true; id: string }>()
    submitFeedback.mockReturnValue(pending.promise)
    render(<FeedbackTab auth={auth} userId="u1" />)
    fireEvent.click(screen.getByRole('button', { name: '体验问题' }))
    fireEvent.change(screen.getByLabelText('反馈内容'), {
      target: { value: '这个交互目前不够清晰，希望进一步优化。' },
    })
    const form = screen.getByRole('form', { name: '反馈表单' })

    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(submitFeedback).toHaveBeenCalledTimes(1)
    expect(form).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled()

    pending.resolve({ ok: true, id: '90210' })
    expect(await screen.findByRole('status')).toHaveTextContent('#90210')
    fireEvent.click(screen.getByRole('button', { name: '再提一条' }))

    expect(screen.getByLabelText('反馈内容')).toHaveValue('')
    expect(screen.getByRole('button', { name: '问题反馈' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('提交失败显示可重试错误并保留草稿', async () => {
    submitFeedback.mockRejectedValue(new Error('服务暂时不可用，请稍后再试'))
    render(<FeedbackTab auth={auth} userId="u1" />)
    const draft = '我遇到了一个可以稳定复现的问题，希望协助排查。'
    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用，请稍后再试')
    expect(screen.getByLabelText('反馈内容')).toHaveValue(draft)
    expect(screen.getByRole('button', { name: '提交反馈' })).toBeEnabled()
  })

  test('草稿按账号隔离，切换账号不会把前一账号内容写入新 key', () => {
    const view = render(<FeedbackTab auth={auth} userId="user-a" />)
    fireEvent.click(screen.getByRole('button', { name: '功能建议' }))
    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: '账号 A 的草稿' } })

    expect(
      JSON.parse(sessionStorage.getItem('oc.feedback.settings.v1.user-a') ?? '{}'),
    ).toMatchObject({
      category: 'feature',
      description: '账号 A 的草稿',
    })

    view.rerender(<FeedbackTab auth={auth} userId="user-b" />)
    expect(screen.getByLabelText('反馈内容')).toHaveValue('')
    expect(sessionStorage.getItem('oc.feedback.settings.v1.user-b')).toBeNull()

    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: '账号 B 的草稿' } })
    expect(
      JSON.parse(sessionStorage.getItem('oc.feedback.settings.v1.user-b') ?? '{}'),
    ).toMatchObject({
      category: 'bug',
      description: '账号 B 的草稿',
    })
    expect(
      JSON.parse(sessionStorage.getItem('oc.feedback.settings.v1.user-a') ?? '{}'),
    ).toMatchObject({
      description: '账号 A 的草稿',
    })
  })

  test('提交成功只清除当前账号草稿', async () => {
    sessionStorage.setItem(
      'oc.feedback.settings.v1.user-a',
      JSON.stringify({ version: 1, category: 'bug', description: 'A 保留' }),
    )
    render(<FeedbackTab auth={auth} userId="user-b" />)
    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: 'B 提交' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    await screen.findByRole('status')
    expect(sessionStorage.getItem('oc.feedback.settings.v1.user-b')).toBeNull()
    expect(sessionStorage.getItem('oc.feedback.settings.v1.user-a')).toContain('A 保留')
  })

  test('设置打开与提交遥测使用固定 stage/code，pending 与结果复用 correlation', async () => {
    render(<FeedbackTab auth={auth} userId="u1" />)
    expect(friction).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'settings_open', code: 'SETTINGS_OPENED' }),
      'token',
    )
    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: '反馈' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))
    await screen.findByRole('status')

    const submitCalls = friction.mock.calls.filter(([signal]) => signal.stage === 'submit')
    expect(submitCalls.map(([signal]) => signal.outcome)).toEqual(['pending', 'succeeded'])
    expect(submitCalls.every(([signal]) => signal.eventId === 'settings-feedback-flow')).toBe(true)
  })
})
