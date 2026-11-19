import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SiteAnalyticsPoint, SiteAnalyticsResponse } from './types.js'

const MAX_RETAINED_DAYS = 90
const MAX_VISITOR_HASHES_PER_DAY = 5_000
const FLUSH_INTERVAL_MS = 5_000

interface StoredAnalyticsDay {
  requests: number
  pageViews: number
  visitors: string[]
}

interface StoredAnalyticsFile {
  days: Record<string, StoredAnalyticsDay>
}

interface MemoryAnalyticsState {
  days: Map<string, { requests: number; pageViews: number; visitors: Set<string> }>
  dirty: boolean
}

function writeFileAtomic(targetPath: string, data: string): void {
  const tmp = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, data, 'utf8')
  renameSync(tmp, targetPath)
}

export function formatUtc8Date(tsMs: number): string {
  // Shift +8h cleanly to align daily traffic buckets with Asia/Taipei & Asia/Shanghai.
  return new Date(tsMs + 8 * 3600_000).toISOString().slice(0, 10)
}

export class EdgeAnalyticsStore {
  private readonly cache = new Map<string, MemoryAnalyticsState>()
  private readonly salt: string
  private readonly flushTimer: NodeJS.Timeout

  constructor(
    private readonly sitesDir: string,
    secret: string,
  ) {
    this.salt = createHmac('sha256', secret).update('oc-site-analytics-v1').digest('hex')
    this.flushTimer = setInterval(() => {
      this.flushDirty()
    }, FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  private filePathOf(slug: string): string {
    return join(this.sitesDir, slug, 'analytics.json')
  }

  private getOrLoadState(slug: string): MemoryAnalyticsState {
    const existing = this.cache.get(slug)
    if (existing) return existing

    const state: MemoryAnalyticsState = { days: new Map(), dirty: false }
    const file = this.filePathOf(slug)
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredAnalyticsFile
        if (parsed?.days && typeof parsed.days === 'object') {
          for (const [date, entry] of Object.entries(parsed.days)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !entry || typeof entry !== 'object') continue
            state.days.set(date, {
              requests: Math.max(0, Number(entry.requests || 0)),
              pageViews: Math.max(0, Number(entry.pageViews || 0)),
              visitors: new Set(
                Array.isArray(entry.visitors)
                  ? entry.visitors.filter((v): v is string => typeof v === 'string').slice(0, MAX_VISITOR_HASHES_PER_DAY)
                  : [],
              ),
            })
          }
        }
      } catch {
        /* ignore corrupt analytics cache */
      }
    }
    this.cache.set(slug, state)
    return state
  }

  private pruneOldDays(state: MemoryAnalyticsState, nowMs: number): void {
    const cutoff = formatUtc8Date(nowMs - (MAX_RETAINED_DAYS - 1) * 86_400_000)
    for (const key of state.days.keys()) {
      if (key < cutoff) {
        state.days.delete(key)
        state.dirty = true
      }
    }
  }

  recordHit(args: {
    slug: string
    clientIp: string
    userAgent: string
    isPageView: boolean
    nowMs?: number
  }): void {
    const nowMs = args.nowMs ?? Date.now()
    const date = formatUtc8Date(nowMs)
    const state = this.getOrLoadState(args.slug)
    let bucket = state.days.get(date)
    if (!bucket) {
      bucket = { requests: 0, pageViews: 0, visitors: new Set() }
      state.days.set(date, bucket)
      this.pruneOldDays(state, nowMs)
    }
    bucket.requests += 1
    if (args.isPageView) {
      bucket.pageViews += 1
    }
    if (bucket.visitors.size < MAX_VISITOR_HASHES_PER_DAY) {
      const hash = createHmac('sha256', this.salt)
        .update(`${args.clientIp}:${args.userAgent.slice(0, 120)}`)
        .digest('hex')
        .slice(0, 16)
      bucket.visitors.add(hash)
    }
    state.dirty = true
  }

  getSummary(slug: string, requestedDays = 30, nowMs = Date.now()): SiteAnalyticsResponse {
    const days = Math.max(1, Math.min(MAX_RETAINED_DAYS, Math.trunc(requestedDays || 30)))
    const state = this.getOrLoadState(slug)
    const series: SiteAnalyticsPoint[] = []
    const uniqueSet = new Set<string>()
    let totalRequests = 0
    let totalPageViews = 0

    for (let i = days - 1; i >= 0; i -= 1) {
      const date = formatUtc8Date(nowMs - i * 86_400_000)
      const bucket = state.days.get(date)
      const uniqueVisitors = bucket ? bucket.visitors.size : 0
      const requests = bucket ? bucket.requests : 0
      const pageViews = bucket ? bucket.pageViews : 0
      if (bucket) {
        for (const h of bucket.visitors) uniqueSet.add(h)
      }
      totalRequests += requests
      totalPageViews += pageViews
      series.push({ date, uniqueVisitors, requests, pageViews })
    }

    return {
      days,
      totals: {
        uniqueVisitors: uniqueSet.size,
        requests: totalRequests,
        pageViews: totalPageViews,
      },
      series,
    }
  }

  renameSlug(oldSlug: string, newSlug: string): void {
    this.flushDirty()
    const oldState = this.cache.get(oldSlug)
    if (oldState) {
      this.cache.set(newSlug, oldState)
      this.cache.delete(oldSlug)
    }
  }

  deleteSlug(slug: string): void {
    this.cache.delete(slug)
  }

  flushDirty(): void {
    for (const [slug, state] of this.cache) {
      if (!state.dirty) continue
      const dir = join(this.sitesDir, slug)
      if (!existsSync(dir)) {
        state.dirty = false
        continue
      }
      try {
        mkdirSync(dir, { recursive: true })
        const out: StoredAnalyticsFile = { days: {} }
        for (const [date, entry] of state.days) {
          out.days[date] = {
            requests: entry.requests,
            pageViews: entry.pageViews,
            visitors: [...entry.visitors],
          }
        }
        writeFileAtomic(this.filePathOf(slug), JSON.stringify(out))
        state.dirty = false
      } catch {
        /* ignore transient write failure; will retry on next flush */
      }
    }
  }

  close(): void {
    clearInterval(this.flushTimer)
    this.flushDirty()
  }
}
