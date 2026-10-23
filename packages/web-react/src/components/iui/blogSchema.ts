/**
 * Intelligent UI —— 「经验分享」对话写博客的组件 schema（OCV5-577 跟进）。
 *
 * 按需加载规则（OCV5-393）：这些类型不在通用协议里，定义在基线技能 blog-writer 的
 * `references/ui-blog.md`，Agent 要起草经验分享时才读。
 *
 * - blog_draft：Agent 写的草稿（纯数据）。投稿由用户在卡片上点「确认投稿」、浏览器用用户自己的
 *   登录态完成，Agent 没有发布能力。
 * - blog_status / blog_published：只带稿件 id，状态、理由和链接都由前端按 id 向服务端现查，
 *   Agent 写什么都改变不了卡片显示。
 */

type Ctx = { notes: string[]; partial: boolean }
type Sub = { subtitle?: string }

export type BlogCategory = 'research' | 'coding' | 'general'

export const BLOG_DRAFT_LIMITS = { title: 200, summary: 600, body: 60_000, note: 300 } as const

export type BlogDraftSpec = Sub & {
  type: 'blog_draft'
  /** 同一篇草稿的多个版本共用一个 id；版本号递增。 */
  draftId: string
  version: number
  title: string
  summary: string
  category: BlogCategory
  /** Markdown 正文；图片写容器里的文件路径 `![说明](/abs/path.png)`，投稿时上传并换成本站图片。 */
  body: string
  /** Agent 对这一版改了什么的一句话说明。 */
  note?: string
}

export type BlogStatusSpec = Sub & { type: 'blog_status'; id: string }
export type BlogPublishedSpec = Sub & { type: 'blog_published'; id: string }

export type BlogSpec = BlogDraftSpec | BlogStatusSpec | BlogPublishedSpec

const CATEGORY_ALIASES: Record<string, BlogCategory> = {
  research: 'research',
  研究: 'research',
  调研: 'research',
  coding: 'coding',
  code: 'coding',
  编程: 'coding',
  开发: 'coding',
  general: 'general',
  通用: 'general',
  其他: 'general',
}

function line(v: unknown, max: number, ctx: Ctx, what: string): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  if (t.length <= max) return t
  ctx.notes.push(`${what}过长已截断`)
  return t.slice(0, max)
}

function draftId(v: unknown, title: string): string {
  if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v.trim())) return v.trim()
  // 没给 id：按标题算一个稳定值，同一标题的各版本仍能对上。
  let h = 0
  for (const ch of title) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) | 0
  return `t${(h >>> 0).toString(36)}`
}

function postId(v: unknown): string | undefined {
  const t = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v.trim().replace(/^#/, '') : ''
  return /^[1-9]\d{0,18}$/.test(t) ? t : undefined
}

export function blogDraft(raw: Record<string, unknown>, ctx: Ctx): BlogDraftSpec | null {
  const title = line(raw.title, BLOG_DRAFT_LIMITS.title, ctx, '标题')
  const rawBody = typeof raw.body === 'string' ? raw.body : typeof raw.bodyMarkdown === 'string' ? raw.bodyMarkdown : typeof raw.markdown === 'string' ? raw.markdown : ''
  const bodyText = rawBody.replace(/\r\n?/g, '\n').trim()
  if (!title || !bodyText) return null
  let body = bodyText
  if (body.length > BLOG_DRAFT_LIMITS.body) {
    ctx.notes.push('正文过长已截断')
    body = body.slice(0, BLOG_DRAFT_LIMITS.body)
  }
  const version = typeof raw.version === 'number' ? raw.version : Number(raw.version)
  const category = typeof raw.category === 'string' ? CATEGORY_ALIASES[raw.category.trim().toLowerCase()] : undefined
  const note = line(raw.note ?? raw.changes, BLOG_DRAFT_LIMITS.note, ctx, '说明')
  return {
    type: 'blog_draft',
    draftId: draftId(raw.draft_id ?? raw.draftId, title),
    version: Number.isInteger(version) && version >= 1 && version <= 999 ? version : 1,
    title,
    summary: line(raw.summary, BLOG_DRAFT_LIMITS.summary, ctx, '摘要') ?? '',
    category: category ?? 'general',
    body,
    ...(note ? { note } : {}),
  }
}

export function blogStatus(raw: Record<string, unknown>): BlogStatusSpec | null {
  const id = postId(raw.id ?? raw.post_id ?? raw.postId)
  return id ? { type: 'blog_status', id } : null
}

export function blogPublished(raw: Record<string, unknown>): BlogPublishedSpec | null {
  const id = postId(raw.id ?? raw.post_id ?? raw.postId)
  return id ? { type: 'blog_published', id } : null
}

export const BLOG_VALIDATORS = {
  blog_draft: blogDraft,
  blog_status: blogStatus,
  blog_published: blogPublished,
} as const

/** 只收不会和通用组件撞名的别名。 */
export const BLOG_ALIASES: Record<string, keyof typeof BLOG_VALIDATORS> = {
  blog_post_draft: 'blog_draft',
  community_blog_draft: 'blog_draft',
  blog_review: 'blog_status',
  blog_link: 'blog_published',
}

// ── 草稿里的图片 ───────────────────────────────────────────────────────

export type DraftImage = { alt: string; src: string; index: number }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const IMAGE_RE = /!\[([^\]\n]{0,300})\]\(\s*<?([^)\s>]{1,1024})>?(?:\s+"[^"\n]{0,300}")?\s*\)/g

/** 逐行跳过围栏代码块，对其余行调用 fn（返回替换后的行）。 */
function mapOutsideFences(markdown: string, fn: (line: string) => string): string {
  let fence: string | null = null
  return markdown
    .split('\n')
    .map((l) => {
      const open = FENCE_RE.exec(l)
      if (fence) {
        if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && l.trim() === open[1]) fence = null
        return l
      }
      if (open) {
        fence = open[1]!
        return l
      }
      return fn(l)
    })
    .join('\n')
}

function isContainerFile(src: string): boolean {
  return src.startsWith('/') && !src.startsWith('//') && !src.startsWith('/api/')
}

/** 正文里引用容器文件的图片（按首次出现去重，围栏代码里的不算）。 */
export function draftImages(body: string): DraftImage[] {
  const out: DraftImage[] = []
  mapOutsideFences(body, (l) => {
    for (const m of l.matchAll(IMAGE_RE)) {
      const src = m[2]!
      if (isContainerFile(src) && !out.some((i) => i.src === src)) out.push({ alt: m[1]!.trim(), src, index: out.length })
    }
    return l
  })
  return out
}

/** 预览 / 预检用的占位 sha：第 i 张图 → 64 位十六进制，保证和真实 sha 不冲突的格式一致。 */
export function placeholderSha(index: number): string {
  return `f${index.toString(16).padStart(63, '0')}`
}

/** 把容器文件图片换成 `tutorial-blob:<sha>`；shaOf 返回 undefined 的保持原样。 */
export function replaceDraftImages(body: string, shaOf: (src: string) => string | undefined): string {
  return mapOutsideFences(body, (l) =>
    l.replace(IMAGE_RE, (whole, alt: string, src: string) => {
      if (!isContainerFile(src)) return whole
      const sha = shaOf(src)
      return sha ? `![${alt}](tutorial-blob:${sha})` : whole
    }),
  )
}

/** 给预检的正文：容器图片按出现顺序换成占位 sha（服务端只检查写法和张数）。 */
export function bodyForPrecheck(body: string): string {
  const images = draftImages(body)
  return replaceDraftImages(body, (src) => {
    const hit = images.find((i) => i.src === src)
    return hit ? placeholderSha(hit.index) : undefined
  })
}
