import type { AuthSession } from '../types'
import { AuthEpochStaleError, type RequestExecutionGuard } from './http'
import type { cardBusinessApi } from './cardBusinessApi'

/** Capture before loading; check and invoke in one synchronous continuation. */
export async function withCardBusinessApi<T>(auth: AuthSession, guard: RequestExecutionGuard | undefined, invoke: (client: typeof cardBusinessApi) => Promise<T>): Promise<T> {
  const used = auth.snapshot()
  const generation = typeof auth.getAccessGeneration === 'function' ? auth.getAccessGeneration() : undefined
  guard?.assertCurrent()
  const module = await import('./cardBusinessApi')
  const now = auth.snapshot()
  if (now.epoch !== used.epoch || now.token !== used.token ||
      (generation !== undefined && auth.getAccessGeneration() !== generation)) throw new AuthEpochStaleError()
  guard?.assertCurrent()
  const result = await invoke(module.cardBusinessApi)
  // Default human clients retain their existing transparent refresh after dispatch.
  if (auth.snapshot().epoch !== used.epoch) throw new AuthEpochStaleError()
  guard?.assertCurrent()
  return result
}
