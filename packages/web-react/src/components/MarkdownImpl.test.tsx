import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

  test('只读链接图片只开灯箱，并保留 lazy loading 与全链路 no-referrer', () => {
    const { container } = render(
      <MarkdownImpl signMedia readOnly>
        {'[**![外链](//cdn.test/image.png)**](https://report.test)'}
      </MarkdownImpl>,
    )

    const thumbnail = screen.getByAltText('外链')
    expect(thumbnail).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(thumbnail).toHaveAttribute('loading', 'lazy')
    expect(thumbnail.closest('a')).toBeNull()
    expect(thumbnail.closest('strong')).not.toBeNull()
    expect(screen.getByRole('link', { name: '打开关联链接' })).toHaveAttribute('href', 'https://report.test')
    expect(container.querySelector('a[href="https://report.test"]')).toHaveAttribute('rel', 'noreferrer')
    fireEvent.click(screen.getByRole('button', { name: '放大查看 外链' }))

    const images = screen.getAllByAltText('外链')
    expect(images.length).toBeGreaterThanOrEqual(2)
    for (const image of images) expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    for (const action of ['编辑', '评论', '调整大小', '分享', '更多']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }
  })
})

test('GFM 长表格使用可聚焦滚动区，且同段代码块与公式保持真实渲染', () => {
  const source = [
    '| 第一列 | 第二列 | 第三列 | 第四列 | 第五列 | 第六列 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 很长的表格内容一 | 很长的表格内容二 | 很长的表格内容三 | 很长的表格内容四 | 很长的表格内容五 | 很长的表格内容六 |',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '$$',
    '\\frac{1}{2} + \\sqrt{4} = 2.5',
    '$$',
  ].join('\n')
  const { container } = render(<MarkdownImpl>{source}</MarkdownImpl>)

  const region = screen.getByRole('region', { name: 'Markdown 表格，可横向滚动' })
  expect(region).toHaveAttribute('tabindex', '0')
  expect(within(region).getByRole('table')).toHaveTextContent('很长的表格内容六')
  expect(screen.getByText('表格可左右滑动查看更多')).toHaveClass('sm:hidden')
  fireEvent.scroll(region)
  expect(screen.queryByText('表格可左右滑动查看更多')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
  expect(container.querySelector('pre code')).toHaveTextContent('const answer = 42')
  expect(container.querySelector('.katex-display .katex')).not.toBeNull()
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
