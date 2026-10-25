/**
 * 对话写博客（经验分享，OCV5-577 跟进）视觉预览：blog_draft / blog_status / blog_published 的真实组件。
 * 卡片的登录态动作用假实现注入（预检结果、审核状态都是预览用的示例）；只依赖 MessageList，
 * 在改造前的树上也能跑（那时这些类型显示为降级文本），用于前后对照。
 */
import { type ReactNode, useEffect } from 'react'
import { type CommunityBlogActions, ChatInteractionContext, ToolCardActionsContext } from '../../src/components/tool/context'
import type { CommunityBlogPrecheck, CommunityTutorialMine } from '../../src/lib/types'
import { conversation, Timeline } from './scenes-iui'
import type { Scene } from './types'

const ui = (v: unknown) => `\n\`\`\`ui\n${JSON.stringify(v)}\n\`\`\`\n`

const BODY = [
  '## 场景',
  '每周一早上要给团队发上周的数据周报。以前手动从三张表里复制数字，要花四十分钟，还经常抄错。',
  '## 怎么做的',
  '1. 在对话里把三张表的导出文件交给助手，让它先写清楚每个指标的口径。',
  '2. 口径确认后，让它生成汇总脚本，并用上周的数据核对一遍。',
  '3. 用定时任务每周一 8:30 自动跑，结果发到我的站内信。',
  '## 踩过的坑',
  '- 口径变了要先改说明再重跑，不要直接改结果。',
  '- 第一次跑之前一定要人工核对一遍。',
].join('\n\n')

const DRAFT = {
  type: 'blog_draft',
  draft_id: 'weekly-report',
  title: '用定时任务做周报：从 40 分钟到 0',
  summary: '记录我把手动周报交给助手和定时任务的过程、口径怎么定，以及两个踩过的坑。',
  category: 'general',
}

const ISSUES: CommunityBlogPrecheck = {
  issues: [
    { code: 'leak_phone', level: 'block', field: 'bodyMarkdown', message: '有手机号，公开内容里不能出现，删掉或打码', where: '第 2 节' },
    { code: 'external_image', level: 'block', field: 'bodyMarkdown', message: '用了站外图片或不支持的图片写法；经验分享只显示本站上传的图片，改用对话里生成的图片或删掉', where: '第 2 节' },
  ],
  quota: { pendingLeft: 3, dailyLeft: 5 },
}
const CLEAN: CommunityBlogPrecheck = { issues: [], quota: { pendingLeft: 3, dailyLeft: 5 } }

function mine(over: Partial<CommunityTutorialMine>): CommunityTutorialMine {
  return {
    id: '12',
    title: DRAFT.title,
    summary: DRAFT.summary,
    category: 'general',
    bodyMarkdown: BODY,
    status: 'pending',
    reviewNote: null,
    createdAt: '2026-10-23T02:42:00Z',
    reviewedAt: null,
    publishedAt: null,
    needsHuman: false,
    readMinutes: 3,
    ...over,
  }
}

function actions(precheck: CommunityBlogPrecheck, item: CommunityTutorialMine): CommunityBlogActions {
  const noop = () => {}
  return {
    precheck: async () => precheck,
    readContainerImage: async () => new Blob(),
    uploadImage: async () => ({ sha256: 'a'.repeat(64) }),
    submit: async () => ({ id: item.id }),
    getMine: async () => item,
    postUrl: (id) => `${window.location.origin}/?panel=help&tab=blog&community=${id}`,
    openPost: noop,
    openMine: noop,
    openEditor: noop,
  }
}

function WithBlog({ value, children }: { value: CommunityBlogActions; children: ReactNode }) {
  return (
    <ToolCardActionsContext.Provider value={{ communityBlog: value }}>
      <ChatInteractionContext.Provider value={{ sendUserText: () => {} }}>{children}</ChatInteractionContext.Provider>
    </ToolCardActionsContext.Provider>
  )
}

/** 预检结果到了之后点一下按钮（截确认浮层）。 */
function ClickWhenReady({ label, children }: { label: string; children: ReactNode }) {
  useEffect(() => {
    const t = setInterval(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label && !b.disabled)
      if (btn) {
        btn.click()
        clearInterval(t)
      }
    }, 50)
    return () => clearInterval(t)
  }, [label])
  return <>{children}</>
}

const VIEWPORTS: ('desktop' | 'mobile')[] = ['mobile', 'desktop']

export const agentBlogScenes: Scene[] = [
  {
    id: 'agent-blog-draft',
    label: '对话写博客 · 草稿卡 + 修改点',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => (
      <WithBlog value={actions(ISSUES, mine({}))}>
        <Timeline
          messages={conversation(
            '把今天配置定时周报的过程写成一篇经验分享。',
            `草稿写好了，按「场景 → 做法 → 踩坑」组织。下面有 2 处需要先改，点「修复」我来改；也可以直接在编辑器里自己改。${ui({ ...DRAFT, version: 1, body: BODY })}`,
          )}
        />
      </WithBlog>
    ),
  },
  {
    id: 'agent-blog-confirm',
    label: '对话写博客 · v2 检查通过 + 确认投稿',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => (
      <WithBlog value={actions(CLEAN, mine({}))}>
        <ClickWhenReady label="确认投稿">
          <Timeline
            messages={conversation(
              '请按以下修改点更新经验分享草稿（draft_id weekly-report，当前 v1），改完给我 v2：\n1. 「怎么做的」一节：有手机号',
              `改好了：删掉了联系方式。确认没问题就可以投稿。${ui({ ...DRAFT, version: 2, body: BODY, note: '删掉了联系方式' })}`,
            )}
          />
        </ClickWhenReady>
      </WithBlog>
    ),
  },
  {
    id: 'agent-blog-status',
    label: '对话写博客 · 审核状态卡',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => (
      <WithBlog value={actions(CLEAN, mine({}))}>
        <Timeline
          messages={conversation(
            '我已确认投稿经验分享（稿件 #12，draft_id weekly-report v2）。',
            `收到。审核结果会显示在下面这张卡上，出结果后站内信也会通知你。${ui({ type: 'blog_status', id: '12' })}`,
          )}
        />
      </WithBlog>
    ),
  },
  {
    id: 'agent-blog-rejected',
    label: '对话写博客 · 未通过卡',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => (
      <WithBlog
        value={actions(
          CLEAN,
          mine({ status: 'rejected', reviewNote: '内容包含站外联系方式、引流或推广信息。删掉联系方式和推广内容、补充具体的使用步骤后，可以重新投稿。' }),
        )}
      >
        <Timeline messages={conversation('审核过了吗？', `这篇没有通过，理由在卡片里。我可以按理由改一版再给你确认。${ui({ type: 'blog_status', id: '12' })}`)} />
      </WithBlog>
    ),
  },
  {
    id: 'agent-blog-published',
    label: '对话写博客 · 发布后链接卡',
    group: '工作区',
    viewports: VIEWPORTS,
    api: {},
    render: () => (
      <WithBlog value={actions(CLEAN, mine({ status: 'approved', publishedAt: '2026-10-23T02:43:00Z', reviewedAt: '2026-10-23T02:43:00Z' }))}>
        <Timeline messages={conversation('审核过了吗？', `已经通过审核并公开了，链接在下面。${ui({ type: 'blog_published', id: '12' })}`)} />
      </WithBlog>
    ),
  },
]
