import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CodeBlock } from './CodeBlock'
import { ToastProvider } from './ui'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// M-20:剪贴板写入失败(http 非安全上下文 / 权限被拒)此前被静默吞掉,用户不知道复制没成功。
test('代码复制失败时弹出提示，而不是静默', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    configurable: true,
  })
  render(
    <ToastProvider>
      <CodeBlock language="ts">const answer = 42;</CodeBlock>
    </ToastProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('复制失败，请手动选中文本复制'))
  expect(screen.getByRole('button', { name: '复制' })).toHaveTextContent('复制')
})

test('代码复制按钮不会提交父表单，粗指针下命中高度为 44px', () => {
  render(<CodeBlock language="ts">const answer = 42;</CodeBlock>)
  const copy = screen.getByRole('button', { name: '复制' })
  expect(copy).toHaveAttribute('type', 'button')
  expect(copy).toHaveClass('[@media(hover:none)]:min-h-11')
})

test('点击换行后 pre 有 whitespace-pre-wrap，再点取消，并写入 localStorage', () => {
  render(<CodeBlock language="ts">const answer = 42;</CodeBlock>)
  const toggle = screen.getByRole('button', { name: '换行' })
  const pre = document.querySelector('pre')
  expect(pre?.className).not.toContain('whitespace-pre-wrap')
  fireEvent.click(toggle)
  expect(pre?.className).toContain('whitespace-pre-wrap')
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(localStorage.getItem('oc_v5_code_wrap')).toBe('1')
  fireEvent.click(toggle)
  expect(pre?.className).not.toContain('whitespace-pre-wrap')
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(localStorage.getItem('oc_v5_code_wrap')).toBe('0')
})
