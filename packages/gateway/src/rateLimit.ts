/**
 * In-memory sliding-window rate limiter for the OpenClaude gateway.
 *
 * Per-peer (channel + peerId) message rate limiting.
 * No external dependencies — uses a Map with periodic cleanup.
 */

import { createLogger } from './logger.js'

const log = createLogger({ module: 'rateLimit' })

interface WindowEntry {
  /** Timestamps of requests within the current window */
  timestamps: number[]
}

export interface RateLimitConfig {
  /** Maximum requests per window (default: 30) */
  maxRequests: number
  /** Window duration in ms (default: 60_000 = 1 minute) */
  windowMs: number
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60_000,
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>()
  private config: RateLimitConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Check if a request should be allowed. Returns true if allowed, false if rate-limited.
   * Automatically records the request if allowed.
   */
  check(peerId: string, channel: string): boolean {
    const key = `${channel}:${peerId}`
    const now = Date.now()
    const windowStart = now - this.config.windowMs

    let entry = this.windows.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      this.windows.set(key, entry)
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(t => t > windowStart)

    if (entry.timestamps.length >= this.config.maxRequests) {
      log.warn('rate limited', { peerId, channel, count: entry.timestamps.length })
      return false
    }

    entry.timestamps.push(now)
    return true
  }

  /** Get remaining requests for a peer within the current window. */
  remaining(peerId: string, channel: string): number {
    const key = `${channel}:${peerId}`
    const now = Date.now()
    const windowStart = now - this.config.windowMs
    const entry = this.windows.get(key)
    if (!entry) return this.config.maxRequests
    const active = entry.timestamps.filter(t => t > windowStart).length
    return Math.max(0, this.config.maxRequests - active)
  }

  /** Start periodic cleanup of expired entries (call once at startup). */
  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      const windowStart = now - this.config.windowMs
      for (const [key, entry] of this.windows) {
        entry.timestamps = entry.timestamps.filter(t => t > windowStart)
        if (entry.timestamps.length === 0) {
          this.windows.delete(key)
        }
      }
    }, intervalMs)
    // Don't prevent process exit
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }
}
