/**
 * Proactive WeChat push formatter & delivery helper for Pending Decision events.
 *
 * Security invariants (B7):
 *   - Binding lookup normalizes `c:<uid>` (SQLite key) and verifies owner matches `item.userId`.
 *   - Respects user proactive push preference (`isProactiveEnabled`, fail-closed).
 *   - Verifies binding is active AND sends ONLY to the bound owner's `loginUserId`
 *     (never falls back to the first entry in `contextTokens`).
 *   - Requires a real `ShortCodeRegistry` (via `remoteControl` or `shortCodes`); never emits `0000`.
 */

import type { PendingDecisionItem } from '@openclaude/protocol'
import {
  formatPendingDecisionPush,
  type ImRemoteControlHandler,
  type ShortCodeRegistry,
} from '../pendingDecisions/index.js'
import type { GetBindingFn, SendTextFn } from './outboxWorker.js'
import { canonicalWechatSenderId } from './proactiveReceiver.js'
import { MASTER_USER_PREFIX } from './userIds.js'

export interface WechatPendingDecisionPushResult {
  outcome: 'sent' | 'skipped' | 'failed'
  reason?:
    | 'pref_off'
    | 'pref_unavailable'
    | 'no_binding'
    | 'inactive_binding'
    | 'missing_owner_login'
    | 'no_context_token'
    | 'owner_mismatch'
    | 'short_code_registry_required'
  shortCode?: string
  text?: string
  errMessage?: string
}

function stripMasterPrefix(uid: string): string {
  return uid.startsWith(MASTER_USER_PREFIX) ? uid.slice(MASTER_USER_PREFIX.length) : uid
}

export async function pushWechatPendingDecision(args: {
  item: PendingDecisionItem
  bindingUserId?: string
  getBinding: GetBindingFn
  sendText: SendTextFn
  isProactiveEnabled?: (userId: string) => Promise<boolean>
  remoteControl?: ImRemoteControlHandler
  shortCodes?: ShortCodeRegistry
  nowMs?: number
}): Promise<WechatPendingDecisionPushResult> {
  const itemOwnerUid = stripMasterPrefix(args.item.userId.trim())
  if (args.bindingUserId !== undefined) {
    const requestedUid = stripMasterPrefix(args.bindingUserId.trim())
    if (requestedUid !== itemOwnerUid) {
      return { outcome: 'skipped', reason: 'owner_mismatch' }
    }
  }

  // 1) Require authoritative proactive push preference (fail-closed when missing, false, or throws).
  if (!args.isProactiveEnabled) {
    return { outcome: 'skipped', reason: 'pref_unavailable' }
  }
  let enabled = false
  try {
    enabled = await args.isProactiveEnabled(itemOwnerUid)
  } catch {
    enabled = false
  }
  if (!enabled) {
    return { outcome: 'skipped', reason: 'pref_off' }
  }

  // 2) Require a real short-code registry; never fabricate a placeholder code like `0000`.
  if (!args.remoteControl && !args.shortCodes) {
    return {
      outcome: 'failed',
      reason: 'short_code_registry_required',
      errMessage: 'short code registry is required for proactive pending decision push',
    }
  }

  // 3) Commercial namespace strictly queries canonical `c:<uid>` key (never falls back to legacy bare uid)
  //    and explicitly requires `status === 'active'`.
  const canonicalKey = `${MASTER_USER_PREFIX}${itemOwnerUid}`
  const binding = await args.getBinding(canonicalKey)
  if (!binding) {
    return { outcome: 'skipped', reason: 'no_binding' }
  }
  if (binding.status !== 'active') {
    return { outcome: 'skipped', reason: 'inactive_binding' }
  }

  // 4) Deliver ONLY to the bound owner's `loginUserId`. Never fall back to another contact's token.
  const ownerLoginRaw = binding.loginUserId?.trim()
  if (!ownerLoginRaw) {
    return { outcome: 'skipped', reason: 'missing_owner_login' }
  }
  const ownerSenderId = canonicalWechatSenderId(ownerLoginRaw)
  const contextToken =
    binding.contextTokens[ownerSenderId] ?? binding.contextTokens[ownerLoginRaw]
  if (!contextToken) {
    return { outcome: 'skipped', reason: 'no_context_token' }
  }

  let shortCode: string
  let text: string
  if (args.remoteControl) {
    const formatted = args.remoteControl.formatProactivePush(args.item, { channelName: '微信' })
    shortCode = formatted.shortCode
    text = formatted.text
  } else {
    const expiresAtMs = args.item.expiresAt ? new Date(args.item.expiresAt).getTime() : null
    const entry = args.shortCodes!.getOrAssign(itemOwnerUid, args.item.id, { expiresAtMs })
    shortCode = entry.code
    text = formatPendingDecisionPush(args.item, shortCode, {
      channelName: '微信',
      nowMs: args.nowMs,
    })
  }

  const sendResult = await args.sendText({
    botToken: binding.botToken,
    toUserId: ownerSenderId,
    contextToken,
    text,
    clientId: `pd:${args.item.id}:${shortCode}`.slice(0, 64),
  })
  if (!sendResult.ok) {
    return {
      outcome: 'failed',
      shortCode,
      text,
      errMessage: sendResult.errMessage,
    }
  }
  return { outcome: 'sent', shortCode, text }
}
