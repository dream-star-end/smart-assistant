/**
 * 经验分享（OCV5-577）视觉场景：列表 / 详情 / 编辑器（分栏、手机编辑与预览）/ 我的投稿 / 管理端。
 * 与设计稿 design/after/ 逐张对照用：OC_UI_SCENES=blog OC_UI_SHOT_DELAY=1500 npm run preview:shots。
 *
 * - 面板走真实 TutorialCenter（browseView=blog），`api.*` 走 api-stub 场景表。
 * - 封面与正文图片：shoot.mjs 把 /api/tutorial-embeds/<sha> 映射到 fixtures/blog-<sha 前 8 位>.jpg；
 *   作者预览（Bearer 读图）的桩从同一路径取字节。
 * - 管理端只渲染页面本体（不含管理后台外壳），adminApi 在场景挂载时就地替换。
 */
import { type ReactNode, useEffect, useState } from 'react'
import BlogAdminPage from '../../src/admin/pages/blog/index'
import { TutorialCenter, type TutorialBrowseView } from '../../src/components/TutorialCenter'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import { adminApi } from '../../src/lib/api/admin'
import type { AdminBlogPost, CommunityTutorialMine, CommunityTutorialSummary } from '../../src/lib/types'
import type { ApiMockTable, Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'blog-preview-token')
const PLANET = `c0ffee00${'0'.repeat(56)}`
const HOUR = 3_600_000

const posts: CommunityTutorialSummary[] = [
  { id: '1', title: '用 Muse 一次做完 6 张产品宣传图：提示词结构和返工经验', summary: '从一句模糊需求到可交付的电商主图，我是怎么拆提示词、怎么让模型保持同一套视觉风格的，附 3 次失败的原因。', category: 'general', authorName: '林小舟', publishedAt: '2026-10-21T10:00:00+08:00', readMinutes: 6, coverSha: PLANET, kind: 'markdown' },
  { id: '2', title: '把 30 页论文交给 Agent 精读：先给目录，再逐节追问', summary: '直接丢整篇 PDF 得到的总结很空。改成先抽结构、再按章节追问并要求引用页码后，准确率明显提高。', category: 'research', authorName: '陈博', publishedAt: '2026-10-20T10:00:00+08:00', readMinutes: 8, coverSha: null, kind: 'markdown' },
  { id: '3', title: '项目工作区 + 定时任务：每天 9 点自动生成销售日报', summary: '用项目记住数据源和口径，定时任务每天跑一次，结果发到站内信。配置不到 10 分钟。', category: 'general', authorName: '周周', publishedAt: '2026-10-19T10:00:00+08:00', readMinutes: 5, coverSha: null, kind: 'markdown' },
  { id: '4', title: '从对话到可部署网页：我踩过的 5 个坑', summary: '包括静态资源路径、移动端适配、表单提交跨域，以及怎么让 AI 自己发现问题。', category: 'coding', authorName: 'Kevin', publishedAt: '2026-10-18T10:00:00+08:00', readMinutes: 7, coverSha: null, kind: 'markdown' },
  { id: '5', title: '让 AI 帮你复现论文图表：数据准备清单', summary: '列清楚列名、单位和缺失值处理，比反复改提示词有效得多。', category: 'research', authorName: '陈博', publishedAt: '2026-10-17T10:00:00+08:00', readMinutes: 4, coverSha: null, kind: 'markdown' },
  { id: '6', title: '手机上用分屏预览改 HTML 页面，效率翻倍', summary: '通勤时也能改落地页：预览、批注、让模型按截图修改，一气呵成。', category: 'coding', authorName: '安然', publishedAt: '2026-10-16T10:00:00+08:00', readMinutes: 3, coverSha: null, kind: 'markdown' },
]

const BODY = [
  '上周要给新品做一组宣传图：主图、细节图、场景图各两张，要求风格统一。第一次我直接说「帮我做 6 张好看的产品图」，结果 6 张风格完全不一样。下面是我后来稳定下来的做法。',
  '',
  '## 1. 先让它写「视觉说明」，再出图',
  '',
  '不要一上来就出图。先让 Agent 根据产品资料写一份视觉说明：主色、光线、构图、禁用元素，确认后再出图，并要求**每张图都引用这份说明**。',
  '',
  `![图 1：视觉说明确认后，第一批出图的对比](tutorial-blob:${PLANET})`,
  '',
  '```',
  '请先输出视觉说明（不要出图）：',
  '- 主色 / 辅色（给色值）',
  '- 光线与背景',
  '- 每张图的构图与用途',
  '- 禁止出现的元素',
  '```',
  '',
  '> 经验：返工时只改说明里的一条，再让它「按新说明重出第 3 张」，比口头描述修改准确得多。',
  '',
  '## 2. 失败的三次，原因各不相同',
  '',
  '1. 没给尺寸，导致主图比例不对；',
  '2. 一次要 6 张，后几张开始跑偏；',
  '3. 文字直接画进图里，中文出现错字。',
].join('\n')

// harness 把 window.fetch 整个桩成 204;作者预览读图的字节改用 XHR 取(同样走 shoot.mjs 的 fixture 路由)。
function fixtureBlob(sha: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', `/api/tutorial-embeds/${sha}`)
    xhr.responseType = 'blob'
    xhr.onload = () => resolve(xhr.response as Blob)
    xhr.onerror = () => reject(new Error('fixture image failed'))
    xhr.send()
  })
}

const now = Date.now()
const mine: CommunityTutorialMine[] = [
  { id: '21', title: '用 Muse 一次做完 6 张产品宣传图：提示词结构和返工经验', summary: '…', category: 'general', bodyMarkdown: BODY, status: 'pending', needsHuman: false, coverSha: PLANET, reviewNote: null, createdAt: new Date(now - 0.1 * HOUR).toISOString(), reviewedAt: null, publishedAt: null, kind: 'markdown' },
  { id: '3', title: '项目工作区 + 定时任务：每天 9 点自动生成销售日报', summary: '…', category: 'general', bodyMarkdown: '正文', status: 'approved', needsHuman: false, viewCount: 128, coverSha: null, reviewNote: null, createdAt: '2026-10-19T09:00:00+08:00', reviewedAt: '2026-10-19T09:01:00+08:00', publishedAt: '2026-10-19T09:01:00+08:00', kind: 'markdown' },
  { id: '17', title: '加我微信领取 100 个提示词模板', summary: '…', category: 'research', bodyMarkdown: '正文', status: 'rejected', reviewSource: 'ai', coverSha: null, reviewNote: '内容包含站外联系方式和引流信息。删掉联系方式、补充具体的使用步骤后，可以重新投稿。', createdAt: '2026-10-18T09:00:00+08:00', reviewedAt: '2026-10-18T09:01:00+08:00', publishedAt: null, kind: 'markdown' },
  { id: '2', title: '把 30 页论文交给 Agent 精读：先给目录，再逐节追问', summary: '…', category: 'research', bodyMarkdown: '正文', status: 'pending', needsHuman: true, coverSha: null, reviewNote: null, createdAt: '2026-10-20T21:04:00+08:00', reviewedAt: null, publishedAt: null, kind: 'markdown' },
]

const blogApi: ApiMockTable = {
  getPublicConfig: async () => ({
    turnstileSiteKey: '',
    turnstileBypass: true,
    requireEmailVerified: false,
    featureRemoteSsh: false,
    featureImage2: false,
    allowRegistration: true,
    featureCommunityBlog: true,
    featureCommunityBlogAiReview: true,
  }),
  listCommunityTutorials: async (opts?: { limit?: number }) => ({
    tutorials: opts?.limit ? posts.slice(0, opts.limit) : posts,
    nextCursor: null,
    total: posts.length,
  }),
  getCommunityTutorial: async () => ({ ...posts[0]!, bodyMarkdown: BODY }),
  listMyCommunityTutorials: async () => ({ tutorials: mine, nextCursor: null }),
  fetchTutorialImage: async (_auth: unknown, sha: string) => fixtureBlob(sha),
}

// 修改已投稿（OCV5-577 跟进）：已发布帖的修改在审 / 没通过。
const EDIT_BODY = BODY.split('\n```')[0]!.trim()
const mineEdits: CommunityTutorialMine[] = [
  {
    ...mine[1]!,
    id: '3',
    bodyMarkdown: EDIT_BODY,
    summary: '用项目记住数据源和口径，定时任务每天跑一次，结果发到站内信。',
    edit: {
      id: '41',
      status: 'pending',
      needsHuman: false,
      reviewNote: null,
      title: '项目工作区 + 定时任务：每天 9 点自动生成销售日报（补充口径变更）',
      summary: '用项目记住数据源和口径，定时任务每天跑一次，结果发到站内信。',
      category: 'general',
      bodyMarkdown: EDIT_BODY,
      createdAt: new Date(now - 0.05 * HOUR).toISOString(),
      reviewedAt: null,
    },
  },
  {
    ...mine[1]!,
    id: '8',
    title: '把会议纪要交给 Agent 整理成待办：三步模板',
    viewCount: 46,
    coverSha: PLANET,
    edit: {
      id: '39',
      status: 'rejected',
      needsHuman: false,
      reviewNote: '新增的「工具推荐」一节包含站外购买链接和优惠码。删掉推广内容后可以再提交修改。',
      title: '把会议纪要交给 Agent 整理成待办：三步模板',
      summary: '…',
      category: 'general',
      bodyMarkdown: EDIT_BODY,
      createdAt: '2026-10-22T20:00:00+08:00',
      reviewedAt: '2026-10-22T20:01:00+08:00',
    },
  },
  mine[0]!,
  mine[2]!,
]

const blogEditApi: ApiMockTable = { ...blogApi, listMyCommunityTutorials: async () => ({ tutorials: mineEdits, nextCursor: null }) }

function BlogHost({ communityId = null, children }: { communityId?: string | null; children?: ReactNode }) {
  const [view, setView] = useState<TutorialBrowseView>('blog')
  const [community, setCommunity] = useState<string | null>(communityId)
  return (
    <>
      <TutorialCenter
        open
        topicId={null}
        communityId={community}
        browseView={view}
        onBrowseViewChange={setView}
        onTopicChange={() => {}}
        onCommunityChange={setCommunity}
        onClose={() => {}}
        actionState={() => ({ enabled: true, label: '试试' })}
        onRunAction={() => {}}
        auth={auth}
      />
      {children}
    </>
  )
}

/** 挂载后按顺序点击文字匹配的按钮（编辑器、我的投稿是组件内部状态，只能点进去）。 */
function Click({ labels, after }: { labels: string[]; after?: () => void }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时按顺序点一次
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const label of labels) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (cancelled) return
        const target = [...document.querySelectorAll<HTMLElement>('button,[role=tab]')].find(
          (el) => el.textContent?.trim().includes(label),
        )
        target?.click()
      }
      after?.()
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return null
}

function seedDraft() {
  window.localStorage.setItem(
    'oc:blog-draft',
    JSON.stringify({
      title: '用 Muse 一次做完 6 张产品宣传图：提示词结构和返工经验',
      summary: '从一句模糊需求到可交付的电商主图，我是怎么拆提示词、怎么让模型保持同一套视觉风格的。',
      category: 'general',
      bodyMarkdown: BODY.split('\n```')[0]!.trim(),
      savedAt: new Date('2026-10-22T18:21:00+08:00').getTime(),
    }),
  )
}

const adminPosts: AdminBlogPost[] = [
  {
    id: '12',
    title: '把 30 页论文交给 Agent 精读：先给目录，再逐节追问',
    summary: '…',
    category: 'research',
    bodyMarkdown: '直接丢整篇 PDF 得到的总结很空。改成先抽结构、再按章节追问并要求引用页码后……',
    status: 'pending',
    reviewNote: null,
    createdAt: '2026-10-20T21:04:00+08:00',
    reviewedAt: null,
    publishedAt: null,
    authorName: '陈博',
    needsHuman: true,
    imageCount: 4,
    bodyChars: 3420,
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
      adminNote: '「广告」判为是，置信度 0.71，未达到自动处理阈值 0.9；文中提到某付费 PDF 工具，可能是推广。',
      createdAt: '2026-10-20T21:05:00+08:00',
    },
  },
]

const adminEditPosts: AdminBlogPost[] = [
  {
    ...adminPosts[0]!,
    id: '3',
    title: '项目工作区 + 定时任务：每天 9 点自动生成销售日报（补充口径变更）',
    category: 'general',
    bodyMarkdown: '用项目记住数据源和口径，定时任务每天跑一次。第二周加了一张表，口径说明里同步写清楚了新增字段……',
    publishedAt: '2026-10-19T09:01:00+08:00',
    createdAt: '2026-10-23T18:40:00+08:00',
    authorName: '周周',
    imageCount: 1,
    bodyChars: 2180,
    editId: '41',
    reviewToken: 'r:41',
    moderation: {
      ...adminPosts[0]!.moderation!,
      categories: {
        violation: { choice: 'no', confidence: 0.98, yes: 0.02 },
        ad: { choice: 'no', confidence: 0.85, yes: 0.15 },
        leak: { choice: 'no', confidence: 0.97, yes: 0.03 },
        low_quality: { choice: 'no', confidence: 0.97, yes: 0.03 },
      },
      adminNote: '「广告」判为否，置信度 0.85，未达到自动处理阈值 0.9',
    },
  },
  ...adminPosts,
]

function AdminHost({ posts = adminPosts }: { posts?: AdminBlogPost[] }) {
  Object.assign(adminApi, {
    adminListBlogPosts: async () => ({ tutorials: posts, nextCursor: null }),
    adminBlogModerationStats: async () => ({ mode: 'on', vision: true, today: { autoApproved: 4, autoRejected: 1, toHuman: 1 } }),
    adminBlogModerations: async () => ({ moderations: [], nextCursor: null }),
  })
  return (
    <div className="min-h-screen bg-bg p-7">
      <BlogAdminPage />
    </div>
  )
}

const both: Scene['viewports'] = ['desktop', 'mobile']

export const blogScenes: Scene[] = [
  { id: 'blog-1-list', label: '经验分享 · 列表', group: '工作区', viewports: both, api: blogApi, render: () => <BlogHost /> },
  { id: 'blog-2-detail', label: '经验分享 · 详情', group: '工作区', viewports: both, api: blogApi, render: () => <BlogHost communityId="1" /> },
  {
    id: 'blog-3-editor',
    label: '经验分享 · 编辑器',
    group: '工作区',
    viewports: both,
    api: blogApi,
    render: () => {
      seedDraft()
      return (
        <BlogHost>
          <Click labels={['写一篇经验']} />
        </BlogHost>
      )
    },
  },
  {
    id: 'blog-3b-editor-preview',
    label: '经验分享 · 编辑器（手机预览）',
    group: '工作区',
    viewports: ['mobile'],
    api: blogApi,
    render: () => {
      seedDraft()
      return (
        <BlogHost>
          <Click labels={['写一篇经验', '预览']} />
        </BlogHost>
      )
    },
  },
  {
    id: 'blog-4-mine',
    label: '经验分享 · 我的投稿',
    group: '工作区',
    viewports: both,
    api: blogApi,
    render: () => (
      <BlogHost>
        <Click labels={['我的投稿']} />
      </BlogHost>
    ),
  },
  { id: 'blog-5-admin', label: '经验分享 · 管理端', group: '管理中心', viewports: ['desktop'], api: blogApi, render: () => <AdminHost /> },
  {
    id: 'blog-6-mine-edits',
    label: '经验分享 · 我的投稿（修改在审 / 修改未通过）',
    group: '工作区',
    viewports: both,
    api: blogEditApi,
    render: () => (
      <BlogHost>
        <Click labels={['我的投稿']} />
      </BlogHost>
    ),
  },
  {
    id: 'blog-7-edit-published',
    label: '经验分享 · 修改已发布的帖子',
    group: '工作区',
    viewports: both,
    api: blogEditApi,
    render: () => {
      window.localStorage.removeItem('oc:blog-edit:3')
      return (
        <BlogHost>
          <Click labels={['我的投稿', '修改']} />
        </BlogHost>
      )
    },
  },
  {
    id: 'blog-8-withdraw-published',
    label: '经验分享 · 撤回已发布的帖子',
    group: '工作区',
    viewports: both,
    api: blogEditApi,
    render: () => (
      <BlogHost>
        <Click labels={['我的投稿', '撤回']} />
      </BlogHost>
    ),
  },
  {
    id: 'blog-9-admin-edit',
    label: '经验分享 · 管理端（修改稿待复核）',
    group: '管理中心',
    viewports: ['desktop'],
    api: blogApi,
    render: () => <AdminHost posts={adminEditPosts} />,
  },
]
