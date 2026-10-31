/**
 * Intelligent UI —— 哔哩哔哩插件专属组件的 schema（OCV5-402）。
 *
 * 按需加载规则（OCV5-393）：这些类型的定义**不在**通用协议里，只在 app-connectors 技能的
 * `references/ui-bili.md` 里；模型加载 B 站插件、要展示结果时才读它。
 *
 * 字段名直接沿用 `oc-plugin call bili …` / `bili-account …` 结果里的名字，两种形状都收：
 * 搜索结果的扁平写法（author / play / video_review / pic / duration "4:10"）和视频 / 排行的嵌套写法
 * （owner.name / stat.view / duration 秒）。模型照抄即可，不用改写数字。
 * 规则同 pluginSchema.ts：能修就修（丢非法行、数字字符串转数字、去掉搜索标题里的 <em> 高亮），
 * 修过的记进 notes；修不了才降级。链接只接受 http(s)，以 // 开头的 B 站封面补成 https。
 */

import { formatZoned } from '../../lib/displayTime'

type Ctx = { notes: string[]; partial: boolean }
type Sub = { subtitle?: string }

export const BILI_LIMITS = {
  videos: 30,
  rank: 100,
  comments: 20,
  commentText: 1_000,
  danmakuItems: 200,
  density: 120,
  subtitleLines: 600,
  pages: 50,
  desc: 1_000,
} as const

export type BiliVideoItem = {
  bvid?: string
  title: string
  url?: string
  cover?: string
  author?: string
  play?: number
  danmaku?: number
  likes?: number
  durationSec?: number
  pubdate?: string
  /** 观看历史：看到第几秒（-1 = 已看完）。 */
  progressSec?: number
  viewedAt?: string
  favAt?: string
  desc?: string
}
export type BiliVideosSpec = Sub & {
  type: 'bili_videos'
  title?: string
  items: BiliVideoItem[]
  source?: string
  note?: string
}

export type BiliRankItem = BiliVideoItem & { rank: number; score?: number }
export type BiliRankSpec = Sub & {
  type: 'bili_rank'
  title?: string
  items: BiliRankItem[]
  source?: string
  note?: string
}

export type BiliStats = {
  view?: number
  danmaku?: number
  reply?: number
  favorite?: number
  coin?: number
  share?: number
  like?: number
}
export type BiliVideoSpec = Sub & {
  type: 'bili_video'
  bvid?: string
  title: string
  url?: string
  cover?: string
  author?: string
  desc?: string
  durationSec?: number
  pubdate?: string
  category?: string
  stats: BiliStats
  pages: { page: number; part: string; durationSec?: number }[]
  source?: string
  note?: string
}

export type BiliComment = {
  user?: string
  level?: number
  likes?: number
  replies?: number
  text: string
  time?: string
}
export type BiliCommentsSpec = Sub & {
  type: 'bili_comments'
  title?: string
  total?: number
  url?: string
  items: BiliComment[]
  source?: string
  note?: string
}

export type BiliDanmakuSpec = Sub & {
  type: 'bili_danmaku'
  title?: string
  url?: string
  total?: number
  maxT?: number
  density: number[]
  items: { t: number; text: string }[]
  source?: string
  note?: string
}

export type BiliSubtitleSpec = Sub & {
  type: 'bili_subtitle'
  title?: string
  url?: string
  lang?: string
  lines: { from: number; to?: number; text: string }[]
  source?: string
  note?: string
}

export type BiliSpec =
  | BiliVideosSpec
  | BiliRankSpec
  | BiliVideoSpec
  | BiliCommentsSpec
  | BiliDanmakuSpec
  | BiliSubtitleSpec

// ── 小工具（与 pluginSchema.ts 同语义；各自带一份，避免互相引用私有实现） ──

function s(v: unknown, max = 300): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
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
  ctx.notes.push('长文已截断')
  return `${t.slice(0, max - 1)}…`
}

/** 计数：数字或数字字符串（含千分位、「万」「亿」）。 */
function count(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
  if (typeof v !== 'string') return undefined
  const m = /^\s*([\d,.]+)\s*(万|亿)?\s*$/.exec(v)
  if (!m) return undefined
  const x = Number(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(x) || x < 0) return undefined
  return Math.round(x * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1))
}

function num(v: unknown): number | undefined {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

function link(v: unknown): string | undefined {
  let t = s(v, 2048)
  if (t?.startsWith('//')) t = `https:${t}`
  return t && /^https?:\/\/[^\s]+$/i.test(t) ? t : undefined
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
  ctx.notes.push(`只显示前 ${max} ${unit}`)
  return items.slice(0, max)
}

function common(raw: Record<string, unknown>) {
  return {
    ...opt('title', s(raw.title, 120)),
    ...opt('source', s(raw.source, 200)),
    ...opt('note', s(raw.note, 300)),
  }
}

const BVID_RE = /^BV[0-9A-Za-z]{10}$/

export function bvid(v: unknown): string | undefined {
  const t = s(v, 12)
  return t && BVID_RE.test(t) ? t : undefined
}

/** bvid → 视频页链接（bvid 已按 BV + 10 位校验，拼出来的地址只会是 bilibili.com）。 */
export function videoUrl(id: string | undefined): string | undefined {
  return id ? `https://www.bilibili.com/video/${id}` : undefined
}

/** 去掉搜索标题里的 <em class="keyword"> 等标签与常见实体。 */
function plainTitle(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  return s(t, max)
}

/** 时长：秒数，或 "4:10" / "1:02:03"。 */
function duration(v: unknown): number | undefined {
  const n = num(v)
  if (n !== undefined) return n >= 0 ? Math.round(n) : undefined
  if (typeof v !== 'string') return undefined
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,3}):(\d{2})\s*$/.exec(v)
  if (!m) return undefined
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 时间：Unix 秒 / 毫秒，或可被 Date 解析的字符串 → 「2026-10-13 09:30」。 */
export function when(v: unknown): string | undefined {
  const n = num(v)
  let d: Date | undefined
  if (n !== undefined && n > 1e9) d = new Date(n > 1e12 ? n : n * 1000)
  else if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = s(v, 40)
    return t
  }
  if (!d || Number.isNaN(d.getTime())) return undefined
  return formatZoned(d, 'datetime')
}

function videoItem(o: Record<string, unknown>): BiliVideoItem | null {
  const title = plainTitle(o.title, 200)
  if (!title) return null
  const id = bvid(o.bvid ?? obj(o.history)?.bvid)
  const owner = obj(o.owner) ?? obj(o.upper)
  const stat = obj(o.stat) ?? obj(o.cnt_info)
  return {
    ...opt('bvid', id),
    title,
    ...opt('url', link(o.url) ?? videoUrl(id)),
    ...opt('cover', link(o.cover ?? o.pic)),
    ...opt('author', s(o.author ?? o.author_name ?? owner?.name, 60)),
    ...opt('play', count(o.play ?? stat?.view ?? stat?.play)),
    ...opt('danmaku', count(o.danmaku ?? o.video_review ?? stat?.danmaku)),
    ...opt('likes', count(o.likes ?? stat?.like)),
    ...opt('durationSec', duration(o.durationSec ?? o.duration)),
    ...opt('pubdate', when(o.pubdate ?? o.created)),
    ...opt('progressSec', num(o.progressSec ?? o.progress)),
    ...opt('viewedAt', when(o.viewedAt ?? o.view_at)),
    ...opt('favAt', when(o.favAt ?? o.fav_time)),
    ...opt('desc', s(o.desc ?? o.description, 200)),
  }
}

// ── 组件 ──────────────────────────────────────────────────────────────

export function biliVideos(raw: Record<string, unknown>, ctx: Ctx): BiliVideosSpec | null {
  const items: BiliVideoItem[] = []
  for (const it of list(raw.items ?? raw.result ?? raw.list ?? raw.medias)) {
    const o = obj(it)
    const v = o && videoItem(o)
    if (v) items.push(v)
  }
  if (items.length === 0 && !ctx.partial) return null
  return {
    type: 'bili_videos',
    ...common(raw),
    items: capList(items, BILI_LIMITS.videos, ctx, '个视频'),
  }
}

export function biliRank(raw: Record<string, unknown>, ctx: Ctx): BiliRankSpec | null {
  const items: BiliRankItem[] = []
  for (const [i, it] of list(raw.items ?? raw.list).entries()) {
    const o = obj(it)
    const v = o && videoItem(o)
    if (!v) continue
    const rank = count(o.rank)
    // 旧排行接口的 pts 恒为 0：只有正数才当综合分显示。
    const score = count(o.score ?? o.pts)
    items.push({
      ...v,
      rank: rank && rank > 0 ? rank : i + 1,
      ...opt('score', score && score > 0 ? score : undefined),
    })
  }
  if (items.length === 0 && !ctx.partial) return null
  return { type: 'bili_rank', ...common(raw), items: capList(items, BILI_LIMITS.rank, ctx, '名') }
}

export function biliVideo(raw: Record<string, unknown>, ctx: Ctx): BiliVideoSpec | null {
  const title = plainTitle(raw.title, 200)
  if (!title) return null
  const id = bvid(raw.bvid)
  const owner = obj(raw.owner)
  const stat = obj(raw.stat) ?? obj(raw.stats) ?? {}
  const pages: BiliVideoSpec['pages'] = []
  for (const [i, p] of list(raw.pages).entries()) {
    const o = obj(p)
    const part = o && s(o.part, 120)
    if (!o || !part) continue
    pages.push({ page: count(o.page) ?? i + 1, part, ...opt('durationSec', duration(o.duration)) })
  }
  return {
    type: 'bili_video',
    ...opt('source', s(raw.source, 200)),
    ...opt('note', s(raw.note, 300)),
    ...opt('bvid', id),
    title,
    ...opt('url', link(raw.url) ?? videoUrl(id)),
    ...opt('cover', link(raw.cover ?? raw.pic)),
    ...opt('author', s(raw.author ?? owner?.name, 60)),
    ...opt('desc', body(raw.desc, BILI_LIMITS.desc, ctx)),
    ...opt('durationSec', duration(raw.durationSec ?? raw.duration)),
    ...opt('pubdate', when(raw.pubdate)),
    ...opt('category', s(raw.category ?? raw.tname, 30)),
    stats: {
      ...opt('view', count(stat.view)),
      ...opt('danmaku', count(stat.danmaku)),
      ...opt('reply', count(stat.reply)),
      ...opt('favorite', count(stat.favorite)),
      ...opt('coin', count(stat.coin)),
      ...opt('share', count(stat.share)),
      ...opt('like', count(stat.like)),
    },
    pages: capList(pages, BILI_LIMITS.pages, ctx, '个分 P'),
  }
}

export function biliComments(raw: Record<string, unknown>, ctx: Ctx): BiliCommentsSpec | null {
  const items: BiliComment[] = []
  for (const it of list(raw.items ?? raw.replies)) {
    const o = obj(it)
    if (!o) continue
    const member = obj(o.member)
    const text = body(o.text ?? o.message ?? obj(o.content)?.message, BILI_LIMITS.commentText, ctx)
    if (!text) continue
    items.push({
      ...opt('user', s(o.user ?? o.uname ?? member?.uname, 40)),
      ...opt('level', count(o.level ?? obj(member?.level_info)?.current_level)),
      ...opt('likes', count(o.likes ?? o.like)),
      ...opt('replies', count(o.replies ?? o.rcount)),
      text,
      ...opt('time', when(o.time ?? o.ctime)),
    })
  }
  if (items.length === 0 && !ctx.partial) return null
  return {
    type: 'bili_comments',
    ...common(raw),
    ...opt('total', count(raw.total ?? obj(raw.cursor)?.all_count)),
    ...opt('url', link(raw.url) ?? videoUrl(bvid(raw.bvid))),
    items: capList(items, BILI_LIMITS.comments, ctx, '条评论'),
  }
}

export function biliDanmaku(raw: Record<string, unknown>, ctx: Ctx): BiliDanmakuSpec | null {
  const density: number[] = []
  for (const d of list(raw.density)) {
    const n = count(d)
    if (n !== undefined) density.push(n)
  }
  const items: { t: number; text: string }[] = []
  for (const it of list(raw.items)) {
    const o = obj(it)
    const t = o ? num(o.t ?? o.time_sec ?? o.time) : undefined
    const text = o ? s(o.text, 100) : undefined
    if (t === undefined || t < 0 || !text) continue
    items.push({ t, text })
  }
  if (items.length === 0 && density.length === 0 && !ctx.partial) return null
  items.sort((a, b) => a.t - b.t)
  return {
    type: 'bili_danmaku',
    ...common(raw),
    ...opt('url', link(raw.url) ?? videoUrl(bvid(raw.bvid))),
    ...opt('total', count(raw.total)),
    ...opt('maxT', num(raw.maxT)),
    density: capList(density, BILI_LIMITS.density, ctx, '段'),
    items: capList(items, BILI_LIMITS.danmakuItems, ctx, '条弹幕'),
  }
}

export function biliSubtitle(raw: Record<string, unknown>, ctx: Ctx): BiliSubtitleSpec | null {
  const lines: BiliSubtitleSpec['lines'] = []
  for (const it of list(raw.lines ?? raw.body)) {
    const o = obj(it)
    if (!o) continue
    const from = num(o.from ?? o.start)
    const text = s(o.text ?? o.content, 300)
    if (from === undefined || from < 0 || !text) continue
    lines.push({ from, ...opt('to', num(o.to ?? o.end)), text })
  }
  if (lines.length === 0 && !ctx.partial) return null
  return {
    type: 'bili_subtitle',
    ...common(raw),
    ...opt('url', link(raw.url) ?? videoUrl(bvid(raw.bvid))),
    ...opt('lang', s(raw.lang ?? raw.lan_doc ?? raw.lan, 30)),
    lines: capList(lines, BILI_LIMITS.subtitleLines, ctx, '行'),
  }
}

export const BILI_VALIDATORS = {
  bili_videos: biliVideos,
  bili_rank: biliRank,
  bili_video: biliVideo,
  bili_comments: biliComments,
  bili_danmaku: biliDanmaku,
  bili_subtitle: biliSubtitle,
} as const

/** 只收不会和通用组件撞名的别名。 */
export const BILI_ALIASES: Record<string, keyof typeof BILI_VALIDATORS> = {
  bilibili_videos: 'bili_videos',
  bili_video_list: 'bili_videos',
  bili_ranking: 'bili_rank',
  bilibili_rank: 'bili_rank',
  bilibili_video: 'bili_video',
  bili_reply: 'bili_comments',
  bili_replies: 'bili_comments',
  bili_dm: 'bili_danmaku',
  bili_subtitles: 'bili_subtitle',
}

// ── 显示用 ────────────────────────────────────────────────────────────

/** 秒 → 「4:10」/「1:02:03」。 */
export function clock(sec: number | undefined): string | undefined {
  if (sec === undefined || sec < 0) return undefined
  const t = Math.round(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 弹幕密度最高的一段（按 maxT 换算成时间）；没有密度数据返回 undefined。 */
export function peakOf(
  spec: Pick<BiliDanmakuSpec, 'density' | 'maxT'>,
): { index: number; fromSec?: number; toSec?: number } | undefined {
  if (spec.density.length === 0) return undefined
  let index = 0
  for (let i = 1; i < spec.density.length; i += 1)
    if ((spec.density[i] ?? 0) > (spec.density[index] ?? 0)) index = i
  if (!spec.maxT || spec.maxT <= 0) return { index }
  const span = spec.maxT / spec.density.length
  return { index, fromSec: index * span, toSec: (index + 1) * span }
}

/** 历史进度：-1 或 ≥ 时长 = 看完。 */
export function progressText(
  it: Pick<BiliVideoItem, 'progressSec' | 'durationSec'>,
): string | undefined {
  if (it.progressSec === undefined) return undefined
  if (it.progressSec < 0 || (it.durationSec !== undefined && it.progressSec >= it.durationSec))
    return '已看完'
  return `看到 ${clock(it.progressSec)}`
}
