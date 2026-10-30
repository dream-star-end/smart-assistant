import { expect, test } from 'bun:test'
import { transcriptNeedsRecovery } from '../nativeTranscriptRecovery.js'
import type { SessionReadHandle } from '../sessionFileIo.js'

function fragmented(bytes: Buffer, maxRead: number, zero = false) {
  const positions: number[] = []
  let consumed = 0
  // Only the stat/read forms used by preflight belong to this fixture.
  const handle = {
    stat: async () => ({ size: bytes.length }),
    read: async (target: Buffer, offset: number, length: number, position: number) => {
      expect(position).toBe(consumed)
      positions.push(position)
      const count = zero ? 0 : Math.min(length, maxRead, bytes.length - position)
      bytes.copy(target, offset, position, position + count)
      consumed += count
      return { bytesRead: count, buffer: target }
    },
  } as unknown as SessionReadHandle
  return { handle, positions, consumed: () => consumed }
}

test('preflight preserves full-row graph and fatal UTF8 decisions across short-read boundaries', async () => {
  const root = { type: 'user', uuid: 'root', parentUuid: null, message: { role: 'user', content: 'Ω🙂é[,]{}' } }
  const child = { type: 'assistant', uuid: 'child', parentUuid: 'root', message: { role: 'assistant', content: 'retained' } }
  const valid = Buffer.from(`${JSON.stringify(root)}\n\n${JSON.stringify(child)}`)
  const dangling = Buffer.from(`${JSON.stringify({ ...child, parentUuid: 'missing' })}\n`)
  const invalid = Buffer.from(valid)
  invalid[invalid.indexOf(Buffer.from('Ω'))] = 0xff
  for (const [bytes, expected] of [[valid, false], [dangling, true], [invalid, true], [Buffer.from('\n\n'), false], [Buffer.alloc(0), false]] as const) {
    const full = fragmented(bytes, Math.max(1, bytes.length))
    expect(await transcriptNeedsRecovery(full.handle)).toBe(expected)
    for (const chunk of [1, 2, 3, 7]) {
      const input = fragmented(bytes, chunk)
      expect(await transcriptNeedsRecovery(input.handle)).toBe(expected)
      expect(input.consumed()).toBe(bytes.length)
      expect(input.positions.length).toBe(Math.ceil(bytes.length / chunk))
    }
  }
})

test('preflight still rejects a zero-byte short read before the declared EOF', async () => {
  const input = fragmented(Buffer.from('{}\n'), 1, true)
  await expect(transcriptNeedsRecovery(input.handle)).rejects.toMatchObject({ name: 'SessionFileIntegrityError', code: 'CCB_TRANSCRIPT_SHORT_READ' })
  expect(input.consumed()).toBe(0)
})
