/**
 * Packaged smoke: fork Host via the injected supervisor factory, wait for
 * IPC `ready` (or hello-ok), then stop. Exit 0 only if Host answered.
 */
export async function runLocalHostSmoke({
  createSupervisor,
  timeoutMs = 20_000,
  now = () => Date.now(),
} = {}) {
  if (typeof createSupervisor !== 'function') {
    throw new TypeError('createSupervisor required')
  }
  let ready = false
  const supervisor = createSupervisor({
    onMessage(raw) {
      if (!raw || typeof raw !== 'object') return
      if (raw.type === 'ready' || raw.type === 'hello-ok') ready = true
    },
  })
  await supervisor.start()
  const deadline = now() + timeoutMs
  while (!ready && now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  try {
    await supervisor.stop()
  } catch {
    /* */
  }
  if (!ready) {
    const err = new Error('host did not send ready')
    err.code = 'HOST_SMOKE_TIMEOUT'
    throw err
  }
  return 0
}
