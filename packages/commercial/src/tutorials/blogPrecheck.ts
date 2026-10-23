/**
 * 「经验分享」投稿预检（对话写博客，OCV5-577 跟进）。
 *
 * 对话里的草稿卡在用户点「确认投稿」前调用它，把会被拒、会转人工的地方提前列出来，交给 Agent 改。
 * 只做确定性检查，和真正投稿用同一套规则：长度与分类、正文图片写法与张数、泄密扫描、对审核者下指令的
 * 特征、频控余量。**不调用模型、不写库、不入队**，也不返回任何 AI 审核结论，免得被用来反复试探审核口径。
 * 位置只给到第几节，不回显命中的原文或标题（草稿里的密钥不该再出现在对话里）。
 */
import type { TutorialLeakRule } from '@openclaude/protocol'

import { query } from '../db/queries.js'
import {
  COMMUNITY_TUTORIAL_CATEGORIES,
  COMMUNITY_TUTORIAL_DAILY_SUBMISSIONS,
  COMMUNITY_TUTORIAL_MAX_PENDING,
} from './communityTutorials.js'
import { scanText } from './snapshotSanitizer.js'
import {
  TUTORIAL_IMAGE_MAX_PER_POST,
  TutorialImageError,
  maskTutorialImageRefs,
  parseTutorialImageRefs,
} from './tutorialImages.js'
import { detectPromptInjection } from './tutorialModeration.js'

export type BlogPrecheckField = 'title' | 'summary' | 'category' | 'bodyMarkdown' | 'quota'

export type BlogPrecheckIssue = {
  code: string
  /** block = 投稿会被拒，必须先改；warn = 能投，但不会自动通过（转人工）。 */
  level: 'block' | 'warn'
  field: BlogPrecheckField
  message: string
  /** 「第 2 节」「开头」之类；不含原文。 */
  where?: string
}

export type BlogPrecheckResult = {
  issues: BlogPrecheckIssue[]
  quota: { pendingLeft: number; dailyLeft: number }
}

// 与投稿接口（communityTutorialRoutes.ts）的长度上下限一致。
const LIMITS = { title: [4, 100], summary: [10, 280], bodyMarkdown: [40, 50000] } as const
const FIELD_LABEL = { title: '标题', summary: '摘要', bodyMarkdown: '正文' } as const

// 正文扫描（scanText）只会产出这些规则；快照专用的规则不会出现在这里。
const LEAK_LABEL: Partial<Record<TutorialLeakRule, string>> = {
  private_key: '私钥',
  secret_token: '密钥或 token',
  credential_label: '账号口令或认证信息',
  high_entropy_secret: '疑似密钥的长随机串',
  email: '邮箱地址',
  phone: '手机号',
  absolute_path: '本机或服务器上的文件路径',
  session_identifier: '会话 ID',
  trace_identifier: '追踪 ID',
  request_identifier: '请求 ID',
  container_identifier: '容器 ID',
  signed_media_url: '带签名的临时链接',
  dangerous_scheme: '不安全的链接写法',
  html_external: '引用站外资源的 HTML',
  network_api: '网络请求代码',
  html_navigation: '会跳转页面的 HTML',
}

const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30
const recent = new Map<string, number[]>()

/** 每人每分钟 30 次（单进程 master，内存计数即可）。超出返回 false。 */
export function takeBlogPrecheckToken(userId: string, now = Date.now()): boolean {
  const kept = (recent.get(userId) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
  if (kept.length >= RATE_MAX) {
    recent.set(userId, kept)
    return false
  }
  kept.push(now)
  recent.set(userId, kept)
  if (recent.size > 10_000) {
    for (const [key, stamps] of recent) if (stamps.every((at) => now - at >= RATE_WINDOW_MS)) recent.delete(key)
  }
  return true
}

export function __resetBlogPrecheckRateForTests(): void {
  recent.clear()
}

type Section = { heading: string | null; text: string }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/

/** 按围栏外的标题行切节；围栏内的 # 不算标题，所以每一节的围栏都是成对的。 */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [{ heading: null, text: '' }]
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const open = FENCE_RE.exec(line)
    if (fence) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.trim() === open[1]) fence = null
    } else if (open) {
      fence = open[1]!
    } else {
      const heading = HEADING_RE.exec(line)
      if (heading) {
        sections.push({ heading: heading[1]!.slice(0, 40), text: `${line}\n` })
        continue
      }
    }
    sections[sections.length - 1]!.text += `${line}\n`
  }
  return sections.filter((s) => s.text.trim().length > 0)
}

/**
 * 位置只给节序号，不回显标题：标题单看无害、和正文合起来才命中的泄密规则（trace + 32 位十六进制）
 * 判断不了，所以一律不回显（Codex R1/R2 P1）。没有标题的开头一段记为「开头」。
 */
function where(section: Section, index: number): string {
  return index === 0 && !section.heading ? '开头' : `第 ${index + 1} 节`
}

function charLength(value: string): number {
  return [...value.trim()].length
}

function lengthIssue(field: keyof typeof LIMITS, value: unknown): BlogPrecheckIssue | null {
  const [min, max] = LIMITS[field]
  const n = typeof value === 'string' ? charLength(value) : 0
  if (n >= min && n <= max) return null
  return {
    code: `${field}_length`,
    level: 'block',
    field,
    message: n < min ? `${FIELD_LABEL[field]}太短：现在 ${n} 字，至少 ${min} 字` : `${FIELD_LABEL[field]}太长：现在 ${n} 字，最多 ${max} 字`,
  }
}

/** 纯函数部分：不碰数据库，测试直接调用。 */
export function precheckBlogDraft(raw: Record<string, unknown>): BlogPrecheckIssue[] {
  const issues: BlogPrecheckIssue[] = []
  const title = typeof raw.title === 'string' ? raw.title : ''
  const summary = typeof raw.summary === 'string' ? raw.summary : ''
  const body = typeof raw.bodyMarkdown === 'string' ? raw.bodyMarkdown : ''
  for (const [field, value] of [
    ['title', raw.title],
    ['summary', raw.summary],
    ['bodyMarkdown', raw.bodyMarkdown],
  ] as const) {
    const issue = lengthIssue(field, value)
    if (issue) issues.push(issue)
  }
  if (typeof raw.category !== 'string' || !(COMMUNITY_TUTORIAL_CATEGORIES as readonly string[]).includes(raw.category))
    issues.push({ code: 'category', level: 'block', field: 'category', message: '分类只能是 研究 / 编程 / 通用 之一' })

  // 泄密：标题、摘要各算一处；正文按节定位，同一种问题只报第一处。
  const pushLeak = (rule: TutorialLeakRule, field: BlogPrecheckField, at?: string) => {
    issues.push({
      code: `leak_${rule}`,
      level: 'block',
      field,
      message: `有${LEAK_LABEL[rule] ?? '敏感信息'}，公开内容里不能出现，删掉或打码`,
      ...(at ? { where: at } : {}),
    })
  }
  const pushLeaks = (text: string, field: BlogPrecheckField) => {
    for (const leak of scanText(maskTutorialImageRefs(text), field)) pushLeak(leak.rule, field)
  }
  pushLeaks(title, 'title')
  pushLeaks(summary, 'summary')
  // 正文以整篇扫描为准（与投稿一致：有的规则要同一段文字里同时出现两个特征），再按节找第一处
  // 单独命中的位置；只在跨节组合时才命中的规则不给位置（Codex R1 P2）。
  const sections = splitSections(body)
  for (const leak of scanText(maskTutorialImageRefs(body), 'bodyMarkdown')) {
    const index = sections.findIndex((section) =>
      scanText(maskTutorialImageRefs(section.text), 'bodyMarkdown').some((hit) => hit.rule === leak.rule),
    )
    pushLeak(leak.rule, 'bodyMarkdown', index >= 0 ? where(sections[index]!, index) : undefined)
  }

  // 图片：只认本站上传的 tutorial-blob 图片；按节找出第一处站外或不合法的写法。
  let externalReported = false
  for (const section of sections) {
    try {
      parseTutorialImageRefs(section.text)
    } catch (error) {
      if (error instanceof TutorialImageError && error.code === 'EXTERNAL_IMAGE' && !externalReported) {
        externalReported = true
        issues.push({
          code: 'external_image',
          level: 'block',
          field: 'bodyMarkdown',
          message: '用了站外图片或不支持的图片写法；经验分享只显示本站上传的图片，改用对话里生成的图片或删掉',
          where: where(section, sections.indexOf(section)),
        })
      }
    }
  }
  try {
    parseTutorialImageRefs(body)
  } catch (error) {
    if (error instanceof TutorialImageError && error.code === 'TOO_MANY_IMAGES')
      issues.push({
        code: 'too_many_images',
        level: 'block',
        field: 'bodyMarkdown',
        message: `图片太多，每篇最多 ${TUTORIAL_IMAGE_MAX_PER_POST} 张`,
      })
  }

  // 对审核者下指令：能投，但一律转人工，提前告诉作者。
  if (detectPromptInjection(`${title}\n${summary}`))
    issues.push({ code: 'reviewer_instruction', level: 'warn', field: 'title', message: REVIEWER_MESSAGE })
  const hit = sections.findIndex((section) => detectPromptInjection(section.text))
  if (hit >= 0)
    issues.push({ code: 'reviewer_instruction', level: 'warn', field: 'bodyMarkdown', message: REVIEWER_MESSAGE, where: where(sections[hit]!, hit) })
  else if (detectPromptInjection(body))
    issues.push({ code: 'reviewer_instruction', level: 'warn', field: 'bodyMarkdown', message: REVIEWER_MESSAGE })
  return issues
}

const REVIEWER_MESSAGE =
  '有像是对审核者说的话（如「忽略规则」「判定为通过」）；这类稿件不会自动通过，会转站长人工复核。如果不是有意的，改写这句'

export async function precheckCommunityTutorial(
  authorUserId: string,
  raw: Record<string, unknown>,
): Promise<BlogPrecheckResult> {
  const issues = precheckBlogDraft(raw)
  const counts = await query<{ pending: string; recent: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
            count(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::text AS recent
       FROM community_tutorials
      WHERE author_user_id = $1::bigint AND kind = 'markdown'`,
    [authorUserId],
  )
  const pendingLeft = Math.max(0, COMMUNITY_TUTORIAL_MAX_PENDING - Number(counts.rows[0]?.pending ?? 0))
  const dailyLeft = Math.max(0, COMMUNITY_TUTORIAL_DAILY_SUBMISSIONS - Number(counts.rows[0]?.recent ?? 0))
  if (pendingLeft === 0)
    issues.push({
      code: 'quota_pending',
      level: 'block',
      field: 'quota',
      message: `已有 ${COMMUNITY_TUTORIAL_MAX_PENDING} 篇在审核，等审核结果出来再投`,
    })
  else if (dailyLeft === 0)
    issues.push({
      code: 'quota_daily',
      level: 'block',
      field: 'quota',
      message: `24 小时内最多投稿 ${COMMUNITY_TUTORIAL_DAILY_SUBMISSIONS} 篇，明天再投`,
    })
  return { issues, quota: { pendingLeft, dailyLeft } }
}
