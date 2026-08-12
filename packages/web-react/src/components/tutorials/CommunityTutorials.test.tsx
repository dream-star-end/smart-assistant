import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type {
  AuthSession,
  CommunityTutorialDetail,
  CommunityTutorialSummary,
} from '../../lib/types'
import { CommunityTutorials } from './CommunityTutorials'

const summary: CommunityTutorialSummary = {
  id: '7',
  title: '把会议纪要变成可执行任务',
  summary: '从公开会议记录提取行动项、负责人和截止日期。',
  category: 'general',
  authorName: '社区作者',
  publishedAt: '2026-08-12T10:00:00.000Z',
}

const detail: CommunityTutorialDetail = {
  ...summary,
  bodyMarkdown:
    '# 操作步骤\n\n先核对来源，再整理行动项。\n\n![追踪图](https://tracker.test/pixel.png)\n\n```htmlpreview\n<script>window.bad = true</script>\n```',
}

const auth = {
  snapshot: () => ({ token: 'token', epoch: 1 }),
  beginIdentity: () => 1,
  commitToken: () => true,
  expire: () => true,
} as AuthSession

beforeEach(() => {
  vi.spyOn(api, 'listCommunityTutorials').mockResolvedValue({
    tutorials: [summary],
    nextCursor: null,
  })
  vi.spyOn(api, 'getCommunityTutorial').mockResolvedValue(detail)
  vi.spyOn(api, 'submitCommunityTutorial').mockResolvedValue({
    id: '8',
    status: 'pending',
    createdAt: '2026-08-12T11:00:00.000Z',
  })
  vi.spyOn(api, 'listMyCommunityTutorials').mockResolvedValue({ tutorials: [], nextCursor: null })
  vi.spyOn(api, 'withdrawCommunityTutorial').mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CommunityTutorials', () => {
  it('匿名用户可分页阅读已审核目录，正文始终以 readOnly Markdown 渲染', async () => {
    render(<CommunityTutorials />)

    expect(await screen.findByText(summary.title)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(summary.title) }))
    await waitFor(() => expect(api.getCommunityTutorial).toHaveBeenCalledWith(summary.id))
    expect(await screen.findByText(/先核对来源，再整理行动项/)).toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(await screen.findByText('[追踪图]')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect((window as unknown as { bad?: boolean }).bad).toBeUndefined()
  })

  it('未登录点击发布教程走现有登录入口，不展示伪表单', async () => {
    const onRequireLogin = vi.fn()
    render(<CommunityTutorials onRequireLogin={onRequireLogin} />)
    await screen.findByText(summary.title)

    fireEvent.click(screen.getByRole('button', { name: '发布教程' }))
    expect(onRequireLogin).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: '发布一份新教程' })).not.toBeInTheDocument()
  })

  it('任意已登录用户都能提交教程并进入我的待审列表', async () => {
    render(<CommunityTutorials auth={auth} />)
    await screen.findByText(summary.title)
    fireEvent.click(screen.getByRole('button', { name: '发布教程' }))

    fireEvent.change(screen.getByLabelText(/标题/), { target: { value: '一份完整的社区教程' } })
    fireEvent.change(screen.getByLabelText(/摘要/), {
      target: { value: '这份教程说明如何准备材料、完成任务并核对结果。' },
    })
    fireEvent.change(screen.getByLabelText(/教程正文/), {
      target: {
        value:
          '# 准备\n\n先固定输入材料。\n\n# 执行\n\n逐步操作并保存结果。\n\n# 验收\n\n核对输出。',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }))

    await waitFor(() => expect(api.submitCommunityTutorial).toHaveBeenCalledTimes(1))
    expect(api.submitCommunityTutorial).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        title: '一份完整的社区教程',
        category: 'general',
      }),
    )
    await waitFor(() => expect(api.listMyCommunityTutorials).toHaveBeenCalledWith(auth, null))
    expect(await screen.findByText('你还没有投稿。')).toBeInTheDocument()
  })
})
