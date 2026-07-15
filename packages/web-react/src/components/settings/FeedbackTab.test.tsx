import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthSession } from '../../lib/types'
import { createMemoryAuthSession } from '../../lib/authSession'
import { FEEDBACK_DESCRIPTION_MAX, FeedbackTab } from './FeedbackTab'

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...original,
    api: { ...original.api, submitFeedback: vi.fn() },
  }
})

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
  document.querySelector('meta[name="oc-build"]')?.remove()
})

beforeEach(() => {
  vi.clearAllMocks()
  submitFeedback.mockResolvedValue({ ok: true, id: '88' })
})

describe('FeedbackTab', () => {
  test('trim 后不足 15 字符不提交，并将错误关联到输入框', () => {
    render(<FeedbackTab auth={auth} />)
    const input = screen.getByLabelText('反馈内容')

    fireEvent.change(input, { target: { value: '   12345678901234   ' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(submitFeedback).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('至少填写 15 个字符')
    expect(input.getAttribute('aria-describedby')).toContain(alert.id)
  })

  test('trim 后 15 字符可提交，只附允许的设置元数据', async () => {
    const meta = document.createElement('meta')
    meta.name = 'oc-build'
    meta.content = 'build-1234567890'
    document.head.append(meta)

    render(<FeedbackTab auth={auth} />)
    fireEvent.change(screen.getByLabelText('反馈类型'), { target: { value: 'feature' } })
    fireEvent.change(screen.getByLabelText('反馈内容'), {
      target: { value: '   123456789012345   ' },
    })
    fireEvent.submit(screen.getByRole('form', { name: '反馈表单' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    const [, payload] = submitFeedback.mock.calls[0]
    expect(payload.category).toBe('feature')
    expect(payload.description).toBe('123456789012345')
    expect(payload.version).toBe('build-1234567890')
    expect(payload.meta).toMatchObject({ source: 'settings' })
    expect(Object.keys(payload).sort()).toEqual(['category', 'description', 'meta', 'version'])
    expect(Object.keys(payload.meta ?? {}).sort()).toEqual(['locale', 'source', 'timezone'])
    expect(payload).not.toHaveProperty('session_id')
    expect(payload).not.toHaveProperty('request_id')
  })

  test('10000 字符边界可提交，Textarea 同步限制最大长度', async () => {
    render(<FeedbackTab auth={auth} />)
    const input = screen.getByLabelText('反馈内容')
    expect(input).toHaveAttribute('maxlength', String(FEEDBACK_DESCRIPTION_MAX))

    const text = '好'.repeat(FEEDBACK_DESCRIPTION_MAX)
    fireEvent.change(input, { target: { value: text } })
    fireEvent.submit(screen.getByRole('form', { name: '反馈表单' }))

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1))
    expect(submitFeedback.mock.calls[0][1].description).toHaveLength(FEEDBACK_DESCRIPTION_MAX)
  })

  test('程序化输入超过 10000 字符仍会在提交边界拦截', () => {
    render(<FeedbackTab auth={auth} />)
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
    render(<FeedbackTab auth={auth} />)
    fireEvent.change(screen.getByLabelText('反馈类型'), { target: { value: 'ux' } })
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
    expect(screen.getByLabelText('反馈类型')).toHaveValue('bug')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('提交失败显示可重试错误并保留草稿', async () => {
    submitFeedback.mockRejectedValue(new Error('服务暂时不可用，请稍后再试'))
    render(<FeedbackTab auth={auth} />)
    const draft = '我遇到了一个可以稳定复现的问题，希望协助排查。'
    fireEvent.change(screen.getByLabelText('反馈内容'), { target: { value: draft } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用，请稍后再试')
    expect(screen.getByLabelText('反馈内容')).toHaveValue(draft)
    expect(screen.getByRole('button', { name: '提交反馈' })).toBeEnabled()
  })
})
