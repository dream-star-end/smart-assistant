import type { AuthSession } from '../types'
import { AuthEpochStaleError, type RequestExecutionGuard } from './http'
import type { cardBusinessApi } from './cardBusinessApi'

/** Capture before loading; check and invoke in one synchronous continuation. */
export async function withCardBusinessApi<T>(auth: AuthSession, guard: RequestExecutionGuard | undefined, invoke: (client: typeof cardBusinessApi) => Promise<T>): Promise<T> {
  const used = auth.snapshot()
  guard?.assertCurrent()
  const module = await import('./cardBusinessApi')
  const now = auth.snapshot()
  if (now.epoch !== used.epoch) throw new AuthEpochStaleError()
  guard?.assertCurrent()
  return invoke(module.cardBusinessApi)
}
