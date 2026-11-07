/** Short native-state CAS only: never hold this lock over transcript IO or model calls. */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { acquireAuthorityGenerationLock } from './authorityGenerationLock.js'

export async function withIdleNativeLock<T>(path: string, update: () => T): Promise<T> {
  mkdirSync(dirname(path), { recursive: true })
  // Stable inode, shared by gateway reconstruction and CCB recovery. Never unlink it.
  const lock = await acquireAuthorityGenerationLock(path + '.lock').catch(() => {
    throw new Error('IDLE_HISTORY_PENDING')
  })
  try { return update() } finally { await lock.release() }
}
