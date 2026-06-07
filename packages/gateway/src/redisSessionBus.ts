import { randomUUID } from 'node:crypto'

import type { ClientSession, ClientSessionMeta, OpenClaudeConfig } from '@openclaude/storage'

export interface RedisFrameEnvelope {
  originId: string
  sessionKey: string
  peerKey: string
  frameSeq: number
  ts: number
  data: string
}

export type RedisReplayResult =
  | {
      ok: true
      frames: Array<{ seq: number; ts: number; data: string }>
      to: number
    }
  | {
      ok: false
      frames: never[]
      to: number
      reason: 'disabled' | 'no_buffer' | 'buffer_miss' | 'sequence_mismatch'
    }

export interface RedisSessionBusOptions {
  config?: OpenClaudeConfig['gateway']['redis']
  env?: NodeJS.ProcessEnv
  log?: {
    info?: (message: string, meta?: Record<string, unknown>) => void
    warn?: (message: string, meta?: Record<string, unknown>, err?: unknown) => void
    debug?: (message: string, meta?: Record<string, unknown>) => void
  }
  originId?: string
  createClient?: (opts: { url: string }) => any
}

type RedisFrameHandler = (frame: RedisFrameEnvelope) => void

const DEFAULT_PREFIX = 'openclaude:personal:sessionbus'
const DEFAULT_REPLAY_TTL_MS = 30 * 60_000
const DEFAULT_MAX_REPLAY_FRAMES = 2000
const DEFAULT_RESERVE_TIMEOUT_MS = 50
const DEFAULT_SESSION_CACHE_TTL_MS = 60_000
const DEFAULT_MAX_SESSION_SNAPSHOT_BYTES = 2_000_000

export class RedisSessionBus {
  readonly enabled: boolean
  readonly originId: string
  readonly url: string
  readonly keyPrefix: string
  readonly replayTtlMs: number
  readonly maxReplayFrames: number
  readonly reserveTimeoutMs: number
  readonly sessionCacheTtlMs: number
  readonly maxSessionSnapshotBytes: number

  private pub: any = null
  private sub: any = null
  private started = false
  private handler: RedisFrameHandler | null = null

  constructor(private readonly opts: RedisSessionBusOptions = {}) {
    const cfg = opts.config ?? {}
    this.enabled = cfg.enabled === true
    this.originId = opts.originId ?? randomUUID()
    this.url = cfg.url || opts.env?.OPENCLAUDE_REDIS_URL || 'redis://127.0.0.1:6379'
    this.keyPrefix = sanitizePrefix(
      cfg.keyPrefix || opts.env?.OPENCLAUDE_REDIS_PREFIX || DEFAULT_PREFIX,
    )
    this.replayTtlMs = Math.max(1000, cfg.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS)
    this.maxReplayFrames = Math.max(1, cfg.maxReplayFrames ?? DEFAULT_MAX_REPLAY_FRAMES)
    this.reserveTimeoutMs = Math.max(1, cfg.reserveTimeoutMs ?? DEFAULT_RESERVE_TIMEOUT_MS)
    this.sessionCacheTtlMs = Math.max(1000, cfg.sessionCacheTtlMs ?? DEFAULT_SESSION_CACHE_TTL_MS)
    this.maxSessionSnapshotBytes = Math.max(
      1024,
      cfg.maxSessionSnapshotBytes ?? DEFAULT_MAX_SESSION_SNAPSHOT_BYTES,
    )
  }

  async start(handler: RedisFrameHandler): Promise<void> {
    this.handler = handler
    if (!this.enabled || this.started) return
    try {
      const createClient = this.opts.createClient ?? (await import('redis')).createClient
      this.pub = createClient({ url: this.url })
      this.sub = createClient({ url: this.url })
      this.pub.on?.('error', (err: unknown) =>
        this.opts.log?.warn?.('redis session bus publisher error', undefined, err),
      )
      this.sub.on?.('error', (err: unknown) =>
        this.opts.log?.warn?.('redis session bus subscriber error', undefined, err),
      )
      await this.pub.connect()
      await this.sub.connect()
      await this.sub.subscribe(this.channelKey(), (raw: string) => this.onMessage(raw))
      this.started = true
      this.opts.log?.info?.('redis session bus enabled', {
        keyPrefix: this.keyPrefix,
        maxReplayFrames: this.maxReplayFrames,
        replayTtlMs: this.replayTtlMs,
      })
    } catch (err) {
      this.started = false
      this.opts.log?.warn?.(
        'redis session bus unavailable; continuing without redis acceleration',
        undefined,
        err,
      )
      await this.close()
    }
  }

  async close(): Promise<void> {
    const clients = [this.sub, this.pub]
    this.sub = null
    this.pub = null
    this.started = false
    await Promise.allSettled(
      clients.filter(Boolean).map(async (client) => {
        try {
          if (client.isOpen || client.isReady) await client.quit()
          else await client.disconnect?.()
        } catch {
          try {
            await client.disconnect?.()
          } catch {}
        }
      }),
    )
  }

  async reserveFrameSeq(sessionKey: string): Promise<number | null> {
    if (!this.started || !this.pub) return null
    return withTimeout(
      (async () => {
        const seq = await this.pub.incr(this.seqKey(sessionKey))
        if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return null
        await this.pub.pExpire(this.seqKey(sessionKey), this.replayTtlMs).catch(() => {})
        return seq
      })().catch(() => null),
      this.reserveTimeoutMs,
      null,
    )
  }

  async advanceFrameSeq(
    sessionKey: string,
    observedSeq: number,
    minExclusiveSeq: number,
  ): Promise<number | null> {
    if (!this.started || !this.pub || observedSeq > minExclusiveSeq) return null
    const delta = minExclusiveSeq - observedSeq + 1
    if (!Number.isFinite(delta) || delta <= 0) return null
    return withTimeout(
      (async () => {
        const seq = await this.pub.incrBy(this.seqKey(sessionKey), delta)
        if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= minExclusiveSeq) return null
        await this.pub.pExpire(this.seqKey(sessionKey), this.replayTtlMs).catch(() => {})
        return seq
      })().catch(() => null),
      this.reserveTimeoutMs,
      null,
    )
  }

  publishFrame(input: Omit<RedisFrameEnvelope, 'originId'>): void {
    if (!this.started || !this.pub) return
    const envelope: RedisFrameEnvelope = { ...input, originId: this.originId }
    void this.publishFrameAsync(envelope).catch((err) => {
      this.opts.log?.debug?.('redis session bus publish failed', {
        error: String((err as Error)?.message ?? err),
      })
    })
  }

  async replay(sessionKey: string, afterSeq: number): Promise<RedisReplayResult> {
    if (!this.started || !this.pub) return { ok: false, frames: [], to: 0, reason: 'disabled' }
    try {
      const rawItems = await withTimeout(
        (this.pub.lRange(this.replayKey(sessionKey), 0, -1) as Promise<string[]>).catch(() => null),
        this.reserveTimeoutMs,
        null,
      )
      if (!rawItems) return { ok: false, frames: [], to: 0, reason: 'disabled' }
      const parsed = rawItems
        .map(parseEnvelope)
        .filter((x: RedisFrameEnvelope | null): x is RedisFrameEnvelope => !!x)
      return validateReplay(parsed, afterSeq)
    } catch {
      return { ok: false, frames: [], to: 0, reason: 'disabled' }
    }
  }

  async getSessionList(userId: string): Promise<ClientSessionMeta[] | null> {
    const raw = await this.getCacheValue(this.sessionListKey(userId))
    if (!raw) return null
    const parsed = parseSessionListCache(raw, userId)
    return parsed?.sessions ?? null
  }

  setSessionList(userId: string, sessions: ClientSessionMeta[]): void {
    const payload = JSON.stringify({
      version: 1,
      userId,
      ts: Date.now(),
      sessions,
    })
    this.setCacheValue(this.sessionListKey(userId), payload)
  }

  async getClientSession(userId: string, sessId: string): Promise<ClientSession | null> {
    const raw = await this.getCacheValue(this.clientSessionKey(userId, sessId))
    if (!raw) return null
    const parsed = parseClientSessionCache(raw, userId, sessId)
    return parsed?.session ?? null
  }

  setClientSession(userId: string, session: ClientSession): void {
    if (session.userId !== userId) return
    const payload = JSON.stringify({
      version: 1,
      userId,
      id: session.id,
      ts: Date.now(),
      session,
    })
    if (Buffer.byteLength(payload, 'utf8') > this.maxSessionSnapshotBytes) return
    this.setCacheValue(this.clientSessionKey(userId, session.id), payload)
  }

  deleteClientSessionCache(userId: string, sessId: string): void {
    this.deleteCacheKeys(this.clientSessionKey(userId, sessId))
  }

  invalidateSessionList(userId: string): void {
    this.deleteCacheKeys(this.sessionListKey(userId))
  }

  invalidateClientSession(userId: string, sessId: string): void {
    this.deleteCacheKeys(this.clientSessionKey(userId, sessId), this.sessionListKey(userId))
  }

  clearClientSessionCache(): void {
    if (!this.started || !this.pub) return
    void (async () => {
      const pattern = `${this.keyPrefix}:client:*`
      const keys: string[] = []
      if (typeof this.pub.scanIterator === 'function') {
        for await (const key of this.pub.scanIterator({
          MATCH: pattern,
          COUNT: 100,
        })) {
          keys.push(String(key))
        }
      }
      if (keys.length > 0) await this.pub.del(keys)
    })().catch((err) => {
      this.opts.log?.debug?.('redis session cache clear failed', {
        error: String((err as Error)?.message ?? err),
      })
    })
  }

  private async getCacheValue(key: string): Promise<string | null> {
    if (!this.started || !this.pub) return null
    return withTimeout(
      (async () => {
        const value = await this.pub.get(key)
        return typeof value === 'string' ? value : null
      })().catch(() => null),
      this.reserveTimeoutMs,
      null,
    )
  }

  private setCacheValue(key: string, value: string): void {
    if (!this.started || !this.pub) return
    void this.pub.pSetEx(key, this.sessionCacheTtlMs, value).catch((err: unknown) => {
      this.opts.log?.debug?.('redis session cache set failed', {
        error: String((err as Error)?.message ?? err),
      })
    })
  }

  private deleteCacheKeys(...keys: string[]): void {
    if (!this.started || !this.pub || keys.length === 0) return
    void this.pub.del(keys).catch((err: unknown) => {
      this.opts.log?.debug?.('redis session cache delete failed', {
        error: String((err as Error)?.message ?? err),
      })
    })
  }

  private async publishFrameAsync(envelope: RedisFrameEnvelope): Promise<void> {
    const payload = JSON.stringify(envelope)
    const key = this.replayKey(envelope.sessionKey)
    await this.pub.rPush(key, payload)
    await this.pub.lTrim(key, -this.maxReplayFrames, -1)
    await this.pub.pExpire(key, this.replayTtlMs)
    await this.pub.publish(this.channelKey(), payload)
  }

  private onMessage(raw: string): void {
    const frame = parseEnvelope(raw)
    if (!frame || frame.originId === this.originId) return
    if (!isSafePeerKey(frame.peerKey) || !isSafeJsonFrame(frame.data)) return
    this.handler?.(frame)
  }

  private channelKey(): string {
    return `${this.keyPrefix}:frames`
  }

  private sessionListKey(userId: string): string {
    return `${this.keyPrefix}:client:list:${encodeKey(userId)}`
  }

  private clientSessionKey(userId: string, sessId: string): string {
    return `${this.keyPrefix}:client:session:${encodeKey(userId)}:${encodeKey(sessId)}`
  }

  private replayKey(sessionKey: string): string {
    return `${this.keyPrefix}:replay:${encodeKey(sessionKey)}`
  }

  private seqKey(sessionKey: string): string {
    return `${this.keyPrefix}:seq:${encodeKey(sessionKey)}`
  }
}

export function validateReplay(frames: RedisFrameEnvelope[], afterSeq: number): RedisReplayResult {
  const valid = frames
    .filter((f) => Number.isFinite(f.frameSeq) && f.frameSeq > 0 && envelopeMatchesWireFrame(f))
    .sort((a, b) => a.frameSeq - b.frameSeq)
  if (valid.length === 0) {
    return afterSeq === 0
      ? { ok: true, frames: [], to: 0 }
      : { ok: false, frames: [], to: 0, reason: 'no_buffer' }
  }

  const seen = new Set<number>()
  for (const f of valid) {
    if (seen.has(f.frameSeq)) {
      return {
        ok: false,
        frames: [],
        to: valid.at(-1)?.frameSeq ?? 0,
        reason: 'sequence_mismatch',
      }
    }
    seen.add(f.frameSeq)
  }

  const to = valid[valid.length - 1].frameSeq
  if (afterSeq > to) return { ok: false, frames: [], to, reason: 'sequence_mismatch' }
  if (afterSeq === to) return { ok: true, frames: [], to }

  const replay = valid.filter((f) => f.frameSeq > afterSeq)
  if (replay.length === 0) return { ok: true, frames: [], to }
  if (replay[0].frameSeq !== afterSeq + 1) {
    return { ok: false, frames: [], to, reason: 'buffer_miss' }
  }
  for (let i = 1; i < replay.length; i++) {
    if (replay[i].frameSeq !== replay[i - 1].frameSeq + 1) {
      return { ok: false, frames: [], to, reason: 'sequence_mismatch' }
    }
  }
  return {
    ok: true,
    frames: replay.map((f) => ({ seq: f.frameSeq, ts: f.ts, data: f.data })),
    to,
  }
}

function parseEnvelope(raw: string): RedisFrameEnvelope | null {
  try {
    const obj = JSON.parse(raw) as RedisFrameEnvelope
    if (!obj || typeof obj !== 'object') return null
    if (typeof obj.originId !== 'string' || typeof obj.sessionKey !== 'string') return null
    if (typeof obj.peerKey !== 'string' || typeof obj.data !== 'string') return null
    if (!Number.isFinite(obj.frameSeq) || obj.frameSeq <= 0) return null
    if (!Number.isFinite(obj.ts) || obj.ts <= 0) return null
    if (!envelopeMatchesWireFrame(obj)) return null
    return obj
  } catch {
    return null
  }
}

function isSafeJsonFrame(data: string): boolean {
  return parseWireFrame(data) !== null
}

function parseWireFrame(data: string): Record<string, any> | null {
  try {
    const obj = JSON.parse(data)
    return !!obj && typeof obj === 'object' && typeof obj.type === 'string' ? obj : null
  } catch {
    return null
  }
}

function isSafePeerKey(peerKey: string): boolean {
  return peerKey.length > 0 && peerKey.length < 2048 && !/[\r\n]/.test(peerKey)
}

function envelopeMatchesWireFrame(envelope: RedisFrameEnvelope): boolean {
  if (!isSafePeerKey(envelope.peerKey)) return false
  const wire = parseWireFrame(envelope.data)
  if (!wire) return false
  if (wire.sessionKey !== envelope.sessionKey) return false
  if (wire.frameSeq !== envelope.frameSeq) return false
  if (typeof wire.channel !== 'string') return false
  const peerId = wire.peer && typeof wire.peer === 'object' ? wire.peer.id : null
  if (typeof peerId !== 'string') return false
  return envelope.peerKey.endsWith(`:${wire.channel}:${peerId}`)
}

function encodeKey(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url')
}

function sanitizePrefix(prefix: string): string {
  return prefix.replace(/[^a-zA-Z0-9:_-]/g, '_').replace(/^:+|:+$/g, '') || DEFAULT_PREFIX
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseSessionListCache(
  raw: string,
  userId: string,
): { sessions: ClientSessionMeta[] } | null {
  try {
    const obj = JSON.parse(raw) as {
      version?: unknown
      userId?: unknown
      sessions?: unknown
    }
    if (!obj || obj.version !== 1 || obj.userId !== userId || !Array.isArray(obj.sessions))
      return null
    if (!obj.sessions.every(isClientSessionMeta)) return null
    return { sessions: obj.sessions as ClientSessionMeta[] }
  } catch {
    return null
  }
}

function parseClientSessionCache(
  raw: string,
  userId: string,
  sessId: string,
): { session: ClientSession } | null {
  try {
    const obj = JSON.parse(raw) as {
      version?: unknown
      userId?: unknown
      id?: unknown
      session?: unknown
    }
    if (!obj || obj.version !== 1 || obj.userId !== userId || obj.id !== sessId) return null
    if (!isClientSession(obj.session)) return null
    const session = obj.session as ClientSession
    if (session.userId !== userId || session.id !== sessId) return null
    return { session }
  } catch {
    return null
  }
}

function isClientSessionMeta(x: unknown): x is ClientSessionMeta {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.agentId === 'string' &&
    typeof o.title === 'string' &&
    typeof o.pinned === 'boolean' &&
    typeof o.createdAt === 'number' &&
    typeof o.lastAt === 'number' &&
    typeof o.messageCount === 'number' &&
    typeof o.updatedAt === 'number'
  )
}

function isClientSession(x: unknown): x is ClientSession {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.userId === 'string' &&
    typeof o.agentId === 'string' &&
    typeof o.title === 'string' &&
    typeof o.pinned === 'boolean' &&
    typeof o.createdAt === 'number' &&
    typeof o.lastAt === 'number' &&
    Array.isArray(o.messages) &&
    typeof o.updatedAt === 'number'
  )
}
