import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// ── 代码高亮 / mermaid ────────────────────────────────────────────────────────
// 助手回复 99% 经 markdown,但高亮此前零断言(全仓 grep hljs 零命中)、mermaid 零测试。
// 高亮塌成纯文本、mermaid 语法半截时白屏,都是用户直接看得见的回归。
describe('MarkdownImpl 代码高亮', () => {
  test('围栏代码块真的产出 highlight.js token 元素，而不是塌成纯文本', () => {
    const source = ['```ts', 'const answer: number = 42', '```'].join('\n')
    const { container } = render(<MarkdownImpl>{source}</MarkdownImpl>)

    const code = container.querySelector('pre code')
    expect(code).not.toBeNull()
    // 语言被识别并透传(代码块头部据此显示语言名)。
    expect(container.querySelector('pre code .language-ts, pre code.language-ts')).not.toBeNull()
    // 真高亮的判据是产出了 token 元素;只要 rehype-highlight 被摘掉/失效就一个都没有。
    const tokens = container.querySelectorAll('pre code [class*="hljs-"]')
    expect(tokens.length).toBeGreaterThan(0)
    const tokenClasses = Array.from(tokens).map((n) => n.className)
    expect(tokenClasses.some((c) => c.includes('hljs-keyword'))).toBe(true)
    expect(tokenClasses.some((c) => c.includes('hljs-number'))).toBe(true)
    // 高亮不得改动源码文本本身(复制出去必须还是原样)。
    expect(code).toHaveTextContent('const answer: number = 42')
  })

  test('未标注语言的代码块仍进代码块外壳且不丢正文', () => {
    const source = ['```', 'plain text body', '```'].join('\n')
    const { container } = render(<MarkdownImpl>{source}</MarkdownImpl>)
    expect(container.querySelector('pre code')).toHaveTextContent('plain text body')
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
  })

  test('行内码不进代码块外壳（不该出现复制按钮）', () => {
    const { container } = render(<MarkdownImpl>{'请执行 `npm run build` 之后再试'}</MarkdownImpl>)
    expect(container.querySelector('code')).toHaveTextContent('npm run build')
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
  })
})

describe('MarkdownImpl mermaid 富块', () => {
  test('mermaid 围栏先给渲染中占位，不把源码当正文抖一下再替换', () => {
    const source = ['```mermaid', 'graph TD; A-->B;', '```'].join('\n')
    const { container } = render(<MarkdownImpl>{source}</MarkdownImpl>)
    expect(container.textContent).toContain('图表渲染中')
    // 占位阶段不得把 mermaid 源码当普通代码块渲染出来(流式期会一直闪)。
    expect(container.querySelector('pre code')).toBeNull()
  })

  test('mermaid 语法无效时回退可读源码，绝不白屏也不残留占位', async () => {
    const source = ['```mermaid', 'not a valid diagram at all {{{', '```'].join('\n')
    const { container } = render(<MarkdownImpl>{source}</MarkdownImpl>)
    // 轮询等 parse 落定:只放宽"什么时候读",不放宽"读到什么"。
    await waitFor(
      () => {
        expect(container.textContent).not.toContain('图表渲染中')
      },
      { timeout: 10000 },
    )
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre).toHaveTextContent('not a valid diagram at all {{{')
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
