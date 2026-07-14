import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import MarkdownImpl from './MarkdownImpl'

afterEach(cleanup)

describe('MarkdownImpl readOnly', () => {
  const html = "```htmlpreview\n<script>fetch('https://tracker.test')</script>\n```"

  test('站内信只显示 HTML 源码，不挂载可执行 iframe', () => {
    const { container } = render(<MarkdownImpl readOnly>{html}</MarkdownImpl>)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('tracker.test')
  })

  test('普通聊天仍保留既有 HTML 沙盒预览', () => {
    const { container } = render(<MarkdownImpl>{html}</MarkdownImpl>)
    expect(container.querySelector('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  })

  test('只读站内信不解析容器文件路径，避免打开消息时启动用户容器', () => {
    const { container } = render(
      <MarkdownImpl signMedia readOnly>
        {'![私有文件](/home/agent/.openclaude/uploads/private.png)'}
      </MarkdownImpl>,
    )
    expect(container.textContent).toContain('私有文件')
    expect(container.querySelector('img')).toBeNull()
  })

  test('只读外链图片使用 no-referrer 原生渲染', () => {
    const { container } = render(
      <MarkdownImpl signMedia readOnly>
        {'![外链](//cdn.test/image.png)'}
      </MarkdownImpl>,
    )
    expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer')
  })
})

test('容器 loopback 链接显示预览标识且不交给浏览器新标签页', () => {
  const { container } = render(
    <MarkdownImpl>{'[打开应用](http://0.0.0.0:3000/dashboard)'}</MarkdownImpl>,
  )
  const anchor = container.querySelector('a')
  expect(anchor).toHaveAttribute('data-container-local-preview', 'true')
  expect(anchor).toHaveAttribute('data-product-feature', 'container-web-preview')
  expect(anchor).not.toHaveAttribute('target')
  expect(anchor).toHaveTextContent('容器预览')
})
