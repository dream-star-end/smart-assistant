import type { AuthSession } from '../types'
import { AuthEpochStaleError, type RequestExecutionGuard } from './http'

/** Preserve the original API invocation's identity across the optional chunk load. */
export async function loadCardBusinessApi(auth: AuthSession, guard?: RequestExecutionGuard) {
  const epoch = auth.snapshot().epoch
  guard?.assertCurrent()
  const module = await import('./cardBusinessApi')
  if (auth.snapshot().epoch !== epoch) throw new AuthEpochStaleError()
  guard?.assertCurrent()
  return module.cardBusinessApi
}
