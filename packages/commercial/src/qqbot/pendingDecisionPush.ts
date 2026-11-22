/**
 * Proactive QQ Bot push formatter & delivery helper for Pending Decision events.
 *
 * Security invariants (B7):
 *   - Respects user proactive push preference (`isProactiveEnabled`, fail-closed).
 *   - Delivers only to the authoritative bound QQ openid (`getQqBinding`).
 *   - Requires a real `ShortCodeRegistry` (via `remoteControl` or `shortCodes`); never emits `0000`.
 */

import type { Pool } from 'pg'
import type { PendingDecisionItem } from '@openclaude/protocol'
import {
  formatPendingDecisionPush,
  type ImRemoteControlHandler,
  type ShortCodeRegistry,
} from '../pendingDecisions/index.js'
import { getQqBinding } from './store.js'

export interface QqPendingDecisionPushResult {
  outcome: 'sent' | 'skipped' | 'failed'
  reason?:
    | 'pref_off'
    | 'pref_unavailable'
    | 'no_binding'
    | 'not_connected'
    | 'short_code_registry_required'
  shortCode?: string
  text?: string
  errMessage?: string
}

export async function pushQqPendingDecision(args: {
  pool: Pool
  item: PendingDecisionItem
  sendC2cText: ((openid: string, text: string) => Promise<void>) | null
  isProactiveEnabled?: (userId: string) => Promise<boolean>
  remoteControl?: ImRemoteControlHandler
  shortCodes?: ShortCodeRegistry
  nowMs?: number
}): Promise<QqPendingDecisionPushResult> {
  // 1) Require authoritative proactive push preference (fail-closed when missing, false, or throws).
  if (!args.isProactiveEnabled) {
    return { outcome: 'skipped', reason: 'pref_unavailable' }
  }
  let enabled = false
  try {
    enabled = await args.isProactiveEnabled(args.item.userId)
  } catch {
    enabled = false
  }
  if (!enabled) {
    return { outcome: 'skipped', reason: 'pref_off' }
  }

  // 2) Require a real short-code registry; never emit a placeholder `0000`.
  if (!args.remoteControl && !args.shortCodes) {
    return {
      outcome: 'failed',
      reason: 'short_code_registry_required',
      errMessage: 'short code registry is required for proactive pending decision push',
    }
  }

  if (!args.sendC2cText) {
    return { outcome: 'skipped', reason: 'not_connected' }
  }
  const binding = await getQqBinding(args.pool, args.item.userId)
  if (!binding) {
    return { outcome: 'skipped', reason: 'no_binding' }
  }

  let shortCode: string
  let text: string
  if (args.remoteControl) {
    const formatted = args.remoteControl.formatProactivePush(args.item, { channelName: 'QQ' })
    shortCode = formatted.shortCode
    text = formatted.text
  } else {
    const expiresAtMs = args.item.expiresAt ? new Date(args.item.expiresAt).getTime() : null
    const entry = args.shortCodes!.getOrAssign(args.item.userId, args.item.id, { expiresAtMs })
    shortCode = entry.code
    text = formatPendingDecisionPush(args.item, shortCode, {
      channelName: 'QQ',
      nowMs: args.nowMs,
    })
  }

  try {
    await args.sendC2cText(binding.openid, text)
    return { outcome: 'sent', shortCode, text }
  } catch (err) {
    return {
      outcome: 'failed',
      shortCode,
      text,
      errMessage: err instanceof Error ? err.message : String(err),
    }
  }
}
