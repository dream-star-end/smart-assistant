// Private CLI fixture: real HTTP/WS, only the three explicit smoke timers are virtual.
if (process.env.OC_TEST_CANARY_CLOCK !== '1' || !process.send) {
  throw new Error('canary-clock requires the isolated test IPC channel')
}
const nativeTimeout = globalThis.setTimeout
const nativeInterval = globalThis.setInterval
const nativeClearTimeout = globalThis.clearTimeout
const nativeClearInterval = globalThis.clearInterval
const timers = new Map()
let now = 0
let sequence = 0
const emit = (value) => { if (process.connected) process.send(value) }
// Observe actual parsed HTTP evidence, never supply or transform the response.
// This lets negative cases expire grace only after the wrong/empty body was read.
const nativeFetch = globalThis.fetch
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args)
  if (String(args[0]).includes('/api/sessions/') && !args[1]?.method) {
    const json = response.json.bind(response)
    response.json = async () => {
      const body = await json()
      emit({ kind: 'clock-tape-read', text: body?.messages?.at(-1)?.text })
      return body
    }
  }
  return response
}
function register(kind, callback, ms, args) {
  if (![20, 60, 80].includes(ms)) {
    return (kind === 'interval' ? nativeInterval : nativeTimeout)(callback, ms, ...args)
  }
  const handle = { id: ++sequence, ref() { return this }, unref() { return this } }
  timers.set(handle, { kind, callback, ms, args, due: now + ms })
  emit({ kind: 'clock-event', action: 'register', id: handle.id, timerKind: kind, ms, at: now })
  return handle
}
globalThis.setTimeout = (callback, ms, ...args) => register('timeout', callback, ms, args)
globalThis.setInterval = (callback, ms, ...args) => register('interval', callback, ms, args)
function cancel(handle, nativeClear) {
  const timer = timers.get(handle)
  if (!timer) { nativeClear(handle); return }
  timers.delete(handle)
  emit({ kind: 'clock-event', action: 'cancel', id: handle.id, ms: timer.ms, at: now })
}
globalThis.clearTimeout = (handle) => cancel(handle, nativeClearTimeout)
globalThis.clearInterval = (handle) => cancel(handle, nativeClearInterval)
process.on('message', (message) => {
  if (message?.kind !== 'clock-advance') return
  if (!Number.isFinite(message.to) || message.to < now || message.to > 80) {
    throw new Error('non-monotonic/out-of-range canary fixture clock')
  }
  for (;;) {
    const next = [...timers.entries()].filter(([, timer]) => timer.due <= message.to)
      .sort((a, b) => a[1].due - b[1].due || a[0].id - b[0].id)[0]
    if (!next) break
    const [handle, timer] = next
    now = timer.due
    if (timer.kind === 'interval') timer.due += timer.ms
    else timers.delete(handle)
    emit({ kind: 'clock-event', action: 'fire', id: handle.id, ms: timer.ms, at: now })
    timer.callback(...timer.args)
  }
  now = message.to
  emit({ kind: 'clock-advanced', to: now })
})
