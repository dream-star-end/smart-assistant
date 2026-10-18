import { estimateModelHistoryTokens } from '@openclaude/protocol'

export interface PromptContentMetrics {
  readonly bytes: number
  readonly sha256: Promise<string>
  readonly tokensEstimate: number
}

async function deriveSha256(content: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Pure derivatives only. Lazy access preserves the caller's original work/timing boundaries. */
export class PromptContentMetricsCache {
  private readonly entries = new Map<string, { bytes: number; value: Readonly<PromptContentMetrics> }>()
  private retainedBytes = 0

  constructor(private readonly maxEntries = 128, private readonly maxBytes = 2 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('Invalid prompt metrics cache limits')
    }
  }

  get(content: string): Readonly<PromptContentMetrics> {
    const found = this.entries.get(content)
    if (found) {
      this.entries.delete(content)
      this.entries.set(content, found)
      return found.value
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    let sha256: Promise<string> | undefined
    let tokensEstimate: number | undefined
    const entry = { bytes, value: Object.freeze({
      bytes,
      get sha256(): Promise<string> {
        return sha256 ??= deriveSha256(content).catch((error: unknown) => {
          removeFailedEntry()
          throw error
        })
      },
      get tokensEstimate(): number {
        return tokensEstimate ??= estimateModelHistoryTokens(content)
      },
    }) }
    const removeFailedEntry = () => {
      // A retired in-flight calculation must never remove a newer entry.
      if (this.entries.get(content) === entry) {
        this.entries.delete(content)
        this.retainedBytes -= bytes
      }
    }
    if (this.maxEntries === 0 || bytes > this.maxBytes) return entry.value
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value
      if (!oldest) break
      this.entries.delete(oldest[0])
      this.retainedBytes -= oldest[1].bytes
    }
    this.entries.set(content, entry)
    this.retainedBytes += bytes
    return entry.value
  }

  get size(): Readonly<{ entries: number; bytes: number }> {
    return { entries: this.entries.size, bytes: this.retainedBytes }
  }
}

export const promptContentMetrics = new PromptContentMetricsCache()
