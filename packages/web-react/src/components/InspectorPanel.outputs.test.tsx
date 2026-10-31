/**
 * OCV5-372 / OCV5-687 详情面板「产出」页:默认分区、全会话按轮分组展示(当前轮在上)、主产物直接渲染
 * (网页沙盒 / 文档 / CSV 表格 / 代码)、回放不出来时读容器文件、首轮及运行中不闪空态、聊天卡片点开预览。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatMessage } from '../lib/chat/model'
import { loadBeforeAll } from '../test/moduleLoad'
import { InspectorPanelContent, preloadInspectorStepsPlan } from './InspectorPanel'
import { prefetchMarkdownImpl } from './Markdown'
import { wrapWithCspOnly } from './embedCsp'
import { preloadToolBody } from './tool/lazyToolBody'

// 渲染工具卡展开体的断言要等懒加载的 tool bodies;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(preloadToolBody)
loadBeforeAll(preloadInspectorStepsPlan)
// 文档正文走懒加载的 Markdown 渲染器,同理先加载好。
loadBeforeAll(prefetchMarkdownImpl)

// 读容器文件的那条回落:测试里没有签名通道,直接替换受限读取(其余导出照旧)。
const fetchSignedCapped = vi.hoisted(() => vi.fn())
vi.mock('./project/outputPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project/outputPreview')>()),
  fetchSignedCapped,
}))
const bytes = (text: string) => ({
  kind: 'ok' as const,
  bytes: new TextEncoder().encode(text),
  type: 'text/plain',
  truncated: false,
})

afterEach(cleanup)
beforeEach(() => {
  fetchSignedCapped.mockReset()
  fetchSignedCapped.mockRejectedValue(new Error('签名失败'))
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

const TS = 1_700_000_000_000
const user = (id: string, text: string, ts = TS): ChatMessage => ({
  id,
  role: 'user',
  text,
  ts,
  status: 'replied',
})
const assistant = (id: string, text: string, ts = TS): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  ts,
})
const tool = (
  id: string,
  toolName: string,
  inputJson: Record<string, unknown>,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  role: 'tool',
  text: toolName,
  ts: TS,
  toolName,
  inputJson,
  _completed: true,
  output: 'ok',
  ...extra,
})

const W = '/home/agent/.openclaude/workspace/s1'

function session(): ChatMessage[] {
  return [
    user('u1', '做一个落地页', TS),
    tool(
      's1',
      'WebSearch',
      { query: 'landing' },
      { output: '  - [Landing Patterns](https://www.example.org/landing): 指南' },
    ),
    tool(
      'w1',
      'Write',
      { file_path: `${W}/index.html`, content: '<h1>Hello</h1>\n' },
      { ts: TS + 2000, completedAt: TS + 3000 },
    ),
    tool(
      'e1',
      'Edit',
      { file_path: `${W}/index.html`, old_string: 'Hello', new_string: 'Hello world' },
      { ts: TS + 4000, completedAt: TS + 5000 },
    ),
    tool('w2', 'Write', { file_path: `${W}/style.css`, content: 'h1 { color: red }\n' }),
    assistant('a1', `做好了,截图 \`${W}/shot.png\`,预览 http://localhost:5173/ 。`, TS + 65_000),
    user('u2', '写个说明', TS + 70_000),
    tool('w3', 'Write', { file_path: `${W}/README.md`, content: '# 说明\n\n- 一\n- 二\n' }),
    assistant('a2', '写好了。', TS + 80_000),
  ]
}

/** 产出页是懒加载块:先等它挂上。 */
const outputsReady = () => screen.findByTestId(/^outputs-(view|empty)$/)

describe('产出页', () => {
  // OCV5-687: 产出面板由单轮箭头翻页改为默认汇总本会话全部轮次产出(按轮分组,当前轮在上,无需点箭头找历史文件)
  test('默认分区是产出:汇总展示本会话全部产出(按轮分组,当前轮在上),标题与摘要完整', async () => {
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />)
    await outputsReady()
    expect(screen.getByRole('tab', { name: '产出' })).toHaveAttribute('aria-selected', 'true')
    const groups = screen.getAllByTestId('outputs-turn-group')
    expect(groups).toHaveLength(2)
    expect(within(groups[0]).getByTestId('outputs-turn')).toHaveTextContent('写个说明')
    expect(within(groups[0]).getByTestId('outputs-turn-counter')).toHaveTextContent('第 2 轮')
    expect(within(groups[0]).getByTestId('outputs-summary')).toHaveTextContent('用时 10 秒')
    expect(within(groups[0]).getByTestId('outputs-summary')).toHaveTextContent('1 步')

    expect(within(groups[1]).getByTestId('outputs-turn')).toHaveTextContent('做一个落地页')
    expect(within(groups[1]).getByTestId('outputs-turn-counter')).toHaveTextContent('第 1 轮')
    expect(within(groups[1]).getByTestId('outputs-summary')).toHaveTextContent('用时 1 分 5 秒')
    expect(within(groups[1]).getByTestId('outputs-summary')).toHaveTextContent('4 步')
    expect(within(groups[1]).getByTestId('outputs-summary')).toHaveTextContent('2 个文件')
  })

  test('主产物:网页用沙盒 iframe 渲染回放出的最终内容;可切源码 / 改动;其余产出按轮列在下面', async () => {
    const messages = session()
    render(
      <InspectorPanelContent
        messages={messages}
        request={{ tab: 'outputs', message: messages[2], nonce: 1 }}
        onClose={() => {}}
      />,
    )
    await outputsReady()
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('index.html')
    const frame = await screen.findByTestId('output-preview-frame')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    expect(frame.getAttribute('srcdoc')).toBe(wrapWithCspOnly('<h1>Hello world</h1>\n'))
    // 与聊天里的 HTML 嵌入同一份 CSP,且排在模型代码之前
    expect(frame.getAttribute('srcdoc')).toMatch(
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/,
    )
    expect(screen.getByTestId('outputs-hero-origin')).toHaveTextContent('内容来自会话记录')

    fireEvent.click(screen.getByRole('radio', { name: '源码' }))
    expect(await screen.findByTestId('output-preview-source')).toHaveTextContent('Hello world')
    fireEvent.click(screen.getByRole('radio', { name: '改动 2' }))
    expect(screen.getAllByTestId('pane-file-change')).toHaveLength(2)

    // OCV5-687: 面板默认列出全会话各轮文件(第 2 轮 README.md 在上,第 1 轮 index.html / style.css 在下)
    const files = screen.getAllByTestId('outputs-file')
    expect(files.map((f) => f.textContent)).toEqual([
      expect.stringContaining('README.md'),
      expect.stringContaining('index.html'),
      expect.stringContaining('style.css'),
    ])
    expect(files[1]).toHaveAttribute('aria-current', 'true')
    expect(screen.getAllByTestId('outputs-media')).toHaveLength(1)
    const link = screen.getByTestId('outputs-link')
    expect(link).toHaveAttribute('href', 'http://localhost:5173/')
    const source = screen.getByTestId('outputs-source')
    expect(source).toHaveTextContent('Landing Patterns')
    expect(source).toHaveTextContent('example.org')
    expect(source).toHaveAttribute('target', '_blank')
    expect(source).toHaveAttribute('rel', 'noopener noreferrer')

    // 点别的文件 → 成为主产物
    fireEvent.click(files[2])
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('style.css')
    expect(await screen.findByTestId('output-preview-source')).toHaveTextContent('color: red')
  })

  test('文档渲染成排版好的正文', async () => {
    render(<InspectorPanelContent messages={session()} onClose={() => {}} />)
    await outputsReady()
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('README.md')
    const md = await screen.findByTestId('output-preview-markdown')
    expect(await within(md).findByRole('heading', { name: '说明' })).toBeInTheDocument()
    expect(within(md).getAllByRole('listitem')).toHaveLength(2)
  })

  test('回放不出来(只有 Edit)→ 读容器里的当前文件;读不到给重试', async () => {
    render(
      <InspectorPanelContent
        messages={[
          user('u1', '改一下'),
          tool('e1', 'Edit', { file_path: `${W}/app.py`, old_string: 'a', new_string: 'b' }),
        ]}
        onClose={() => {}}
      />,
    )
    await outputsReady()
    expect(screen.getByTestId('outputs-hero-origin')).toHaveTextContent('容器里的当前文件')
    // 测试环境没有签名通道 → 读取失败,给重试
    expect(await screen.findByText('没能读取这个文件（可能已被移动或删除）。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
  })

  test('读容器文件的回落:文件又被改过(新的一次 Edit 完成)就重读', async () => {
    fetchSignedCapped
      .mockResolvedValueOnce(bytes('VERSION-B'))
      .mockResolvedValueOnce(bytes('VERSION-C'))
    const first = [
      user('u1', '改一下'),
      tool('e1', 'Edit', { file_path: `${W}/app.py`, old_string: 'a', new_string: 'b' }),
    ]
    const { rerender } = render(<InspectorPanelContent messages={first} onClose={() => {}} />)
    await outputsReady()
    expect(await screen.findByText(/VERSION-B/)).toBeInTheDocument()
    const second = [
      ...first,
      tool('e2', 'Edit', { file_path: `${W}/app.py`, old_string: 'b', new_string: 'c' }),
    ]
    rerender(<InspectorPanelContent messages={second} onClose={() => {}} />)
    expect(await screen.findByText(/VERSION-C/)).toBeInTheDocument()
    expect(fetchSignedCapped).toHaveBeenCalledTimes(2)
  })

  test('读容器文件的回落:提到这个文件的脚本命令跑完后重读(命令返回时才写)', async () => {
    fetchSignedCapped
      .mockResolvedValueOnce(bytes('OLD-CONTENT'))
      .mockResolvedValueOnce(bytes('NEW-CONTENT'))
    const write = tool('w1', 'Write', { file_path: '/tmp/a.md', content: 'old\n' })
    const script = { command: "sleep 2; python3 -c \"open('/tmp/a.md','w').write('new')\"" }
    const running = [
      user('u1', '改'),
      write,
      tool('b1', 'Bash', script, { _completed: false, output: '' }),
    ]
    const { rerender } = render(
      <InspectorPanelContent messages={running} running onClose={() => {}} />,
    )
    await outputsReady()
    fireEvent.click(screen.getByRole('radio', { name: '源码' }))
    expect(await screen.findByText(/OLD-CONTENT/)).toBeInTheDocument()
    const done = [
      user('u1', '改'),
      write,
      tool('b1', 'Bash', script, { _completed: true, output: '' }),
    ]
    rerender(<InspectorPanelContent messages={done} running onClose={() => {}} />)
    expect(await screen.findByText(/NEW-CONTENT/)).toBeInTheDocument()
    expect(screen.getByTestId('outputs-hero-origin')).toHaveTextContent('容器里的当前文件')
  })

  // OCV5-687: 新一轮运行或纯文本追问无新文件时,保留历史轮次产出可见,不再隐藏进空态让人点箭头找
  test('运行中与后续无新产出轮:顶部提示当前轮状态,同时保留历史轮次主产物与列表直接可见', async () => {
    const first = session().slice(0, 6)
    const { rerender } = render(
      <InspectorPanelContent messages={first} running onClose={() => {}} />,
    )
    await outputsReady()
    expect(screen.getByTestId('outputs-turn')).toHaveTextContent('进行中')

    const second = [...first, user('u2', '再来一轮纯追问', TS + 70_000)]
    rerender(<InspectorPanelContent messages={second} running onClose={() => {}} />)
    expect(screen.getByTestId('outputs-running')).toHaveTextContent(
      '第 2 轮进行中 · 再来一轮纯追问',
    )
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('index.html')
    expect(screen.queryByTestId('outputs-none')).not.toBeInTheDocument()

    const finishedFollowup = [...second, assistant('a2', '好的,已解答。')]
    rerender(
      <InspectorPanelContent messages={finishedFollowup} running={false} onClose={() => {}} />,
    )
    expect(screen.getByTestId('outputs-latest-note')).toHaveTextContent('无新增产出')
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('index.html')
    expect(screen.getAllByTestId('outputs-file')).toHaveLength(2)
  })

  test('首轮运行中(消息尚未落盘或尚无产出):显示安静进行中状态,绝不先闪「还没有产出 / 没有产出文件」', async () => {
    const { rerender } = render(<InspectorPanelContent messages={[]} running onClose={() => {}} />)
    await screen.findByTestId('outputs-view')
    expect(screen.getByTestId('outputs-running')).toHaveTextContent('正在处理中')
    expect(screen.queryByTestId('outputs-empty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('outputs-none')).not.toBeInTheDocument()

    rerender(
      <InspectorPanelContent
        messages={[
          user('u1', '帮我整理数据'),
          tool('b1', 'Bash', { command: 'ls' }, { _completed: false }),
        ]}
        running
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('outputs-running')).toHaveTextContent('正在处理中')
    expect(screen.queryByTestId('outputs-empty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('outputs-none')).not.toBeInTheDocument()
  })

  test('整段会话都没有产出文件时给安静的空态,「查看步骤」进步骤页', async () => {
    render(
      <InspectorPanelContent
        messages={[
          user('u1', '跑一下测试'),
          tool('b1', 'Bash', { command: 'npm test' }),
          assistant('a1', '都过了'),
        ]}
        onClose={() => {}}
      />,
    )
    await outputsReady()
    expect(screen.getByTestId('outputs-none')).toHaveTextContent('还没有产出文件')
    fireEvent.click(screen.getByTestId('outputs-open-steps'))
    expect(screen.getByRole('tab', { name: /步骤/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('pane-step-list')).toBeInTheDocument()
  })

  test('聊天文件卡片点开预览(_output_file 请求):面板聚焦该 CSV 并渲染为表格,仍可切换源码', async () => {
    const csvPath = `${W}/report.csv`
    const messages = [
      ...session(),
      user('u3', '导出表格', TS + 90_000),
      tool('w4', 'Write', { file_path: csvPath, content: '月份,销售额\n1月,1200\n2月,1580\n' }),
      assistant('a3', '已导出。'),
    ]
    const { rerender } = render(<InspectorPanelContent messages={messages} onClose={() => {}} />)
    await outputsReady()
    fireEvent.click(
      screen.getAllByTestId('outputs-file').find((el) => el.textContent?.includes('README.md'))!,
    )
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('README.md')

    rerender(
      <InspectorPanelContent
        messages={messages}
        request={{
          tab: 'outputs',
          message: { toolName: '_output_file', inputJson: { file_path: csvPath } },
          nonce: 99,
        }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('outputs-hero-name')).toHaveTextContent('report.csv')
    const table = await screen.findByTestId('output-preview-table')
    expect(within(table).getByText('1580')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: '源码' }))
    expect(await screen.findByTestId('output-preview-source')).toHaveTextContent('月份,销售额')
  })

  test('参考来源默认列 5 条,其余收在「显示全部」里', async () => {
    const links = Array.from({ length: 8 }, (_, i) => ({
      title: `来源 ${i + 1}`,
      url: `https://s${i + 1}.example.com/`,
    }))
    render(
      <InspectorPanelContent
        messages={[
          user('u1', '查'),
          tool('s1', 'WebSearch', { query: 'q' }, { output: `Links: ${JSON.stringify(links)}` }),
        ]}
        onClose={() => {}}
      />,
    )
    await outputsReady()
    expect(screen.getAllByTestId('outputs-source')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('outputs-sources-more'))
    expect(screen.getAllByTestId('outputs-source')).toHaveLength(8)
    expect(screen.getByTestId('outputs-sources-more')).toHaveTextContent('收起')
  })

  test('会话还没有任何轮:整页空态', async () => {
    render(<InspectorPanelContent messages={[]} onClose={() => {}} />)
    await outputsReady()
    expect(screen.getByTestId('outputs-empty')).toHaveTextContent('还没有产出')
  })
})
