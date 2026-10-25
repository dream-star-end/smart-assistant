/**
 * 对话写博客（经验分享草稿卡）的纯逻辑：发给 Agent 的修改请求、本机的「已投稿」记录、同一草稿的版本登记。
 * 不含渲染，单测直接调用。
 */
import type { CommunityBlogPrecheck, CommunityBlogPrecheckIssue } from '../../lib/types'
import type { BlogDraftSpec } from './blogSchema'

export type BlogIssue = CommunityBlogPrecheckIssue
export type BlogPrecheck = CommunityBlogPrecheck

const FIELD_WHERE: Record<string, string> = { title: '标题', summary: '摘要', category: '分类', bodyMarkdown: '正文', quota: '投稿额度' }

export function issueWhere(issue: BlogIssue): string {
  return issue.where ?? FIELD_WHERE[issue.field] ?? '草稿'
}

/** 额度问题 Agent 改不了，不发给它。 */
export function fixableIssues(issues: readonly BlogIssue[]): BlogIssue[] {
  return issues.filter((i) => i.field !== 'quota')
}

/** 「修复」/「全部修复」发给 Agent 的话：点名草稿和版本，逐条列修改点。 */
export function composeFixMessage(spec: Pick<BlogDraftSpec, 'draftId' | 'version'>, issues: readonly BlogIssue[]): string {
  const lines = issues.map((issue, i) => `${i + 1}. ${issueWhere(issue)}：${issue.message}`)
  return [
    `请按以下修改点更新经验分享草稿（draft_id ${spec.draftId}，当前 v${spec.version}），改完给我 v${spec.version + 1}：`,
    ...lines,
  ].join('\n')
}

/** 审核未通过后「按理由修改」。理由只来自服务端模板。 */
export function composeRevisionMessage(id: string, reason: string | null): string {
  return `经验分享稿件 #${id} 没有通过审核${reason ? `，理由：${reason}` : ''}。请按理由修改草稿，给我一个新版本，我确认后重新投稿。`
}

/** 投稿成功后替用户发出的那句话，让 Agent 知道稿件号（之后它可以写 blog_status 卡）。 */
export function composeSubmittedMessage(spec: Pick<BlogDraftSpec, 'draftId' | 'version'>, id: string): string {
  return `我已确认投稿经验分享（稿件 #${id}，draft_id ${spec.draftId} v${spec.version}）。`
}

// ── 本机「已投稿」记录：同一份草稿不重复投；刷新后草稿卡仍显示状态 ──────────────

const SUBMITTED_KEY = 'oc-blog-chat-submitted'
const SUBMITTED_MAX = 50

export type SubmittedRecord = { draftId: string; version: number; id: string; at: number }

function readAll(): SubmittedRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(SUBMITTED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(
          (r): r is SubmittedRecord =>
            !!r && typeof r.draftId === 'string' && typeof r.version === 'number' && typeof r.id === 'string',
        )
      : []
  } catch {
    return []
  }
}

/** 这一版投过的记录。 */
export function submittedFor(draftId: string, version: number): SubmittedRecord | null {
  return readAll().find((r) => r.draftId === draftId && r.version === version) ?? null
}

/** 同一草稿里投过的最新一版（更旧的版本据此变只读；更新的版本可以重新投，例如被驳回后改的版本）。 */
export function latestSubmitted(draftId: string): SubmittedRecord | null {
  return readAll()
    .filter((r) => r.draftId === draftId)
    .reduce<SubmittedRecord | null>((best, r) => (!best || r.version > best.version ? r : best), null)
}

export function rememberSubmitted(record: SubmittedRecord): void {
  try {
    const next = [record, ...readAll().filter((r) => r.draftId !== record.draftId || r.version !== record.version)].slice(0, SUBMITTED_MAX)
    globalThis.localStorage?.setItem(SUBMITTED_KEY, JSON.stringify(next))
  } catch {
    // 存不下就只在本页有效；服务端频控兜底重复投稿。
  }
}

// ── 版本登记：页面上同一 draftId 出现更高版本时，旧卡变只读 ─────────────────

const latest = new Map<string, number>()
const listeners = new Set<() => void>()

/** 记下版本。silent = 渲染期间调用，只更新登记、不通知（通知放到 effect 里，避免渲染中更新别的组件）。 */
export function registerDraftVersion(draftId: string, version: number, silent = false): void {
  if ((latest.get(draftId) ?? 0) < version) latest.set(draftId, version)
  if (!silent) for (const fn of listeners) fn()
}

export function latestDraftVersion(draftId: string): number {
  return latest.get(draftId) ?? 0
}

export function subscribeDraftVersions(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function __resetBlogChatForTests(): void {
  latest.clear()
  listeners.clear()
}
