import { createHash, randomBytes } from 'node:crypto'

import {
  type ContainerPreviewViewport,
  normalizeContainerPreviewUrl,
  normalizeContainerPreviewViewport,
} from '@openclaude/protocol'

const TICKET_BYTES = 24
export const CONTAINER_PREVIEW_TICKET_CHARS = 32
export const CONTAINER_PREVIEW_TICKET_TTL_MS = 30_000
const MAX_PENDING_TICKETS = 512

export interface ContainerPreviewTicketRecord {
  readonly uid: bigint
  readonly url: string
  readonly viewport: ContainerPreviewViewport
  readonly expiresAt: number
}

export interface IssuedContainerPreviewTicket extends ContainerPreviewTicketRecord {
  readonly ticket: string
}

export class ContainerPreviewTicketStore {
  private readonly records = new Map<string, ContainerPreviewTicketRecord>()
  private readonly keyByUid = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(
    uid: bigint,
    rawUrl: string,
    rawViewport: Partial<ContainerPreviewViewport> | null | undefined,
  ): IssuedContainerPreviewTicket {
    if (uid <= 0n) throw new Error('invalid preview ticket uid')
    this.prune(this.now())
    const normalized = normalizeContainerPreviewUrl(rawUrl)
    const viewport = normalizeContainerPreviewViewport(rawViewport)
    const ticket = randomBytes(TICKET_BYTES).toString('base64url')
    const key = ticketKey(ticket)
    const uidKey = uid.toString()
    const prior = this.keyByUid.get(uidKey)
    if (prior) this.records.delete(prior)

    const record: ContainerPreviewTicketRecord = {
      uid,
      url: normalized.url,
      viewport,
      expiresAt: this.now() + CONTAINER_PREVIEW_TICKET_TTL_MS,
    }
    this.records.set(key, record)
    this.keyByUid.set(uidKey, key)
    this.enforceCap()
    return { ticket, ...record }
  }

  /** Synchronous delete-before-return gives one-time atomic consumption. */
  consume(ticket: string): ContainerPreviewTicketRecord | null {
    if (!new RegExp(`^[A-Za-z0-9_-]{${CONTAINER_PREVIEW_TICKET_CHARS}}$`).test(ticket)) return null
    const now = this.now()
    this.prune(now)
    const key = ticketKey(ticket)
    const record = this.records.get(key)
    if (!record) return null
    this.records.delete(key)
    if (this.keyByUid.get(record.uid.toString()) === key)
      this.keyByUid.delete(record.uid.toString())
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
      if (this.keyByUid.get(record.uid.toString()) === key)
        this.keyByUid.delete(record.uid.toString())
    }
  }

  private enforceCap(): void {
    if (this.records.size <= MAX_PENDING_TICKETS) return
    const oldest = [...this.records.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    for (let i = 0; i < oldest.length - MAX_PENDING_TICKETS; i++) {
      const [key, record] = oldest[i]!
      this.records.delete(key)
      if (this.keyByUid.get(record.uid.toString()) === key)
        this.keyByUid.delete(record.uid.toString())
    }
  }
}

function ticketKey(ticket: string): string {
  return createHash('sha256').update(ticket, 'ascii').digest('hex')
}
