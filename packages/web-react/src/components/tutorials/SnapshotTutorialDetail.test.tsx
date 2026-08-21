import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../lib/chat/model'
import type { CommunityTutorialDetail } from '../../lib/types'
import { SnapshotTutorialDetail } from './SnapshotTutorialDetail'

vi.mock('../MessageRenderer', () => ({
  MessageList: ({
    messages,
    readOnly,
  }: {
    messages: ChatMessage[]
    readOnly?: boolean
  }) => (
    <div data-testid="snapshot-messages" data-readonly={readOnly ? 'true' : 'false'}>
      {messages.map((message) => (
        <div key={message.id}>{message.text}</div>
      ))}
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const item: CommunityTutorialDetail = {
  id: 'snap-1',
  title: '一次真实分析会话',
  summary: '作者会话快照。',
  category: 'research',
  authorName: '作者',
  publishedAt: '2026-08-20T00:00:00.000Z',
  kind: 'snapshot',
  bodyMarkdown:
    '说明\n\n```htmlpreview\n<script>window.hacked = true</script>\n```',
  snapshot: {
    messages: [
      { id: 'u1', role: 'user', text: '开始分析', ts: 1 },
      { id: 'a1', role: 'assistant', text: '这是脱敏答复', ts: 2 },
    ],
  },
  artifacts: [
    {
      sha256: 'aaa',
      name: 'demo.html',
      mime: 'text/html',
      bytes: 12,
      embedUrl: '/api/tutorial-embeds/aaa',
      downloadUrl: '/api/tutorial-blobs/aaa',
      interactive: true,
    },
    {
      sha256: 'bbb',
      name: 'external.html',
      mime: 'text/html',
      bytes: 12,
      embedUrl: 'https://evil.test/page.html',
    },
  ],
}

describe('SnapshotTutorialDetail', () => {
  it('用只读轨迹渲染快照，HTML iframe 只有 allow-scripts，Markdown htmlpreview 不执行', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    render(<SnapshotTutorialDetail item={item} onBack={() => {}} />)

    expect(screen.getByText('作者真实会话快照 / 未经平台三次复跑')).toBeInTheDocument()
    expect(screen.getByTestId('snapshot-messages')).toHaveAttribute('data-readonly', 'true')
    expect(screen.getByText('开始分析')).toBeInTheDocument()
    const iframe = document.querySelector('iframe[title="demo.html"]')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    expect(iframe).toHaveAttribute('src', '/api/tutorial-embeds/aaa')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-forms')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-popups')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(screen.getByText('外部链接未自动加载')).toBeInTheDocument()
    expect(document.querySelector('iframe[src="https://evil.test/page.html"]')).toBeNull()
    expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined()
    expect(document.body.textContent).toContain('htmlpreview')

    fireEvent.click(screen.getByRole('button', { name: '复制分享链接' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled())
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('分页轨迹加载失败时显示错误和重试，不伪装没有轨迹', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    render(
      <SnapshotTutorialDetail
        item={{
          ...item,
          snapshot: {
            pages: [{ sha256: 'page1', messageCount: 2 }],
          },
          artifacts: [],
        }}
        onBack={() => {}}
      />,
    )
    expect(await screen.findByText(/脱敏轨迹分页加载失败/)).toBeInTheDocument()
    expect(screen.queryByText('没有可展示的公开轨迹。')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
