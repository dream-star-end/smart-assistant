import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adminApi } from '../../../lib/api/admin'
import type { CommunityTutorialPending } from '../../../lib/types'
import TutorialReviewPage from './index'
import { prefetchMarkdownImpl } from '../../../components/Markdown'
import { loadBeforeAll } from '../../../test/moduleLoad'

// 断言渲染后的 Markdown 正文要等懒加载的 MarkdownImpl;先在用例窗口外取好(src/test/moduleLoad.ts)。
loadBeforeAll(prefetchMarkdownImpl)

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
  reviewToken: 'p:1',
}

beforeEach(() => {
  vi.spyOn(adminApi, 'adminPendingCommunityTutorials').mockResolvedValue({
    tutorials: [pending],
    nextCursor: null,
  })
  vi.spyOn(adminApi, 'adminReviewCommunityTutorial').mockResolvedValue({ ok: true })
  vi.spyOn(adminApi, 'listTutorialEvalSpecs').mockResolvedValue({ specs: [], nextCursor: null })
  vi.spyOn(adminApi, 'listTutorialEvalJobs').mockResolvedValue({ jobs: [], nextCursor: null })
  vi.spyOn(adminApi, 'listTutorialEvalCompass').mockResolvedValue({ items: [], nextCursor: null })
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
    // 投稿里的外链图不加载(blockImages):富文本渲染里只剩「[追踪图]」字样、没有 <img>。此前断言的是
    // 原始 Markdown 源码,只在懒加载占位里出现,图片拦截其实没被测到(OCV5-373 follow-up)。
    expect(screen.getByText('[追踪图]')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '审核通过并上线' }))

    await waitFor(() =>
      expect(adminApi.adminReviewCommunityTutorial).toHaveBeenCalledWith(
        expect.anything(),
        pending.id,
        'approve',
        undefined,
        'p:1',
      ),
    )
    expect(await screen.findByText('教程审核队列已清空')).toBeInTheDocument()
  })

  it('会话快照投稿显示 badge 和清单统计，不当纯 Markdown 审', async () => {
    vi.mocked(adminApi.adminPendingCommunityTutorials).mockResolvedValue({
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
      expect(adminApi.adminReviewCommunityTutorial).toHaveBeenCalledWith(
        expect.anything(),
        pending.id,
        'reject',
        '请补充回归测试输出',
        'p:1',
      ),
    )
  })
})
