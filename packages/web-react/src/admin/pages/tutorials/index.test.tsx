import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../../lib/api'
import type { CommunityTutorialPending } from '../../../lib/types'
import TutorialReviewPage from './index'

const pending: CommunityTutorialPending = {
  id: '9',
  title: '社区投稿审核样例',
  summary: '管理员核对正文后可以批准上线或说明拒绝理由。',
  category: 'coding',
  bodyMarkdown:
    '# 步骤\n\n先复现问题，再做最小修改，最后运行回归测试。\n\n![追踪图](https://tracker.test/pixel.png)',
  status: 'pending',
  reviewNote: null,
  createdAt: '2026-08-12T10:00:00.000Z',
  reviewedAt: null,
  publishedAt: null,
  authorName: '投稿者',
}

beforeEach(() => {
  vi.spyOn(api, 'adminPendingCommunityTutorials').mockResolvedValue({
    tutorials: [pending],
    nextCursor: null,
  })
  vi.spyOn(api, 'adminReviewCommunityTutorial').mockResolvedValue({ ok: true })
  vi.spyOn(api, 'listTutorialEvalSpecs').mockResolvedValue({ specs: [], nextCursor: null })
  vi.spyOn(api, 'listTutorialEvalJobs').mockResolvedValue({ jobs: [], nextCursor: null })
  vi.spyOn(api, 'listTutorialEvalCompass').mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TutorialReviewPage', () => {
  it('管理员可阅读完整投稿并一键审核通过上线', async () => {
    render(<TutorialReviewPage />)

    expect(await screen.findByRole('heading', { name: pending.title })).toBeInTheDocument()
    expect(screen.getByText(/先复现问题，再做最小修改/)).toBeInTheDocument()
    expect(screen.getByText(/!\[追踪图\]\(https:\/\/tracker\.test\/pixel\.png\)/)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '审核通过并上线' }))

    await waitFor(() =>
      expect(api.adminReviewCommunityTutorial).toHaveBeenCalledWith(
        expect.anything(),
        pending.id,
        'approve',
        undefined,
      ),
    )
    expect(await screen.findByText('教程审核队列已清空')).toBeInTheDocument()
  })

  it('会话快照投稿显示 badge 和清单统计，不当纯 Markdown 审', async () => {
    vi.mocked(api.adminPendingCommunityTutorials).mockResolvedValue({
      tutorials: [
        {
          ...pending,
          id: 'snap-pending',
          title: '快照待审',
          kind: 'snapshot',
          snapshot: { messageCount: 12, pages: [{ sha256: 'p1' }, { sha256: 'p2' }] },
          artifacts: [{ sha256: 'a1', name: 'out.png', mime: 'image/png', bytes: 8 }],
        },
      ],
      nextCursor: null,
    })
    render(<TutorialReviewPage />)
    expect(await screen.findByText('会话快照')).toBeInTheDocument()
    expect(screen.getByText(/清单 12 条消息 · 2 页 · 1 件成果/)).toBeInTheDocument()
  })

  it('拒绝必须先填写审核意见，并将理由提交给后端', async () => {
    render(<TutorialReviewPage />)
    await screen.findByRole('heading', { name: pending.title })
    const reject = screen.getByRole('button', { name: '拒绝' })
    expect(reject).toBeDisabled()

    fireEvent.change(screen.getByLabelText('审核意见'), { target: { value: '请补充回归测试输出' } })
    expect(reject).toBeEnabled()
    fireEvent.click(reject)

    await waitFor(() =>
      expect(api.adminReviewCommunityTutorial).toHaveBeenCalledWith(
        expect.anything(),
        pending.id,
        'reject',
        '请补充回归测试输出',
      ),
    )
  })
})
