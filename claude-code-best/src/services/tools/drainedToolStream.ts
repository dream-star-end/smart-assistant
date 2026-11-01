/** A bounded progress view of an independently drained execution.
 * Returning/losing the view detaches it; it does not complete or cancel effects.
 * Authoritative updates must be recorded by the producer before emit().
 */
export function createDrainedToolStream<T>(
  produce: (emit: (value: T) => Promise<void>) => Promise<void>,
  sizeOf: (value: T) => number,
  maxBufferedBytes = 8 * 1024 * 1024,
) {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
    throw new Error('native-stream-capacity')
  const queue: { value: T; bytes: number }[] = []
  let bufferedBytes = 0
  let detached = false
  let finished = false
  let failed = false
  let failure: unknown
  let wakeRead: (() => void) | undefined
  let wakeWrite: (() => void) | undefined
  let reading = false
  const wake = () => {
    wakeRead?.()
    wakeRead = undefined
    wakeWrite?.()
    wakeWrite = undefined
  }
  const detach = () => {
    detached = true
    queue.length = 0
    bufferedBytes = 0
    wake()
  }
  const emit = async (value: T) => {
    if (detached) return
    const bytes = sizeOf(value)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBufferedBytes)
      throw new Error('native-stream-frame-size')
    while (!detached && (queue.length >= 32 || bufferedBytes + bytes > maxBufferedBytes)) {
      await new Promise<void>((resolve) => {
        wakeWrite = resolve
      })
    }
    if (detached) return
    queue.push({ value, bytes })
    bufferedBytes += bytes
    wakeRead?.()
    wakeRead = undefined
  }
  // Start asynchronously so callers can retain done before the first update.
  const done = Promise.resolve()
    .then(() => produce(emit))
    .catch((error) => {
      failed = true
      failure = error
      throw error
    })
    .finally(() => {
      finished = true
      wake()
    })
  // A transport can detach without awaiting; retain a rejection handler while
  // preserving the original rejecting promise for its supervisor.
  void done.catch(() => {})
  const stream: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (reading) throw new Error('native-stream-concurrent-read')
      reading = true
      try {
        for (;;) {
          if (detached) return { done: true, value: undefined }
          const item = queue.shift()
          if (item) {
            bufferedBytes -= item.bytes
            wakeWrite?.()
            wakeWrite = undefined
            return { done: false, value: item.value }
          }
          if (failed) throw failure
          if (finished) return { done: true, value: undefined }
          await new Promise<void>((resolve) => {
            wakeRead = resolve
          })
        }
      } finally {
        reading = false
      }
    },
    async return() {
      detach()
      return { done: true, value: undefined }
    },
    async throw(error) {
      detach()
      throw error
    },
  }
  return { stream, done, detach }
}
