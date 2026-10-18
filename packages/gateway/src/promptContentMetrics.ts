import { estimateModelHistoryTokens } from '@openclaude/protocol'

export interface PromptContentMetrics {
  readonly bytes: number
  readonly sha256: string
  readonly tokensEstimate: number
}

async function deriveMetrics(content: string): Promise<Readonly<PromptContentMetrics>> {
  const data = new TextEncoder().encode(content)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Object.freeze({
    bytes: data.byteLength,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    tokensEstimate: estimateModelHistoryTokens(content),
  })
}

/** Only pure derivatives of a complete, already-read string. No source/authority cache. */
export class PromptContentMetricsCache {
  private readonly entries = new Map<string, {
    bytes: number
    value: Promise<Readonly<PromptContentMetrics>>
  }>()
  private retainedBytes = 0

  constructor(private readonly maxEntries = 128, private readonly maxBytes = 2 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Invalid prompt metrics cache limits')
    }
  }

  get(content: string): Promise<Readonly<PromptContentMetrics>> {
    const found = this.entries.get(content)
    if (found) {
      this.entries.delete(content)
      this.entries.set(content, found)
      return found.value
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (this.maxEntries === 0 || bytes > this.maxBytes) return deriveMetrics(content)
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.retainedBytes -= oldest[1].bytes
    }
    const entry = { bytes, value: deriveMetrics(content) }
    entry.value = entry.value.catch((error: unknown) => {
      // An evicted in-flight calculation must never delete/repopulate a newer entry.
      if (this.entries.get(content) === entry) {
        this.entries.delete(content)
        this.retainedBytes -= bytes
      }
      throw error
    })
    this.entries.set(content, entry)
    this.retainedBytes += bytes
    return entry.value
  }

  get size(): Readonly<{ entries: number; bytes: number }> {
    return { entries: this.entries.size, bytes: this.retainedBytes }
  }
}

export const promptContentMetrics = new PromptContentMetricsCache()
