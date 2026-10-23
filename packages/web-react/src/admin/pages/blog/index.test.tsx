import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/api'
import { adminApi } from '../../../lib/api/admin'
import type { AdminBlogPost } from '../../../lib/types'
import BlogAdminPage from './index'

const post: AdminBlogPost = {
  id: '12',
  title: '把 30 页论文交给 Agent 精读',
  summary: '先抽结构、再按章节追问。',
  category: 'research',
  bodyMarkdown: '直接丢整篇 PDF 得到的总结很空。改成先抽结构、再按章节追问并要求引用页码后，准确率明显提高。',
  status: 'pending',
  reviewNote: null,
  createdAt: '2026-10-20T13:04:00.000Z',
  reviewedAt: null,
  publishedAt: null,
  authorName: '陈博',
  needsHuman: true,
  imageCount: 4,
  bodyChars: 3420,
  editId: null,
  reviewToken: 'p:1',
  moderation: {
    verdict: 'uncertain',
    mode: 'on',
    applied: false,
    categories: {
      violation: { choice: 'no', confidence: 0.98, yes: 0.02 },
      ad: { choice: 'yes', confidence: 0.71, yes: 0.71 },
      leak: { choice: 'no', confidence: 0.96, yes: 0.04 },
      low_quality: { choice: 'no', confidence: 0.91, yes: 0.09 },
    },
    reason: null,
    adminNote: '「广告」判为是，置信度 0.71，未达到自动处理阈值 0.9',
    createdAt: '2026-10-20T13:05:00.000Z',
  },
}

beforeEach(() => {
  vi.spyOn(adminApi, 'adminListBlogPosts').mockResolvedValue({ tutorials: [post], nextCursor: null })
  vi.spyOn(adminApi, 'adminBlogModerationStats').mockResolvedValue({
    mode: 'on',
    vision: true,
    today: { autoApproved: 4, autoRejected: 1, toHuman: 1 },
  })
  vi.spyOn(adminApi, 'adminReviewCommunityTutorial').mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BlogAdminPage', () => {
  it('待人工复核：AI 四维置信度、未自动处理的原因、通过发布', async () => {
    render(<BlogAdminPage />)
    expect(await screen.findByText(post.title)).toBeInTheDocument()
    expect(screen.getByText(/AI 自动审核：开启 · 今日自动通过 4 \/ 自动驳回 1 \/ 转人工 1/)).toBeInTheDocument()
    expect(screen.getByText('71%')).toBeInTheDocument()
    expect(screen.getByText(post.moderation!.adminNote!)).toBeInTheDocument()
    expect(screen.getByText(/4 张图/)).toBeInTheDocument()
    expect(adminApi.adminListBlogPosts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'pending', needsHuman: true }))
    fireEvent.click(screen.getByRole('button', { name: /通过发布/ }))
    await waitFor(() => expect(adminApi.adminReviewCommunityTutorial).toHaveBeenCalledWith(expect.anything(), '12', 'approve', undefined, 'p:1'))
    await waitFor(() => expect(screen.queryByText(post.title)).not.toBeInTheDocument())
  })

  it('驳回必须填理由', async () => {
    render(<BlogAdminPage />)
    await screen.findByText(post.title)
    fireEvent.click(screen.getByRole('button', { name: /驳回…/ }))
    const confirm = screen.getByRole('button', { name: '确认驳回' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('驳回理由'), { target: { value: '请删掉付费工具推广' } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(adminApi.adminReviewCommunityTutorial).toHaveBeenCalledWith(expect.anything(), '12', 'reject', '请删掉付费工具推广', 'p:1'),
    )
  })

  it('已发布帖的修改稿：标「修改稿 · 线上为旧版」，通过按钮是「通过并替换线上」，带回修改稿的 reviewToken', async () => {
    vi.mocked(adminApi.adminListBlogPosts).mockResolvedValue({
      tutorials: [{ ...post, editId: '31', reviewToken: 'r:31', status: 'pending' }],
      nextCursor: null,
    })
    render(<BlogAdminPage />)
    await screen.findByText(post.title)
    expect(screen.getByText(/修改稿 · 线上为旧版/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /通过并替换线上/ }))
    await waitFor(() =>
      expect(adminApi.adminReviewCommunityTutorial).toHaveBeenCalledWith(expect.anything(), '12', 'approve', undefined, 'r:31'),
    )
  })

  it('审核失败（作者中途改过，409）：显示原因并重新加载列表', async () => {
    vi.mocked(adminApi.adminReviewCommunityTutorial).mockRejectedValue(
      new ApiError({ status: 409, message: '作者刚修改过这篇，请刷新后按新内容再审' }),
    )
    render(<BlogAdminPage />)
    await screen.findByText(post.title)
    const loads = vi.mocked(adminApi.adminListBlogPosts).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /通过发布/ }))
    expect(await screen.findByText(/作者刚修改过这篇/)).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(adminApi.adminListBlogPosts).mock.calls.length).toBeGreaterThan(loads))
  })

  it('没有 AI 审核接口（旧后端 404）时隐藏 AI 状态行与审核记录页签', async () => {
    vi.mocked(adminApi.adminBlogModerationStats).mockRejectedValue(new ApiError({ status: 404, message: 'not found' }))
    vi.mocked(adminApi.adminListBlogPosts).mockResolvedValue({ tutorials: [{ ...post, moderation: null }], nextCursor: null })
    render(<BlogAdminPage />)
    await screen.findByText(post.title)
    expect(screen.queryByText(/AI 自动审核/)).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'AI 审核记录' })).not.toBeInTheDocument()
    expect(screen.queryByText('AI 判定（置信度）')).not.toBeInTheDocument()
  })
})
