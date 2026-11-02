/** Shared linear framing for native JSONL. Lines exclude LF; chunks may split
 * UTF8 or place a full-size line's LF in the following read. */
import { requireRemote } from '@openclaude/protocol/agentRemote'
import { NATIVE_TRANSCRIPT_LINE_MAX_BYTES } from '@openclaude/protocol/agentRemoteNative'
export function createNativeTranscriptLines(accept: (line: string) => void): {
  push(bytes: Uint8Array): void
  complete(): boolean
} {
  let fragments: Buffer[] = []
  let lineBytes = 0
  return {
    push(value) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        const fragment = bytes.subarray(offset, end)
        lineBytes += fragment.length
        requireRemote(lineBytes <= NATIVE_TRANSCRIPT_LINE_MAX_BYTES, 'native-line-bound')
        if (fragment.length) fragments.push(Buffer.from(fragment))
        if (newline < 0) break
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(fragments, lineBytes),
        )
        fragments = []
        lineBytes = 0
        accept(text)
        offset = newline + 1
      }
    },
    complete: () => lineBytes === 0,
  }
}
