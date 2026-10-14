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

// OCV5-421: 历史里的长代码块默认折叠(展开按钮给出行数);流式中挂载的不折叠,结束时不跳动。
test('超过 40 行的历史代码块默认折叠,点「展开全部」后完整显示', () => {
  const code = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
  render(<CodeBlock language="ts" lineCount={120}>{code}</CodeBlock>)
  const pre = document.querySelector('pre')!
  expect(pre).toHaveAttribute('data-code-collapsed', 'true')
  fireEvent.click(screen.getByRole('button', { name: /展开全部（120 行）/ }))
  expect(pre).not.toHaveAttribute('data-code-collapsed')
  expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull()
})

test('流式中挂载的长代码块不折叠,生成结束后也保持展开', () => {
  const code = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n')
  const { rerender } = render(<CodeBlock language="ts" live lineCount={120}>{code}</CodeBlock>)
  expect(document.querySelector('pre')).not.toHaveAttribute('data-code-collapsed')
  rerender(<CodeBlock language="ts" live={false} lineCount={120}>{code}</CodeBlock>)
  expect(document.querySelector('pre')).not.toHaveAttribute('data-code-collapsed')
})

test('短代码块不折叠;复制按钮复制的是完整内容', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const code = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')
  render(<CodeBlock language="ts" lineCount={80}>{code}</CodeBlock>)
  fireEvent.click(screen.getByRole('button', { name: '复制' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(code))
  render(<CodeBlock language="ts" lineCount={10}>short</CodeBlock>)
  expect(document.querySelectorAll('pre[data-code-collapsed]')).toHaveLength(1)
})

test('换行偏好同步到页面上其它代码块', () => {
  render(
    <>
      <CodeBlock language="ts">a</CodeBlock>
      <CodeBlock language="ts">b</CodeBlock>
    </>,
  )
  fireEvent.click(screen.getAllByRole('button', { name: '换行' })[0])
  for (const pre of document.querySelectorAll('pre')) expect(pre.className).toContain('whitespace-pre-wrap')
})

test('表头 sticky,外壳用 overflow-clip(不建滚动容器,sticky 才能生效)', () => {
  render(<CodeBlock language="ts">x</CodeBlock>)
  const header = screen.getByRole('button', { name: '复制' }).closest('div.sticky')
  expect(header).not.toBeNull()
  expect(header!.parentElement!.className).toContain('overflow-clip')
})
