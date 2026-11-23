/**
 * Short-lived one-time WebSocket tickets for public `/ws/live-browser` upgrades (OCV5-857).
 *
 * Each ticket is bound to `(uid, agentId)`, expires after 30s, and is consumed atomically
 * via delete-before-return before any async container lookup or dial begins.
 */
import { createHash, randomBytes } from 'node:crypto'

const TICKET_BYTES = 24
export const LIVE_BROWSER_TICKET_CHARS = 32
export const LIVE_BROWSER_TICKET_TTL_MS = 30_000
const MAX_PENDING_TICKETS = 512
const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/

export interface LiveBrowserTicketRecord {
  readonly uid: bigint
  readonly agentId: string
  readonly expiresAt: number
}

export interface IssuedLiveBrowserTicket extends LiveBrowserTicketRecord {
  readonly ticket: string
}

export class LiveBrowserTicketStore {
  private readonly records = new Map<string, LiveBrowserTicketRecord>()
  private readonly keyBySlot = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(uid: bigint, rawAgentId: string): IssuedLiveBrowserTicket {
    if (uid <= 0n) throw new Error('invalid live browser ticket uid')
    const agentId = rawAgentId.trim()
    if (!AGENT_ID_RE.test(agentId)) {
      throw new Error('invalid live browser agentId')
    }
    const now = this.now()
    this.prune(now)

    const ticket = randomBytes(TICKET_BYTES).toString('base64url')
    const key = ticketKey(ticket)
    const slot = slotKey(uid, agentId)
    const prior = this.keyBySlot.get(slot)
    if (prior) this.records.delete(prior)

    const record: LiveBrowserTicketRecord = {
      uid,
      agentId,
      expiresAt: now + LIVE_BROWSER_TICKET_TTL_MS,
    }
    this.records.set(key, record)
    this.keyBySlot.set(slot, key)
    this.enforceCap()
    return { ticket, ...record }
  }

  /** Synchronous delete-before-return gives one-time atomic consumption. */
  consume(ticket: string): LiveBrowserTicketRecord | null {
    if (!new RegExp(`^[A-Za-z0-9_-]{${LIVE_BROWSER_TICKET_CHARS}}$`).test(ticket)) return null
    const now = this.now()
    this.prune(now)
    const key = ticketKey(ticket)
    const record = this.records.get(key)
    if (!record) return null
    this.records.delete(key)
    const slot = slotKey(record.uid, record.agentId)
    if (this.keyBySlot.get(slot) === key) {
      this.keyBySlot.delete(slot)
    }
    if (record.expiresAt <= now) return null
    return record
  }

  get size(): number {
    this.prune(this.now())
    return this.records.size
  }

  private prune(now: number): void {
    for (const [key, record] of this.records) {
      if (record.expiresAt > now) continue
      this.records.delete(key)
      const slot = slotKey(record.uid, record.agentId)
      if (this.keyBySlot.get(slot) === key) {
        this.keyBySlot.delete(slot)
      }
    }
  }

  private enforceCap(): void {
    if (this.records.size <= MAX_PENDING_TICKETS) return
    const oldest = [...this.records.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    for (let i = 0; i < oldest.length - MAX_PENDING_TICKETS; i++) {
      const [key, record] = oldest[i]!
      this.records.delete(key)
      const slot = slotKey(record.uid, record.agentId)
      if (this.keyBySlot.get(slot) === key) {
        this.keyBySlot.delete(slot)
      }
    }
  }
}

function slotKey(uid: bigint, agentId: string): string {
  return `${uid.toString()}:${agentId}`
}

function ticketKey(ticket: string): string {
  return createHash('sha256').update(ticket, 'ascii').digest('hex')
}
