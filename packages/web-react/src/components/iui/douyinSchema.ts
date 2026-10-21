/**
 * Intelligent UI —— 抖音插件专属组件的 schema（OCV5-553）。
 *
 * 按需加载规则（OCV5-393）：这些类型的定义**不在**通用协议里，只在 app-connectors 技能的
 * `references/ui-douyin.md` 里；模型加载抖音插件、要展示结果时才读它。
 *
 * 字段名直接沿用 `oc-plugin call douyin my_videos / video_comments` 结果里的名字（awemeId、createTime、
 * playCount、diggCount …），模型照抄即可，不用改写。
 * 规则同 biliSchema.ts：能修就修（丢非法行、数字字符串转数字、丢掉不是抖音图床的封面），修过的记进 notes；
 * 修不了才降级。作品链接只接受 https://www.douyin.com/…；不合格时用作品 ID 重新拼（ID 已按纯数字校验）。
 */

type Ctx = { notes: string[]; partial: boolean }
type Sub = { subtitle?: string }

export const DOUYIN_LIMITS = {
  videos: 20,
  comments: 20,
  commentText: 1_000,
} as const

export type DouyinVideoItem = {
  awemeId: string
  url: string
  title?: string
  desc?: string
  /** Unix 秒。 */
  createTime?: number
  durationSec?: number
  cover?: string
  playCount?: number
  diggCount?: number
  commentCount?: number
  shareCount?: number
  collectCount?: number
  isPrivate?: boolean
  inReview?: boolean
  isImagePost?: boolean
}
export type DouyinVideosSpec = Sub & {
  type: 'douyin_videos'
  title?: string
  items: DouyinVideoItem[]
  note?: string
}

export type DouyinCommentItem = {
  cid: string
  text: string
  nickname?: string
  /** Unix 秒。 */
  createTime?: number
  diggCount?: number
  replyCount?: number
}
export type DouyinCommentsSpec = Sub & {
  type: 'douyin_comments'
  title?: string
  awemeId?: string
  total?: number
  items: DouyinCommentItem[]
  note?: string
}

export type DouyinSpec = DouyinVideosSpec | DouyinCommentsSpec

// ── 小工具（与 biliSchema.ts 同语义；各自带一份，避免互相引用私有实现） ──

function s(v: unknown, max = 300): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.replace(/\s+/g, ' ').trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function body(v: unknown, max: number, ctx: Ctx): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v
    .split('\n')
    .map((l) => l.replace(/[ \t　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!t) return undefined
  if (t.length <= max) return t
  note(ctx, '长文已截断')
  return `${t.slice(0, max - 1)}…`
}

/** 同一句修复说明只记一次。 */
function note(ctx: Ctx, text: string) {
  if (!ctx.notes.includes(text)) ctx.notes.push(text)
}

/** 非负整数：数字，或数字字符串（含千分位、「万」「亿」；转换时记一句）。 */
function count(v: unknown, ctx: Ctx): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
  if (typeof v !== 'string') return undefined
  const m = /^\s*([\d,.]+)\s*(万|亿)?\s*$/.exec(v)
  if (!m) return undefined
  const x = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(x) || x < 0) return undefined
  note(ctx, '数字字符串已转成数字')
  return Math.round(x * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1))
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

/** 抖音的 ID（awemeId / cid）：纯数字，数字也收。 */
function digits(v: unknown): string | undefined {
  const t = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : s(v, 40)
  return t && /^[0-9]{1,32}$/.test(t) ? t : undefined
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function opt<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V }
}

function capList<T>(items: T[], max: number, ctx: Ctx, unit: string): T[] {
  if (items.length <= max) return items
  note(ctx, `只显示前 ${max} ${unit}`)
  return items.slice(0, max)
}

/** 作品链接：只认 https://www.douyin.com/…（插件结果的写法）。 */
export function douyinUrl(v: unknown): string | undefined {
  const t = s(v, 256)
  return t && /^https:\/\/www\.douyin\.com\/[^\s]*$/.test(t) ? t : undefined
}

/** 作品 ID → 作品页（图文是 /note/，视频是 /video/）。 */
export function workUrl(id: string, imagePost?: boolean): string {
  return `https://www.douyin.com/${imagePost ? 'note' : 'video'}/${id}`
}

/** 封面：只认 https 且主机在 douyinpic.com 下（抖音图床）。 */
export function douyinCover(v: unknown): string | undefined {
  const t = s(v, 1024)
  if (!t || !/^https:\/\//i.test(t)) return undefined
  try {
    const host = new URL(t).hostname.toLowerCase()
    return host === 'douyinpic.com' || host.endsWith('.douyinpic.com') ? t : undefined
  } catch {
    return undefined
  }
}

// ── 组件 ──────────────────────────────────────────────────────────────

function videoItem(o: Record<string, unknown>, ctx: Ctx): DouyinVideoItem | null {
  const awemeId = digits(o.awemeId)
  if (!awemeId) return null
  const isImagePost = bool(o.isImagePost)
  let url = douyinUrl(o.url)
  if (!url) {
    // 链接缺失或不是抖音作品页：用已校验的作品 ID 重新拼，不用原值。
    url = workUrl(awemeId, isImagePost)
    note(ctx, '作品链接不合规，已按作品 ID 重新生成')
  }
  const cover = douyinCover(o.cover)
  if (o.cover !== undefined && o.cover !== null && o.cover !== '' && !cover)
    note(ctx, '封面不是抖音图床地址，已省略')
  return {
    awemeId,
    url,
    ...opt('title', s(o.title, 200)),
    ...opt('desc', s(o.desc, 300)),
    ...opt('createTime', count(o.createTime, ctx)),
    ...opt('durationSec', count(o.durationSec, ctx)),
    ...opt('cover', cover),
    ...opt('playCount', count(o.playCount, ctx)),
    ...opt('diggCount', count(o.diggCount, ctx)),
    ...opt('commentCount', count(o.commentCount, ctx)),
    ...opt('shareCount', count(o.shareCount, ctx)),
    ...opt('collectCount', count(o.collectCount, ctx)),
    ...opt('isPrivate', bool(o.isPrivate)),
    ...opt('inReview', bool(o.inReview)),
    ...opt('isImagePost', isImagePost),
  }
}

export function douyinVideos(raw: Record<string, unknown>, ctx: Ctx): DouyinVideosSpec | null {
  const items: DouyinVideoItem[] = []
  let dropped = 0
  for (const it of list(raw.items)) {
    const o = obj(it)
    const v = o && videoItem(o, ctx)
    if (v) items.push(v)
    else dropped += 1
  }
  if (items.length === 0 && !ctx.partial) return null
  // 流式半截时最后一行常常还没写完，不算丢弃。
  if (dropped > 0 && !ctx.partial) note(ctx, `丢弃 ${dropped} 条无效作品`)
  return {
    type: 'douyin_videos',
    ...opt('title', s(raw.title, 120)),
    ...opt('note', s(raw.note, 300)),
    items: capList(items, DOUYIN_LIMITS.videos, ctx, '个作品'),
  }
}

export function douyinComments(raw: Record<string, unknown>, ctx: Ctx): DouyinCommentsSpec | null {
  const items: DouyinCommentItem[] = []
  let dropped = 0
  for (const it of list(raw.items)) {
    const o = obj(it)
    const cid = o ? digits(o.cid) : undefined
    const text = o ? body(o.text, DOUYIN_LIMITS.commentText, ctx) : undefined
    if (!o || !cid || !text) {
      dropped += 1
      continue
    }
    items.push({
      cid,
      text,
      ...opt('nickname', s(o.nickname, 60)),
      ...opt('createTime', count(o.createTime, ctx)),
      ...opt('diggCount', count(o.diggCount, ctx)),
      ...opt('replyCount', count(o.replyCount, ctx)),
    })
  }
  if (items.length === 0 && !ctx.partial) return null
  // 流式半截时最后一行常常还没写完，不算丢弃。
  if (dropped > 0 && !ctx.partial) note(ctx, `丢弃 ${dropped} 条无效评论`)
  return {
    type: 'douyin_comments',
    ...opt('title', s(raw.title, 120)),
    ...opt('note', s(raw.note, 300)),
    ...opt('awemeId', digits(raw.awemeId)),
    ...opt('total', count(raw.total, ctx)),
    items: capList(items, DOUYIN_LIMITS.comments, ctx, '条评论'),
  }
}

export const DOUYIN_VALIDATORS = {
  douyin_videos: douyinVideos,
  douyin_comments: douyinComments,
} as const

/** 只收不会和通用组件撞名的别名。 */
export const DOUYIN_ALIASES: Record<string, keyof typeof DOUYIN_VALIDATORS> = {
  douyin_works: 'douyin_videos',
  douyin_my_videos: 'douyin_videos',
  douyin_comment: 'douyin_comments',
  douyin_video_comments: 'douyin_comments',
}

// ── 显示用 ────────────────────────────────────────────────────────────

/** 秒 → 「4:10」/「1:02:03」。 */
export function mmss(sec: number | undefined): string | undefined {
  if (sec === undefined || sec < 0) return undefined
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Unix 秒 → 本地「2026-10-13」；withTime 时带「 09:30」。 */
export function dateText(sec: number | undefined, withTime = false): string | undefined {
  if (sec === undefined || sec <= 0) return undefined
  const d = new Date(sec * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  const p = (x: number) => String(x).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day
}

/** 作品显示标题：title → desc → 「作品 <ID>」。 */
export function workTitle(v: Pick<DouyinVideoItem, 'title' | 'desc' | 'awemeId'>): string {
  return v.title ?? v.desc ?? `作品 ${v.awemeId}`
}

/** 状态徽章：私密 / 审核中 / 图文。 */
export function workBadges(
  v: Pick<DouyinVideoItem, 'isPrivate' | 'inReview' | 'isImagePost'>,
): string[] {
  return [
    ...(v.isPrivate ? ['私密'] : []),
    ...(v.inReview ? ['审核中'] : []),
    ...(v.isImagePost ? ['图文'] : []),
  ]
}

/** 时长：图文作品不显示。 */
export function workDuration(v: Pick<DouyinVideoItem, 'durationSec' | 'isImagePost'>) {
  return v.isImagePost ? undefined : mmss(v.durationSec)
}
