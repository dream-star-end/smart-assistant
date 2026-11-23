/**
 * Shared IM Remote-Control & Async Approval Bridge (WeChat / QQ / Telegram / Feishu).
 *
 * Commands:
 *   /pending                    — list user's pending decisions with 4-digit short codes
 *   /approve <code> [附言]      — approve decision mapped to <code> (strict uid ownership)
 *   /deny <code> [理由]         — deny decision mapped to <code> (strict uid ownership)
 *   /sessions                   — list recent sessions with 1-based index
 *   /switch <n>                 — switch IM channel active session pointer to index <n>
 *
 * Proactive push formatting:
 *   formatPendingDecisionPush() — concise push text with risk badge, short code & quick commands
 */

import {
  PENDING_DECISION_SOURCE_LABELS,
  type PendingDecisionItem,
  type PendingDecisionRiskLevel,
} from '@openclaude/protocol'
import type { PendingDecisionsService } from './service.js'
import { ShortCodeRegistry } from './shortCodeRegistry.js'
import { PendingDecisionError } from './types.js'

export interface ImSessionSummary {
  sessionId: string
  title: string
  agentId?: string
  updatedAt?: number | string
  originChannel?: string
}

export interface ImSessionController {
  listSessions: (userId: string, limit?: number) => Promise<ImSessionSummary[]>
  getCurrentSessionId: (userId: string) => Promise<string | null>
  switchSession: (userId: string, sessionId: string, agentId?: string) => Promise<void | boolean>
}

export type ParsedImRemoteCommand =
  | { kind: 'pending' }
  | { kind: 'approve'; code: string; note?: string }
  | { kind: 'deny'; code: string; reason?: string }
  | { kind: 'sessions' }
  | { kind: 'switch'; target: string }

export function parseImRemoteCommand(rawText: string): ParsedImRemoteCommand | null {
  const text = rawText.trim()
  if (!text.startsWith('/')) return null

  if (/^\/pending$/i.test(text)) {
    return { kind: 'pending' }
  }
  const approveMatch = /^\/approve(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i.exec(text)
  if (approveMatch) {
    return {
      kind: 'approve',
      code: (approveMatch[1] ?? '').trim(),
      ...(approveMatch[2]?.trim() ? { note: approveMatch[2].trim() } : {}),
    }
  }
  const denyMatch = /^\/deny(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i.exec(text)
  if (denyMatch) {
    return {
      kind: 'deny',
      code: (denyMatch[1] ?? '').trim(),
      ...(denyMatch[2]?.trim() ? { reason: denyMatch[2].trim() } : {}),
    }
  }
  if (/^\/sessions$/i.test(text)) {
    return { kind: 'sessions' }
  }
  const switchMatch = /^\/switch(?:\s+(\S+))?$/i.exec(text)
  if (switchMatch) {
    return { kind: 'switch', target: (switchMatch[1] ?? '').trim() }
  }
  return null
}

function riskBadge(level: PendingDecisionRiskLevel): string {
  switch (level) {
    case 'critical':
      return '[极高风险]'
    case 'high':
      return '[高风险]'
    case 'medium':
      return '[中风险]'
    default:
      return '[常规]'
  }
}

function formatExpiryRemaining(expiresAt: string | null, nowMs: number): string {
  if (!expiresAt) return '无固定超时'
  const diffMs = new Date(expiresAt).getTime() - nowMs
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '即将过期'
  const mins = Math.max(1, Math.ceil(diffMs / 60_000))
  return `约 ${mins} 分钟内有效`
}

export function formatPendingDecisionPush(
  item: PendingDecisionItem,
  shortCode: string,
  opts?: { channelName?: string; nowMs?: number },
): string {
  const nowMs = opts?.nowMs ?? Date.now()
  const sourceLabel = PENDING_DECISION_SOURCE_LABELS[item.source]
  const expiry = formatExpiryRemaining(item.expiresAt, nowMs)
  return [
    `【待拍板】${riskBadge(item.riskLevel)} ${sourceLabel}`,
    `事项：${item.title}`,
    `摘要：${item.summary.slice(0, 220)}`,
    `确认短码：${shortCode}（${expiry}）`,
    `快捷操作：回复 /approve ${shortCode} 批准，或 /deny ${shortCode} 理由 拒绝`,
  ].join('\n')
}

export interface ImRemoteControlHandler {
  /** Returns null when `text` is not a remote-control command; otherwise returns reply text. */
  tryHandleCommand(args: {
    userId: string
    text: string
    originChannel: string
    channelName?: string
  }): Promise<string | null>
  /** Assign a short code and format a proactive push notification for a new pending decision. */
  formatProactivePush(
    item: PendingDecisionItem,
    opts?: { channelName?: string },
  ): { shortCode: string; text: string }
  readonly shortCodes: ShortCodeRegistry
}

export class ImSessionSwitchError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_SESSION' | 'SESSION_NOT_FOUND' | 'POINTER_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ImSessionSwitchError'
  }
}

export interface ImRemoteControlDeps {
  pendingDecisions?: PendingDecisionsService
  shortCodes?: ShortCodeRegistry
  sessions?: ImSessionController
  /**
   * B2 (OCV5-832): Fail-closed commercial account active check before executing any
   * high-privilege IM remote-control command (/pending, /approve, /deny, /sessions, /switch).
   * Returns true iff account is active; returning false or throwing blocks the command.
   */
  verifyAccountActive?: (userId: string) => Promise<boolean>
  now?: () => number
  maxPendingList?: number
  maxSessionsList?: number
  sessionSnapshotTtlMs?: number
  maxSessionSnapshots?: number
}

const DEFAULT_SESSION_SNAPSHOT_TTL_MS = 30 * 60_000
const DEFAULT_MAX_SESSION_SNAPSHOTS = 1000

export function createImRemoteControlHandler(deps: ImRemoteControlDeps): ImRemoteControlHandler {
  const shortCodes = deps.shortCodes ?? new ShortCodeRegistry({ now: deps.now })
  const now = deps.now ?? (() => Date.now())
  const maxPendingList = deps.maxPendingList ?? 10
  const maxSessionsList = deps.maxSessionsList ?? 10
  const sessionSnapshotTtlMs = Math.max(1000, deps.sessionSnapshotTtlMs ?? DEFAULT_SESSION_SNAPSHOT_TTL_MS)
  const maxSessionSnapshots = Math.max(1, deps.maxSessionSnapshots ?? DEFAULT_MAX_SESSION_SNAPSHOTS)

  // Bounded TTL per-user snapshot of the last `/sessions` listing so `/switch <n>` stays fresh & bounded.
  const recentSessionSnapshot = new Map<string, { sessions: ImSessionSummary[]; updatedAt: number }>()

  function getFreshSessionSnapshot(uid: string): ImSessionSummary[] | undefined {
    const entry = recentSessionSnapshot.get(uid)
    if (!entry) return undefined
    if (now() - entry.updatedAt > sessionSnapshotTtlMs) {
      recentSessionSnapshot.delete(uid)
      return undefined
    }
    return entry.sessions
  }

  function putSessionSnapshot(uid: string, sessions: ImSessionSummary[]): void {
    const nowMs = now()
    for (const [k, v] of recentSessionSnapshot) {
      if (nowMs - v.updatedAt > sessionSnapshotTtlMs) {
        recentSessionSnapshot.delete(k)
      }
    }
    recentSessionSnapshot.delete(uid)
    while (recentSessionSnapshot.size >= maxSessionSnapshots) {
      const oldest = recentSessionSnapshot.keys().next()
      if (oldest.done) break
      recentSessionSnapshot.delete(oldest.value)
    }
    recentSessionSnapshot.set(uid, { sessions, updatedAt: nowMs })
  }

  function formatResolveError(err: unknown, code: string): string {
    if (err instanceof PendingDecisionError) {
      switch (err.code) {
        case 'FORBIDDEN':
          return `短码 ${code} 不属于当前账号，已拒绝操作。`
        case 'NOT_FOUND':
          return `未找到短码 ${code} 对应的待拍板事项，请发送 /pending 刷新列表。`
        case 'EXPIRED':
          return `短码 ${code} 对应的待拍板事项已过期，请发送 /pending 查看最新列表。`
        case 'CONFLICT_ALREADY_RESOLVED':
          return `短码 ${code} 对应的事项已由其他终端处理完成，不能更改结果。`
        case 'REQUIRES_INTERACTIVE_ANSWER':
          return `短码 ${code} 对应的事项是结构化提问，请打开网页端会话填写回答（不支持 /approve 二元批准）。`
        default:
          return `审批失败（${err.code}），请稍后重试。`
      }
    }
    return '审批请求处理失败，请稍后重试或在网页端确认。'
  }

  return {
    shortCodes,

    formatProactivePush(item, opts) {
      const expiresAtMs = item.expiresAt ? new Date(item.expiresAt).getTime() : null
      const entry = shortCodes.getOrAssign(item.userId, item.id, { expiresAtMs })
      return {
        shortCode: entry.code,
        text: formatPendingDecisionPush(item, entry.code, {
          channelName: opts?.channelName,
          nowMs: now(),
        }),
      }
    },

    async tryHandleCommand({ userId, text, originChannel, channelName }) {
      const parsed = parseImRemoteCommand(text)
      if (!parsed) return null

      const uid = userId.trim()
      const label = channelName ?? 'IM'

      // B2 (OCV5-832): Verify active commercial account (fail-closed on inactive or DB error)
      // before executing ANY remote-control read/write command.
      if (deps.verifyAccountActive) {
        let active: boolean
        try {
          active = await deps.verifyAccountActive(uid)
        } catch {
          return '账号状态校验暂时不可用，已拒绝本次远程操作，请稍后重试。'
        }
        if (!active) {
          return '当前账号状态不可用（已停用或封禁），无法执行远程审批或会话切换指令。'
        }
      }

      if (parsed.kind === 'pending') {
        if (!deps.pendingDecisions) {
          return `当前${label}暂未启用待拍板查询服务，请稍后重试。`
        }
        const list = await deps.pendingDecisions.list(uid, { limit: maxPendingList })
        const unavailableSources = (list.warnings ?? []).map(
          (w) => PENDING_DECISION_SOURCE_LABELS[w.source] ?? w.source,
        )
        const uniqueUnavailable = [...new Set(unavailableSources)]
        if (list.items.length === 0) {
          if (uniqueUnavailable.length > 0) {
            return `暂未查到待拍板事项，但以下来源当前休眠或不可用（未计入本次统计）：${uniqueUnavailable.join('、')}。\n请唤醒工作区或在网页端确认后，再发送 /pending 重试。`
          }
          return '当前没有待拍板事项。'
        }
        const nowMs = now()
        const lines: string[] = [`当前有 ${list.counts.total} 项待拍板：`]
        for (let i = 0; i < list.items.length; i++) {
          const item = list.items[i]!
          const expiresAtMs = item.expiresAt ? new Date(item.expiresAt).getTime() : null
          const sc = shortCodes.getOrAssign(uid, item.id, { expiresAtMs })
          const srcLabel = PENDING_DECISION_SOURCE_LABELS[item.source]
          lines.push(
            `${i + 1}. [${sc.code}] ${riskBadge(item.riskLevel)} ${srcLabel} · ${item.title}\n   ${item.summary.slice(0, 120)}（${formatExpiryRemaining(item.expiresAt, nowMs)}）`,
          )
        }
        if (uniqueUnavailable.length > 0) {
          lines.push('')
          lines.push(
            `⚠️ 注意：以下来源当前休眠或不可用（未计入本列表）：${uniqueUnavailable.join('、')}。`,
          )
        }
        lines.push('')
        lines.push('发送 /approve <4位短码> [附言] 批准，或 /deny <4位短码> [理由] 拒绝。')
        return lines.join('\n')
      }

      if (parsed.kind === 'approve' || parsed.kind === 'deny') {
        if (!deps.pendingDecisions) {
          return `当前${label}暂未启用审批服务，请稍后重试。`
        }
        if (!parsed.code) {
          return parsed.kind === 'approve'
            ? '用法：/approve <4位短码> [附言]\n先发送 /pending 获取短码。'
            : '用法：/deny <4位短码> [理由]\n先发送 /pending 获取短码。'
        }
        const lookup = shortCodes.lookup(uid, parsed.code)
        if (!lookup.ok) {
          if (lookup.reason === 'invalid_format') {
            return `短码格式无效（应为 4 位数字）：${parsed.code}\n请发送 /pending 查看有效短码。`
          }
          if (lookup.reason === 'expired') {
            return `短码 ${parsed.code} 已过期，请发送 /pending 重新获取。`
          }
          return `未找到属于当前账号的短码 ${parsed.code}，请发送 /pending 确认。`
        }

        const decisionId = lookup.entry.decisionId
        const noteOrReason = parsed.kind === 'approve' ? parsed.note : parsed.reason
        try {
          const resolved = await deps.pendingDecisions.resolve(uid, decisionId, {
            decision: parsed.kind,
            ...(noteOrReason ? { reason: noteOrReason } : {}),
            originChannel,
          })
          shortCodes.invalidateByDecisionId(uid, decisionId)
          const verb = parsed.kind === 'approve' ? '已批准' : '已拒绝'
          const replayHint = resolved.idempotentReplay ? '（重复确认，结果保持一致）' : ''
          const extra = noteOrReason ? `\n备注：${noteOrReason}` : ''
          return `${verb}短码 ${parsed.code} 对应的待拍板事项${replayHint}。${extra}`
        } catch (err) {
          if (
            err instanceof PendingDecisionError &&
            (err.code === 'EXPIRED' || err.code === 'CONFLICT_ALREADY_RESOLVED')
          ) {
            shortCodes.invalidateByDecisionId(uid, decisionId)
          }
          return formatResolveError(err, parsed.code)
        }
      }

      if (parsed.kind === 'sessions') {
        if (!deps.sessions) {
          return `当前${label}暂未启用会话列表查询，请稍后重试。`
        }
        const [sessions, currentId] = await Promise.all([
          deps.sessions.listSessions(uid, maxSessionsList),
          deps.sessions.getCurrentSessionId(uid),
        ])
        if (sessions.length === 0) {
          recentSessionSnapshot.delete(uid)
          return '当前还没有可切换的历史会话，直接发消息即可开启新会话。'
        }
        putSessionSnapshot(uid, sessions)
        const lines = [
          `最近会话（${label}）：`,
          ...sessions.map((s, idx) => {
            const marker = s.sessionId === currentId ? '（当前）' : ''
            const title = (s.title || '未命名会话').slice(0, 60)
            return `${idx + 1}. ${title}${marker}\n   ${s.sessionId}`
          }),
          '',
          '发送 /switch <序号> 切换当前会话。',
        ]
        return lines.join('\n')
      }

      if (parsed.kind === 'switch') {
        if (!deps.sessions) {
          return `当前${label}暂未启用会话切换，请稍后重试。`
        }
        if (!parsed.target) {
          return '用法：/switch <序号>\n先发送 /sessions 查看会话编号。'
        }
        const isNumericIndex = /^\d+$/.test(parsed.target)
        let sessions = getFreshSessionSnapshot(uid)
        if (isNumericIndex && (!sessions || sessions.length === 0)) {
          return '当前会话编号列表已过期或尚未加载，请先发送 /sessions 查看最新编号后再使用 /switch <序号> 切换。'
        }
        if (!sessions || sessions.length === 0) {
          // Non-numeric explicit sessionId lookup: fetch fresh list for ID matching without
          // mutating recentSessionSnapshot (which must only reflect a /sessions list the user saw).
          sessions = await deps.sessions.listSessions(uid, maxSessionsList)
        }
        if (sessions.length === 0) {
          return '当前没有可切换的会话，请先发送 /sessions 查看。'
        }

        let targetSession: ImSessionSummary | undefined
        if (isNumericIndex) {
          const index = Number(parsed.target) - 1
          if (index >= 0 && index < sessions.length) {
            targetSession = sessions[index]
          }
        } else {
          targetSession = sessions.find((s) => s.sessionId === parsed.target)
        }

        if (!targetSession) {
          return `未找到可切换的会话「${parsed.target}」，当前共有 ${sessions.length} 个可续接会话。\n请发送 /sessions 查看列表（仅支持切换本渠道可续接的会话）。`
        }

        try {
          const switched = await deps.sessions.switchSession(
            uid,
            targetSession.sessionId,
            targetSession.agentId,
          )
          if (switched === false) {
            return `无法切换到会话「${targetSession.sessionId}」：会话指针未被更新，本次切换未生效。\n请发送 /sessions 查看当前可续接会话后重试。`
          }
        } catch (err) {
          if (err instanceof ImSessionSwitchError) {
            return `无法切换到会话「${targetSession.sessionId}」：${err.message}\n请发送 /sessions 查看当前可续接会话。`
          }
          throw err
        }
        return `已切换到会话：${targetSession.title || targetSession.sessionId}\n会话ID：${targetSession.sessionId}\n下一条${label}消息将继续该会话上下文。`
      }

      return null
    },
  }
}
