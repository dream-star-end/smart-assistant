import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { CodeBlock } from './CodeBlock'

afterEach(() => {
  cleanup()
  localStorage.clear()
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
