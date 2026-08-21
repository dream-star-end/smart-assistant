import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type { ChatMessage } from '../../lib/chat/model'
import type { AuthSession, ProjectAsset } from '../../lib/types'
import { MAX_TUTORIAL_ARTIFACT_BYTES } from '../../lib/tutorialStudio'
import { PublishFromSessionDialog } from './PublishFromSessionDialog'

vi.mock('../MessageRenderer', () => ({
  MessageList: ({
    messages,
    readOnly,
  }: {
    messages: ChatMessage[]
    readOnly?: boolean
  }) => (
    <div data-testid="snapshot-preview" data-readonly={readOnly ? 'true' : 'false'}>
      {messages.map((message) => (
        <div key={message.id}>{message.text}</div>
      ))}
    </div>
  ),
}))

const auth = {
  snapshot: () => ({ token: 'token', epoch: 1 }),
  beginIdentity: () => 1,
  commitToken: () => true,
  expire: () => true,
} as AuthSession

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', text: '帮我整理这份公开数据', ts: 1 },
  { id: 's1', role: 'system', text: '内部提示', ts: 2 },
  { id: 'a1', role: 'assistant', text: '这是公开答复', ts: 3 },
]

function asset(partial: Partial<ProjectAsset> & Pick<ProjectAsset, 'id' | 'name'>): ProjectAsset {
  return {
    projectId: 'p1',
    source: 'output',
    sessionId: 'sess-1',
    url: `/out/${partial.name}`,
    containerPath: `/home/agent/.openclaude/generated/${partial.name}`,
    mime: 'text/plain',
    sizeBytes: 12,
    excerpt: null,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

beforeEach(() => {
  vi.spyOn(api, 'listProjectAssets').mockResolvedValue([
    asset({ id: 'keep', name: 'report.md', mime: 'text/markdown', sizeBytes: 24 }),
    asset({ id: 'svg', name: 'chart.svg', mime: 'image/svg+xml', sizeBytes: 40 }),
    asset({
      id: 'huge',
      name: 'huge.png',
      mime: 'image/png',
      sizeBytes: MAX_TUTORIAL_ARTIFACT_BYTES + 1,
    }),
    asset({ id: 'upload', name: 'notes.txt', source: 'upload', mime: 'text/plain' }),
    asset({ id: 'other', name: 'other.md', sessionId: 'sess-2', mime: 'text/markdown' }),
  ])
  vi.spyOn(api, 'mediaSign').mockResolvedValue({
    urls: { '/home/agent/.openclaude/generated/report.md': '/api/media-signed?k=1' },
    expMs: 60_000,
  })
  vi.spyOn(api, 'fetchSignedMedia').mockResolvedValue(new Blob(['# report'], { type: 'text/markdown' }))
  vi.spyOn(api, 'submitTutorialSnapshot').mockResolvedValue({
    tutorial: { id: 't9', status: 'pending', createdAt: '2026-08-20T00:00:00.000Z', kind: 'snapshot' },
    leakReport: { strippedRoles: ['system'] },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PublishFromSessionDialog', () => {
  it('默认不勾选成果，提交时 artifacts 为空，并预览剥离内部角色后的只读轨迹', async () => {
    const onSubmitted = vi.fn()
    render(
      <PublishFromSessionDialog
        open
        onOpenChange={() => {}}
        auth={auth}
        sessionId="sess-1"
        sessionTitle="公开数据分析"
        projectId="p1"
        messages={messages}
        onSubmitted={onSubmitted}
      />,
    )

    expect(await screen.findByLabelText('勾选成果 report.md')).not.toBeChecked()
    expect(screen.getByLabelText('勾选成果 report.md')).toBeInTheDocument()
    expect(screen.queryByLabelText('勾选成果 notes.txt')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('勾选成果 other.md')).not.toBeInTheDocument()
    expect(screen.getByTestId('snapshot-preview')).toHaveAttribute('data-readonly', 'true')
    expect(screen.getByText('帮我整理这份公开数据')).toBeInTheDocument()
    expect(screen.queryByText('内部提示')).not.toBeInTheDocument()
    expect(screen.getByText(/会剥离的内部角色/)).toBeInTheDocument()
    expect(screen.getByText(/permission/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/摘要/), {
      target: { value: '把一次真实会话变成可复查的教程快照。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交快照审核' }))

    await waitFor(() => expect(api.submitTutorialSnapshot).toHaveBeenCalledTimes(1))
    expect(api.submitTutorialSnapshot).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        sourceSessionId: 'sess-1',
        selectedArtifacts: [],
      }),
    )
    expect(api.mediaSign).not.toHaveBeenCalled()
    expect(onSubmitted).toHaveBeenCalledWith({ strippedRoles: ['system'] })
  })

  it('勾选成果时携带权威源路径供服务端精确改写', async () => {
    render(
      <PublishFromSessionDialog
        open
        onOpenChange={() => {}}
        auth={auth}
        sessionId="sess-1"
        sessionTitle="公开数据分析"
        messages={messages}
        onSubmitted={() => {}}
      />,
    )
    fireEvent.click(await screen.findByLabelText('勾选成果 report.md'))
    fireEvent.change(screen.getByLabelText(/摘要/), {
      target: { value: '把一次真实会话变成可复查的教程快照。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交快照审核' }))
    await waitFor(() => expect(api.submitTutorialSnapshot).toHaveBeenCalledTimes(1))
    expect(api.submitTutorialSnapshot).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        selectedArtifacts: [
          expect.objectContaining({
            name: 'report.md',
            sourcePath: '/home/agent/.openclaude/generated/report.md',
          }),
        ],
      }),
    )
  })

  it('勾选 SVG 或超大文件时前端拦截', async () => {
    render(
      <PublishFromSessionDialog
        open
        onOpenChange={() => {}}
        auth={auth}
        sessionId="sess-1"
        sessionTitle="公开数据分析"
        messages={messages}
        onSubmitted={() => {}}
      />,
    )
    expect(await screen.findByLabelText('勾选成果 chart.svg')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('勾选成果 chart.svg'))
    expect(screen.getByText('SVG 不可作为教程成果发布。')).toBeInTheDocument()
    expect(screen.getByLabelText('勾选成果 chart.svg')).not.toBeChecked()

    fireEvent.click(screen.getByLabelText('勾选成果 huge.png'))
    expect(screen.getByText(/单件成果不能超过/)).toBeInTheDocument()
    expect(screen.getByLabelText('勾选成果 huge.png')).not.toBeChecked()
  })
})
