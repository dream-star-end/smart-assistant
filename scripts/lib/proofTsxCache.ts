import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

// One invocation owns this cache. Only transforms are shared: every proof keeps
// its own HOME, state and TMPDIR, and tsx still keys by source bytes/path/options.
// Never link to the host's global tsx cache or reuse another candidate's cache.
export function createProofTsxCache(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, 'oc-proof-tsx-'))
  const name = `tsx-${process.geteuid?.() ?? userInfo().username}`
  const cache = join(root, name)
  let closed = false
  const cleanup = () => {
    if (closed) return
    rmSync(root, { recursive: true, force: true })
    closed = true
    process.off('exit', cleanup)
  }
  process.once('exit', cleanup)
  return {
    linkInto(proofTmpdir: string) {
      if (closed) throw new Error('proof tsx cache already closed')
      mkdirSync(cache, { recursive: true })
      // symlinkSync refuses an existing entry; it must never replace proof data.
      // rm(proofTmpdir, recursive) unlinks this entry without removing the cache.
      symlinkSync(cache, join(proofTmpdir, name), 'dir')
    },
    cleanup,
  }
}
