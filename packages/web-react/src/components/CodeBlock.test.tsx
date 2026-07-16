import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { CodeBlock } from './CodeBlock'

afterEach(cleanup)

test('代码复制按钮不会提交父表单，粗指针下命中高度为 44px', () => {
  render(<CodeBlock language="ts">const answer = 42;</CodeBlock>)
  const copy = screen.getByRole('button', { name: '复制' })
  expect(copy).toHaveAttribute('type', 'button')
  expect(copy).toHaveClass('[@media(hover:none)]:min-h-11')
})
