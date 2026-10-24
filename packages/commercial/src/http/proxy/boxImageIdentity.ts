import { createHash } from 'node:crypto'
import type { ProxyBody } from './shared.js'

export type BoxImageIdentity = { version: 1; complete: false } | {
  version: 1; complete: true; sha256: string; imageCount: number; uniqueImageCount: number; mediaBytes: number
}
/** Constant-size private journal evidence, beside the existing full body hashes.
 * No content, paths, per-image digests or new model decisions leave this function. */
export function deriveBoxImageIdentity(body: Pick<ProxyBody, 'messages'>): BoxImageIdentity {
  try {
    const identities: string[] = []
    let mediaBytes = 0
    let nodes = 0
    const blocks = (content: unknown, depth: number): void => {
      if (++nodes > 100000 || depth > 64) throw new Error('INCOMPLETE')
      if (typeof content === 'string') return
      if (!Array.isArray(content)) throw new Error('INCOMPLETE')
      for (const block of content) {
        if (++nodes > 100000 || !block || typeof block !== 'object' || Array.isArray(block)) throw new Error('INCOMPLETE')
        const item = block as Record<string, unknown>
        if (item.type === 'image') {
          const source = item.source as Record<string, unknown> | undefined
          if (!source || source.type !== 'base64' || typeof source.data !== 'string'
            || typeof source.media_type !== 'string' || !source.media_type.startsWith('image/')
            || !source.data.length || source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) throw new Error('INCOMPLETE')
          const bytes = Buffer.from(source.data, 'base64')
          if (bytes.toString('base64') !== source.data) throw new Error('INCOMPLETE')
          identities.push(JSON.stringify([source.media_type, bytes.length, createHash('sha256').update(bytes).digest('hex')]))
          mediaBytes += bytes.length
        } else if (item.type === 'tool_result') {
          // Tool inputs and text JSON are model text, not model image blocks.
          if (item.content !== undefined) blocks(item.content, depth + 1)
        }
      }
    }
    for (const message of body.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('INCOMPLETE')
      blocks((message as { content?: unknown }).content, 0)
    }
    const sha256 = createHash('sha256').update('ocv5-box-image-identity-v1\0').update(identities.sort().join('\n')).digest('hex')
    return { version: 1, complete: true, sha256, imageCount: identities.length, uniqueImageCount: new Set(identities).size, mediaBytes }
  } catch { return { version: 1, complete: false } }
}
