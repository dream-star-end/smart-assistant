import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import MarkdownImpl from './MarkdownImpl'
import { cachedCodeLanguage } from '../lib/codeLanguageDetect'

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

  test('不可信只读正文完全禁用图片加载，避免远程像素追踪', () => {
    const { container } = render(
      <MarkdownImpl readOnly blockImages>
        {'![远程追踪](https://tracker.test/pixel.png)\n\n![本地图片](/api/media/private.png)'}
      </MarkdownImpl>,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('[远程追踪]')
    expect(container.textContent).toContain('[本地图片]')
  })

  test('只读链接图片只开灯箱，并保留 lazy loading 与全链路 no-referrer', async () => {
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
    expect(screen.getByRole('link', { name: '打开关联链接' })).toHaveAttribute(
      'href',
      'https://report.test',
    )
    expect(container.querySelector('a[href="https://report.test"]')).toHaveAttribute(
      'rel',
      'noreferrer',
    )
    fireEvent.click(screen.getByRole('button', { name: '放大查看 外链' }))

    // 查看器是懒块(首屏预算):首开要等模块解析后大图才挂上。
    await waitFor(() => expect(screen.getAllByAltText('外链').length).toBeGreaterThanOrEqual(2))
    const images = screen.getAllByAltText('外链')
    for (const image of images) expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    for (const action of ['编辑', '评论', '调整大小', '分享', '更多']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }
  })
})

/** jsdom 无布局:按需伪造滚动区的 scrollWidth / clientWidth 来模拟「表格是否溢出容器」。 */
function mockRegionGeometry(scrollWidth: number, clientWidth: number) {
  const proto = HTMLElement.prototype
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
  }
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => scrollWidth })
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => clientWidth })
  return () => {
    for (const key of ['scrollWidth', 'clientWidth'] as const) {
      const descriptor = original[key]
      if (descriptor) Object.defineProperty(proto, key, descriptor)
      else delete (proto as unknown as Record<string, unknown>)[key]
    }
  }
}

const TABLE_SOURCE = [
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

test('GFM 长表格使用可聚焦滚动区，且同段代码块与公式保持真实渲染', () => {
  // 表格真的溢出容器(scrollWidth > clientWidth)→ 才出「可左右滑动」提示,滑过一次即消失。
  const restore = mockRegionGeometry(900, 360)
  try {
    const { container } = render(<MarkdownImpl>{TABLE_SOURCE}</MarkdownImpl>)

    const region = screen.getByRole('region', { name: 'Markdown 表格，可横向滚动' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveAttribute('data-overflowing', 'true')
    expect(within(region).getByRole('table')).toHaveTextContent('很长的表格内容六')
    expect(screen.getByText('表格可左右滑动查看更多')).toHaveClass('sm:hidden')
    fireEvent.scroll(region)
    expect(screen.queryByText('表格可左右滑动查看更多')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
    expect(container.querySelector('pre code')).toHaveTextContent('const answer = 42')
    expect(container.querySelector('.katex-display .katex')).not.toBeNull()
  } finally {
    restore()
  }
})

// M-02:此前提示在表格并未溢出时也常显(文案与实际不符);单元格在 .prose{word-break:break-word} 下
// 会把 `MessageRenderer.tsx` / 「风险」在任意位置拆行,把宽表硬压进 390px 容器。
describe('MarkdownImpl 表格(M-02)', () => {
  test('表格放得下(未溢出)时不出「可左右滑动」提示', () => {
    const restore = mockRegionGeometry(360, 360)
    try {
      render(<MarkdownImpl>{TABLE_SOURCE}</MarkdownImpl>)
      const region = screen.getByRole('region', { name: 'Markdown 表格，可横向滚动' })
      expect(region).toHaveAttribute('data-overflowing', 'false')
      expect(screen.queryByText('表格可左右滑动查看更多')).not.toBeInTheDocument()
    } finally {
      restore()
    }
  })

  test('单元格不拆词:th/td 用 keep-all,表头不折行,宽表按 min-content 撑进横滑区', () => {
    render(<MarkdownImpl>{TABLE_SOURCE}</MarkdownImpl>)
    const table = screen.getByRole('table')
    expect(table).toHaveClass('[&_td]:[word-break:keep-all]')
    expect(table).toHaveClass('[&_td]:[overflow-wrap:normal]')
    expect(table).toHaveClass('[&_th]:[word-break:keep-all]')
    expect(table).toHaveClass('[&_th]:whitespace-nowrap')
  })
})

// M-06:流式光标此前是 Markdown 块级容器之后的兄弟节点,永远落在正文最后一行**下方**单独一行。
// 现在由 rehype 注入到最后一个文本块末尾;末块是代码块等非文本块时回退到块后单独一行。
describe('MarkdownImpl 流式光标(caret)', () => {
  const caret = (container: HTMLElement) => container.querySelectorAll('[data-live-caret]')

  test('caret=false 不注入任何光标', () => {
    const { container } = render(<MarkdownImpl>{'第一段\n\n第二段'}</MarkdownImpl>)
    expect(caret(container)).toHaveLength(0)
  })

  test('末块是段落:光标内联在最后一个 <p> 末尾,与文字同一行', () => {
    const { container } = render(<MarkdownImpl caret>{'第一段\n\n第二段 **强调**'}</MarkdownImpl>)
    const nodes = caret(container)
    expect(nodes).toHaveLength(1)
    const node = nodes[0]
    expect(node.tagName.toLowerCase()).toBe('span')
    expect(node).toHaveClass('caret-blink', 'inline-block', 'bg-current')
    expect(node).toHaveAttribute('aria-hidden', 'true')
    const paragraphs = container.querySelectorAll('.prose > p')
    expect(paragraphs).toHaveLength(2)
    expect(node.parentElement).toBe(paragraphs[1])
    expect(paragraphs[1].lastElementChild).toBe(node)
    expect(container.querySelector('[data-live-caret-fallback]')).toBeNull()
  })

  test('末块是列表 / 引用 / 表格:光标下钻到最后一个文本块(末项 li / 引用段 / 末格)', () => {
    const list = render(<MarkdownImpl caret>{'说明\n\n- 甲\n- 乙'}</MarkdownImpl>)
    const listItems = list.container.querySelectorAll('li')
    expect(caret(list.container)[0].parentElement).toBe(listItems[listItems.length - 1])
    cleanup()

    const quote = render(<MarkdownImpl caret>{'> 引用第一段\n>\n> 引用第二段'}</MarkdownImpl>)
    const quoteParagraphs = quote.container.querySelectorAll('blockquote > p')
    expect(caret(quote.container)[0].parentElement).toBe(quoteParagraphs[quoteParagraphs.length - 1])
    cleanup()

    const table = render(
      <MarkdownImpl caret>{'| a | b |\n| --- | --- |\n| 1 | 2 |'}</MarkdownImpl>,
    )
    const cells = table.container.querySelectorAll('td')
    expect(caret(table.container)[0].parentElement).toBe(cells[cells.length - 1])
  })

  test('末块是代码块:回退到块后单独一行,不塞进 <pre>', () => {
    const { container } = render(<MarkdownImpl caret>{'先说明\n\n```ts\nconst a = 1\n```'}</MarkdownImpl>)
    const nodes = caret(container)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].closest('pre')).toBeNull()
    const fallback = container.querySelector('[data-live-caret-fallback]')
    expect(fallback).not.toBeNull()
    expect(fallback?.parentElement).toHaveClass('prose')
    expect(fallback?.previousElementSibling?.tagName.toLowerCase()).toBe('div') // CodeBlock 外壳
  })
})

// ── 代码高亮 ────────────────────────────────────────────────────────
// 助手回复 99% 经 markdown,但高亮此前零断言(全仓 grep hljs 零命中):高亮塌成纯文本
// 是用户直接看得见的回归。mermaid 刻意不在 jsdom 断言 —— "图出来了"要真 SVG 布局才量得到,
// jsdom 里只能等一个多兆动态 import 的 parse,在负载机上必然抖。那条覆盖在真浏览器套件:
// browser-tests 的 T24(有效语法出带节点文案的 SVG / 半截语法回退源码 / 不注错误图进 body)。
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

describe('MarkdownImpl signMedia 路径卡片', () => {
  test('fenced 整块就是一条生成路径 → filecard，不进代码块', () => {
    const source = ['```', '/home/agent/.openclaude/generated/report.docx', '```'].join('\n')
    render(<MarkdownImpl signMedia>{source}</MarkdownImpl>)
    expect(screen.getByText('report.docx')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull()
  })

  test('生成目录里的 .html 路径 → 无缝嵌入外壳 + 仍保留下载卡(取到内容前只有下载卡)', () => {
    render(<MarkdownImpl signMedia>{'户型模型:`/home/agent/.openclaude/generated/house.html`'}</MarkdownImpl>)
    expect(screen.getByText('house.html')).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
  })

  test('fenced 含路径以外正文 → 仍是代码块', () => {
    const source = ['```', '/home/agent/.openclaude/generated/report.docx', 'echo hi', '```'].join('\n')
    const { container } = render(<MarkdownImpl signMedia>{source}</MarkdownImpl>)
    expect(container.querySelector('pre code')).toHaveTextContent('report.docx')
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
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

describe('MarkdownImpl autoDetectCode', () => {
  test('autoDetectCode=false：无语言代码块不做语言探测（大围栏不触发同步高亮）', () => {
    const big = '```\n' + 'a'.repeat(50_000) + '\n```'
    const started = performance.now()
    const { container } = render(<MarkdownImpl readOnly autoDetectCode={false}>{big}</MarkdownImpl>)
    expect(container.querySelector('.hljs')).toBeNull()
    expect(container.textContent).toContain('a'.repeat(1000))
    expect(performance.now() - started).toBeLessThan(5000)
    cleanup()
    // 缩进代码块同理。
    const { container: c2 } = render(
      <MarkdownImpl readOnly autoDetectCode={false}>{'说明\n\n    const x = 1;\n    let y = 2;'}</MarkdownImpl>,
    )
    expect(c2.querySelector('.hljs')).toBeNull()
  })

  test('缺省仍自动探测（聊天正文行为不变）；标了语言的块照常高亮', () => {
    const { container } = render(<MarkdownImpl>{'```\nconst x = 1;\nlet y = 2;\n```'}</MarkdownImpl>)
    expect(container.querySelector('.hljs')).not.toBeNull()
    cleanup()
    const { container: c2 } = render(
      <MarkdownImpl readOnly autoDetectCode={false}>{'```ts\nconst x: number = 1;\n```'}</MarkdownImpl>,
    )
    expect(c2.querySelector('.hljs')).not.toBeNull()
  })
})

// OCV5-421: 共享的高亮实例 + 常见语言内的自动探测。
describe('MarkdownImpl 代码高亮(OCV5-421)', () => {
  const py = '```\nimport os\n\ndef main():\n    for name in os.listdir("."):\n        print(name)\n```'

  test('无标注的常见语言代码仍被探测并高亮,重复渲染结果一致', () => {
    for (let i = 0; i < 3; i++) {
      const { container, unmount } = render(<MarkdownImpl>{py}</MarkdownImpl>)
      // CodeBlock 外层 <code class="font-mono"> 包着带高亮类名的 span。
      const code = container.querySelector('pre code > span')!
      expect(code.className).toContain('language-python')
      expect(code.querySelector('.hljs-keyword')).not.toBeNull()
      unmount()
    }
  })

  test('有标注的语言照常高亮(不受探测子集限制)', () => {
    const { container } = render(<MarkdownImpl>{'```kotlin\nfun main() { val x = 1 }\n```'}</MarkdownImpl>)
    expect(container.querySelector('pre code > span')!.className).toContain('hljs')
    expect(container.querySelector('pre .hljs-keyword')).not.toBeNull()
  })

  test('autoDetectCode=false 时无标注块不探测(流式尾段)', () => {
    const { container } = render(<MarkdownImpl autoDetectCode={false}>{py}</MarkdownImpl>)
    expect(container.querySelector('pre code > span')!.className).not.toContain('language-python')
  })

  // OCV5-422: 探测结果按代码原文缓存;第二次起直接按记住的语言高亮,输出必须与第一次逐字一致。
  test('同一段无标注代码再次渲染(走探测缓存)与首次渲染的 DOM 完全相同', () => {
    const unique = `ocv5-422-${Math.random().toString(36).slice(2)}`
    const code = `\`\`\`\nimport os\n\ndef ${unique.replace(/-/g, '_')}():\n    return [os.sep for _ in range(3)]\n\`\`\``
    const first = render(<MarkdownImpl>{code}</MarkdownImpl>)
    const html = first.container.innerHTML
    expect(first.container.querySelector('pre code > span')!.className).toContain('language-python')
    first.unmount()
    for (let i = 0; i < 2; i++) {
      const again = render(<MarkdownImpl>{code}</MarkdownImpl>)
      expect(again.container.innerHTML).toBe(html)
      again.unmount()
    }
  })

  test('探测不出语言的块:缓存后仍只有 hljs、没有语言类,正文原样', () => {
    const unique = Math.random().toString(36).slice(2)
    const code = `\`\`\`\n┌──┐ ${unique}\n│  │\n└──┘\n\`\`\``
    const first = render(<MarkdownImpl>{code}</MarkdownImpl>)
    const html = first.container.innerHTML
    const span = first.container.querySelector('pre code > span')!
    expect(span.className).toContain('hljs')
    expect(span.className).not.toContain('language-')
    first.unmount()
    const again = render(<MarkdownImpl>{code}</MarkdownImpl>)
    expect(again.container.innerHTML).toBe(html)
    expect(again.container.textContent).toContain(unique)
  })

  test('大块无标注代码不在渲染里同步探测:先按纯文本代码块显示,探测完再上色', async () => {
    const unique = Math.random().toString(36).slice(2).replace(/[0-9]/g, 'x')
    const body = Array.from({ length: 50 }, (_, i) => `def handler_${unique}_${i}(event):\n    return [item for item in event if item]`).join('\n')
    const { container } = render(<MarkdownImpl>{`\`\`\`\n${body}\n\`\`\``}</MarkdownImpl>)
    const code = () => container.querySelector('pre code > span')!
    expect(code().className).not.toContain('hljs')
    expect(code().textContent).toContain(`handler_${unique}_49`)
    await waitFor(() => expect(code().className).toContain('language-python'), { timeout: 10_000 })
    expect(container.querySelector('pre .hljs-keyword')).not.toBeNull()
    expect(code().textContent).toContain(`handler_${unique}_49`)
  })

  // OCV5-422: 代码块后面紧跟表格时,它一直在流式尾段里(表格行不是切段点),以前要等生成结束才开始探测。
  test('流式尾段里已写完的大块无标注代码在后台预先探测;生成结束那次渲染直接上色', async () => {
    const unique = Math.random().toString(36).slice(2).replace(/[0-9]/g, 'y')
    const body = Array.from({ length: 50 }, (_, i) => `def fetch_${unique}_${i}(url):\n    return [line for line in open(url) if line]`).join('\n')
    const text = `\`\`\`\n${body}\n\`\`\`\n\n| 项 | 值 |\n|---|---|\n| a | 1 |`
    const live = render(<MarkdownImpl live autoDetectCode={false}>{text}</MarkdownImpl>)
    expect(live.container.querySelector('pre code > span')!.className).not.toContain('hljs')
    await waitFor(() => expect(cachedCodeLanguage(`${body}\n`)).toBe('python'), { timeout: 10_000 })
    expect(live.container.querySelector('pre code > span')!.className).not.toContain('hljs') // 预取不改流式中的渲染
    live.rerender(<MarkdownImpl>{text}</MarkdownImpl>)
    expect(live.container.querySelector('pre code > span')!.className).toContain('language-python') // 同一次渲染即上色
  })

  test('流式尾段以代码块结尾(可能还没闭合)时不预取探测', async () => {
    const unique = Math.random().toString(36).slice(2).replace(/[0-9]/g, 'z')
    const body = Array.from({ length: 50 }, (_, i) => `def open_${unique}_${i}(url):\n    return [line for line in open(url) if line]`).join('\n')
    render(<MarkdownImpl live autoDetectCode={false}>{`说明：\n\n\`\`\`\n${body}`}</MarkdownImpl>)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cachedCodeLanguage(`${body}\n`)).toBeUndefined()
  })

  test('流式中未闭合的 $$ 不渲染半截公式,显示「公式生成中…」', () => {
    const { container } = render(<MarkdownImpl live>{'推导：\n\n$$\n\\frac{a}{'}</MarkdownImpl>)
    expect(container.querySelector('.katex-error')).toBeNull()
    expect(screen.getByText('公式生成中…')).toBeInTheDocument()
  })

  test('表格单元格里独立的 <br> 变成换行,其它原始 HTML 仍转义', () => {
    const { container } = render(<MarkdownImpl>{'| a | b |\n|---|---|\n| 第一行<br>第二行 | <b>x</b> |'}</MarkdownImpl>)
    expect(container.querySelector('td br')).not.toBeNull()
    expect(container.querySelector('td b')).toBeNull()
  })

  test('脚注锚点在当前页跳转,外链仍开新标签', () => {
    const { container } = render(<MarkdownImpl>{'结论[^1]，见 [官网](https://example.com)\n\n[^1]: 来源'}</MarkdownImpl>)
    for (const a of container.querySelectorAll('a[href^="#"]')) expect(a).not.toHaveAttribute('target')
    expect(container.querySelector('a[href="https://example.com"]')).toHaveAttribute('target', '_blank')
    expect(container.querySelector('[node]')).toBeNull()
  })
})


test('OCV5-508 artifact anchors reuse signing and retain their label', async () => {
  const { MediaSignProvider } = await import('./chat/media');
  const sign = vi.fn(async (paths: string[]) => Object.fromEntries(paths.map((path) => [path, '/api/media?signature=fixture'])));
  const { container } = render(
    <MediaSignProvider sign={sign} authKey="fixture">
      <MarkdownImpl signMedia>{'[下载季度报表](/home/agent/.openclaude/generated/%E6%8A%A5%E8%A1%A8%202026.csv)'}</MarkdownImpl>
      <MarkdownImpl signMedia readOnly>{'[只读文件](/home/agent/.openclaude/generated/private.csv)'}</MarkdownImpl>
      <MarkdownImpl signMedia>{'[普通站内链接](/help/report.csv)'}</MarkdownImpl>
    </MediaSignProvider>,
  );
  await waitFor(() => expect(screen.getByRole('link', { name: '下载季度报表' })).toHaveAttribute('href', '#'));
  expect(sign).toHaveBeenCalledExactlyOnceWith(['/home/agent/.openclaude/generated/报表 2026.csv']);
  expect(screen.getByRole('link', { name: '只读文件' })).toHaveAttribute('href', '/home/agent/.openclaude/generated/private.csv');
  expect(screen.getByRole('link', { name: '普通站内链接' })).toHaveAttribute('href', '/help/report.csv');
  expect(container.querySelector('a a')).toBeNull();
});
