// Pairing flow — fetches a QR code and long-polls for confirmation.
//
// Called by the Web UI Settings panel (Stage 3) via a gateway HTTP route:
//   POST /api/wechat/pair/start   → { qrcode, qrcodeImgContent }
//   POST /api/wechat/pair/poll    → { status: 'waiting'|'confirmed', binding? }
//
// Internal state is kept in memory per qrcode key. A qrcode is single-use
// and expires once WeChat's server does (~2-3min), so we don't persist.

import {
  extractConfirmed,
  fetchIlinkQrcode,
  type IlinkConfirmed,
  type IlinkQrcode,
  pollIlinkQrcodeStatus,
} from './iLink.js'
import { upsertWechatBinding } from '@openclaude/storage'

interface PendingPair {
  qrcode: string
  qrcodeImgContent: string
  createdAt: number
  userId: string
}

const PENDING: Map<string, PendingPair> = new Map()
const PAIR_TTL_MS = 10 * 60_000

function gc() {
  const now = Date.now()
  for (const [k, v] of PENDING.entries()) {
    if (now - v.createdAt > PAIR_TTL_MS) PENDING.delete(k)
  }
}

export interface PairingStart {
  qrcode: string
  qrcodeImgContent: string
}

/** Issue a new QR code for the given OC user. Caller renders the PNG. */
export async function startPairing(userId: string): Promise<PairingStart> {
  gc()
  const q: IlinkQrcode = await fetchIlinkQrcode()
  PENDING.set(q.qrcode, {
    qrcode: q.qrcode,
    qrcodeImgContent: q.qrcode_img_content,
    createdAt: Date.now(),
    userId,
  })
  return { qrcode: q.qrcode, qrcodeImgContent: q.qrcode_img_content }
}

export type PairStatus =
  | { status: 'waiting' }
  | { status: 'scanned' }
  | { status: 'expired' }
  | { status: 'confirmed'; accountId: string; loginUserId: string }

/**
 * Poll the QR status ONCE (long-poll up to ~35s server-side). On confirmed,
 * we upsert the binding row and return its identifiers. Caller is expected
 * to keep calling this in a loop until status != 'waiting'/'scanned'.
 */
export async function resumePairing(userId: string, qrcode: string): Promise<PairStatus> {
  // Enforce the 10-min TTL on every poll, not just startPairing. Without
  // this, an abandoned qrcode lingers in memory and stays 'waiting' forever.
  gc()
  const pending = PENDING.get(qrcode)
  if (!pending) return { status: 'expired' }
  if (pending.userId !== userId) return { status: 'expired' }
  if (Date.now() - pending.createdAt > PAIR_TTL_MS) {
    PENDING.delete(qrcode)
    return { status: 'expired' }
  }

  let resp: any
  try {
    resp = await pollIlinkQrcodeStatus(qrcode)
  } catch (err: any) {
    // Distinguish transient network timeout (normal for long-poll, retry) from
    // permanent upstream rejection (HTTP 4xx/5xx, qrcode session gone). Any
    // non-timeout failure drops the pending pair so the caller shows "expired"
    // and prompts a rescan instead of looping forever.
    const msg = String(err?.message || err || '')
    const isTimeout =
      err?.name === 'AbortError' ||
      err?.name === 'TimeoutError' ||
      /timeout|timed ?out|ETIMEDOUT|ECONNRESET|aborted/i.test(msg)
    if (isTimeout) return { status: 'waiting' }
    PENDING.delete(qrcode)
    return { status: 'expired' }
  }

  const confirmed: IlinkConfirmed | null = extractConfirmed(resp)
  if (!confirmed) {
    const statusStr = String(resp?.status || '').toLowerCase()
    if (statusStr === 'scanned') return { status: 'scanned' }
    if (statusStr === 'expired') {
      PENDING.delete(qrcode)
      return { status: 'expired' }
    }
    return { status: 'waiting' }
  }

  // Persist binding. Whitelist is intentionally empty — we no longer gate
  // senders at the manager layer (any WeChat account that can reach the bot
  // can talk to it). The column is retained for backward compatibility /
  // future use but carries no runtime meaning.
  await upsertWechatBinding({
    userId,
    accountId: confirmed.account_id,
    loginUserId: confirmed.login_user_id,
    botToken: confirmed.bot_token,
    whitelist: [],
    status: 'active',
  })
  PENDING.delete(qrcode)
  return {
    status: 'confirmed',
    accountId: confirmed.account_id,
    loginUserId: confirmed.login_user_id,
  }
}

export function cancelPairing(qrcode: string): void {
  PENDING.delete(qrcode)
}
