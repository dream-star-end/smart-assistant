import { expect, test } from 'bun:test'
import { createDrainedToolStream } from '../drainedToolStream.js'
test('bounded view detaches without cancelling authoritative producer', async () => {
  const persisted: number[] = []
  const batch = createDrainedToolStream(
    async (emit) => {
      for (let i = 0; i < 100; i++) {
        persisted.push(i)
        await emit(i)
      }
    },
    () => 1,
    2,
  )
  expect((await batch.stream.next()).value).toBe(0)
  await batch.stream.return!()
  await batch.done
  expect(persisted).toHaveLength(100)
})
test('producer errors reject both supervisor and attached reader', async () => {
  const batch = createDrainedToolStream(
    async () => {
      throw Error('disk-failed')
    },
    () => 1,
  )
  await expect(batch.stream.next()).rejects.toThrow('disk-failed')
  await expect(batch.done).rejects.toThrow('disk-failed')
})
