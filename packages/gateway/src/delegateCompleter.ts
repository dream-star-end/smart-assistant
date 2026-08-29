/**
 * OCV5-22 B2 Completer: single callback consumer for a release generation.
 * clientMessageId = dlgcb.{jobId}.{callback_epoch}. Shadow intent is removed
 * only after delivered.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { delegateCallbackMessageId } from '../../protocol/src/delegation.js'
import type { DelegateJobSnapshot, DelegateJobStore } from './delegateJobs.js'

export { delegateCallbackMessageId }

export function delegateJobsPersistDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR?.trim()) {
    return env.OPENCLAUDE_DELEGATE_JOB_SNAPSHOT_DIR.trim()
  }
  const home = env.OPENCLAUDE_HOME?.trim() || join(process.env.HOME || '/home/agent', '.openclaude')
  return join(home, 'runtime', 'delegate-jobs')
}

export async function persistDelegateJobSnapshots(
  store: DelegateJobStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const dir = delegateJobsPersistDir(env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const snaps = store.snapshotsForPersist()
  for (const snap of snaps) {
    await writeFile(join(dir, `${snap.id}.json`), `${JSON.stringify(snap)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
  return snaps.length
}

export async function restoreDelegateJobSnapshots(
  store: DelegateJobStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const dir = delegateJobsPersistDir(env)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0
    throw err
  }
  let n = 0
  for (const name of names) {
    if (!/^dlgjob-[A-Za-z0-9-]{1,160}\.json$/.test(name)) continue
    try {
      const snap = JSON.parse(await readFile(join(dir, name), 'utf8')) as DelegateJobSnapshot
      if (!snap?.id) continue
      store.restoreSnapshot(snap)
      n += 1
    } catch {
      await rm(join(dir, name), { force: true }).catch(() => {})
    }
  }
  return n
}

export function markCallbackState(
  store: DelegateJobStore,
  jobId: string,
  next: 'pending' | 'injecting' | 'delivered' | 'abandoned' | 'skipped_silent',
  fence?: { claimToken: string; fencingEpoch: number },
): boolean {
  return store.patchCallbackState(jobId, next, fence)
}
