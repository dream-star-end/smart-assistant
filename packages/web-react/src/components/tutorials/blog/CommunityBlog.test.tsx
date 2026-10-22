import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../../lib/api'
import type { AuthSession, CommunityTutorialMine, CommunityTutorialSummary } from '../../../lib/types'
import { prefetchMarkdownImpl } from '../../Markdown'
import { loadBeforeAll } from '../../../test/moduleLoad'
import { CommunityBlog } from './CommunityBlog'

loadBeforeAll(prefetchMarkdownImpl)

const SHA = 'b'.repeat(64)

const post = (id: string, extra: Partial<CommunityTutorialSummary> = {}): CommunityTutorialSummary => ({
  id,
  title: `经验 ${id}`,
  summary: '先写视觉说明再出图，返工时只改说明里的一条。',
  category: 'general',
  authorName: '林小舟',
  publishedAt: '2026-10-21T10:00:00.000Z',
  kind: 'markdown',
  readMinutes: 6,
  coverSha: null,
  ...extra,
})

const auth = {
  snapshot: () => ({ token: 'token', epoch: 1 }),
  beginIdentity: () => 1,
  commitToken: () => true,
  expire: () => true,
} as AuthSession

const mine = (extra: Partial<CommunityTutorialMine>): CommunityTutorialMine => ({
  id: '21',
  title: '用 Muse 做宣传图',
  summary: '摘要摘要摘要摘要摘要',
  category: 'general',
  bodyMarkdown: '正文',
  status: 'pending',
  reviewNote: null,
  createdAt: new Date().toISOString(),
  reviewedAt: null,
  publishedAt: null,
  kind: 'markdown',
  ...extra,
})

beforeEach(() => {
  vi.spyOn(api, 'getPublicConfig').mockResolvedValue({
    turnstileSiteKey: '',
    turnstileBypass: true,
    requireEmailVerified: false,
    featureRemoteSsh: false,
    featureImage2: false,
    allowRegistration: true,
    featureCommunityBlog: true,
    featureCommunityBlogAiReview: true,
  })
  vi.spyOn(api, 'listCommunityTutorials').mockResolvedValue({
    tutorials: [post('1', { coverSha: SHA }), post('2'), post('3', { category: 'coding' })],
    nextCursor: null,
    total: 6,
  })
  vi.spyOn(api, 'listMyCommunityTutorials').mockResolvedValue({ tutorials: [mine({})], nextCursor: null })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.querySelector('meta[name="robots"]')?.remove()
})

describe('经验分享', () => {
  it('列表：只拉 markdown，显示总篇数、本周精选、待处理投稿数；未登录写一篇要求登录', async () => {
    const onRequireLogin = vi.fn()
    render(<CommunityBlog onRequireLogin={onRequireLogin} />)
    expect(await screen.findByText('经验 1')).toBeInTheDocument()
    expect(api.listCommunityTutorials).toHaveBeenCalledWith(expect.objectContaining({ kind: 'markdown' }))
    expect(screen.getByText(/已发布 6 篇/)).toBeInTheDocument()
    expect(screen.getByText('本周精选')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /写一篇经验/ }))
    expect(onRequireLogin).toHaveBeenCalled()
  })

  it('分类胶囊切换会带 category 重新查询', async () => {
    render(<CommunityBlog auth={auth} />)
    await screen.findByText('经验 1')
    expect(await screen.findByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编码' }))
    await waitFor(() =>
      expect(api.listCommunityTutorials).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'coding' })),
    )
  })

  it('详情：阅读版式、只渲染本站图片、打开期间 noindex', async () => {
    vi.spyOn(api, 'getCommunityTutorial').mockResolvedValue({
      ...post('9'),
      bodyMarkdown: `## 小标题\n\n正文第一段。\n\n![配置截图](tutorial-blob:${SHA})\n\n![外链](https://tracker.test/x.png)`,
    })
    const { unmount } = render(<CommunityBlog detailId="9" onDetailIdChange={() => {}} />)
    expect(await screen.findByRole('heading', { name: '经验 9' })).toBeInTheDocument()
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex')
    await screen.findByText('小标题')
    expect(screen.getByText('配置截图')).toBeInTheDocument()
    expect(screen.getByText('[外链]')).toBeInTheDocument()
    expect(document.querySelector('img[src*="tracker.test"]')).toBeNull()
    expect(screen.getByText(/本文已通过内容审核/)).toBeInTheDocument()
    unmount()
    expect(document.querySelector('meta[name="robots"]')).toBeNull()
  })

  it('我的投稿：AI 审核中显示分步进度，未通过显示理由与复制为新稿，人工复核中有说明', async () => {
    vi.mocked(api.listMyCommunityTutorials).mockResolvedValue({
      tutorials: [
        mine({ id: '1', needsHuman: false }),
        mine({ id: '2', title: '加我微信领模板', status: 'rejected', reviewNote: '内容包含站外联系方式。', reviewedAt: '2026-10-18T10:00:00.000Z' }),
        mine({ id: '3', title: '论文精读', needsHuman: true }),
        mine({ id: '4', title: '日报', status: 'approved', publishedAt: '2026-10-19T10:00:00.000Z', viewCount: 128 }),
      ],
      nextCursor: null,
    })
    render(<CommunityBlog auth={auth} />)
    await screen.findByText('经验 1')
    fireEvent.click(screen.getByRole('button', { name: /我的投稿/ }))
    expect(await screen.findByText('AI 审核中')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '审核进度' })).toHaveTextContent('已提交安全扫描内容审核发布')
    expect(screen.getByText('内容包含站外联系方式。')).toBeInTheDocument()
    expect(screen.getByText(/已转给管理员复核/)).toBeInTheDocument()
    expect(screen.getByText(/已被阅读 128 次/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制为新稿' }))
    expect(await screen.findByLabelText('标题')).toHaveValue('加我微信领模板')
    expect(screen.getByText(/提交后由 AI 自动审核/)).toBeInTheDocument()
  })

  it('编辑器：没填够不提交，填好后提交并进入我的投稿', async () => {
    window.localStorage.removeItem('oc:blog-draft')
    const submit = vi.spyOn(api, 'submitCommunityTutorial').mockResolvedValue({
      id: '30',
      status: 'pending',
      createdAt: '2026-10-22T10:00:00.000Z',
    })
    render(<CommunityBlog auth={auth} />)
    await screen.findByText('经验 1')
    fireEvent.click(screen.getByRole('button', { name: /写一篇经验/ }))
    fireEvent.click(await screen.findByRole('button', { name: /提交发布/ }))
    expect(await screen.findByText('标题至少 4 个字')).toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '定时任务做日报' } })
    fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '记录配置步骤和踩过的坑。' } })
    fireEvent.change(screen.getByLabelText('正文（Markdown）'), {
      target: { value: '## 做法\n\n先准备数据源，再写清楚口径，最后让定时任务每天自动跑一次，跑完核对三天的数据都对得上。' },
    })
    expect(screen.getByRole('heading', { name: '定时任务做日报' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /提交发布/ }))
    await waitFor(() => expect(submit).toHaveBeenCalled())
    expect(await screen.findByRole('heading', { name: '我的投稿' })).toBeInTheDocument()
  })
})
