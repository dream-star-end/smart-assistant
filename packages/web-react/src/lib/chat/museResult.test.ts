import { expect, test, vi } from 'vitest'
import { ChatSocket } from './socket'

test('Muse result hydrates only its origin without finalizing the user current turn', async () => {
  const syncSession = vi.fn(async () => {})
  const sock = new ChatSocket({
    getToken: () => 'test',
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: 'transient', epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: 'main',
    syncSession,
  })
  sock.ensureSession('origin', 'main')
  sock.ensureSession('other', 'main')
  const origin = sock.sessions.get('origin')!
  origin._sendingInFlight = true
  origin._activeClientMessageId = 'new-turn'
  const dispatch = (frame: unknown) =>
    (sock as unknown as { dispatch(f: unknown): void }).dispatch(frame)
  dispatch({ type: 'sys.muse_result', sessionId: 'origin', jobId: 'mj_test', ts: 1 })
  await Promise.resolve()
  expect(syncSession).toHaveBeenCalledExactlyOnceWith('origin')
  expect(origin._sendingInFlight).toBe(true)
  expect(origin._activeClientMessageId).toBe('new-turn')
  expect(origin.messages).toHaveLength(0) // content comes from the authoritative append, not a second live row
  dispatch({ type: 'sys.muse_result', sessionId: 'missing', jobId: 'mj_test', ts: 1 })
  expect(syncSession).toHaveBeenCalledTimes(1)
})
