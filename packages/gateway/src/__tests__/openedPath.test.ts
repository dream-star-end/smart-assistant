import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveOpenedPath, type ResolveOpenedPathFs } from '../openedPath.js'

function fakeFs(opts: {
  proc?: string
  real?: string
  symlink?: boolean
  lstatErr?: Error
  realErr?: Error
}): ResolveOpenedPathFs {
  return {
    realpathSync(p: string) {
      if (opts.realErr) throw opts.realErr
      if (p.startsWith('/proc/self/fd/')) return opts.proc ?? p
      return opts.real ?? p
    },
    lstatSync() {
      if (opts.lstatErr) throw opts.lstatErr
      return { isSymbolicLink: () => Boolean(opts.symlink) }
    },
  }
}

describe('resolveOpenedPath — B6 /proc/self/fd vs win32 realpath', () => {
  it('linux uses /proc/self/fd/<fd> and ignores fallback for the proc lookup', () => {
    const seen: string[] = []
    const fs: ResolveOpenedPathFs = {
      realpathSync(p: string) {
        seen.push(p)
        return '/real/opened'
      },
      lstatSync() {
        throw new Error('linux must not lstat fallback')
      },
    }
    assert.equal(resolveOpenedPath(7, '/tmp/x', 'linux', fs), '/real/opened')
    assert.deepEqual(seen, ['/proc/self/fd/7'])
  })

  it('win32 realpath of fallbackPath after refusing a symlink leaf', () => {
    const fs = fakeFs({ real: 'C:\\Users\\a\\file.txt', symlink: false })
    assert.equal(
      resolveOpenedPath(3, 'C:\\Users\\a\\file.txt', 'win32', fs),
      'C:\\Users\\a\\file.txt',
    )
  })

  it('win32 fail-closed on reparse/symlink', () => {
    const fs = fakeFs({ symlink: true })
    assert.throws(
      () => resolveOpenedPath(3, 'C:\\link', 'win32', fs),
      /reparse point refused/,
    )
  })

  it('win32 fail-closed when lstat or realpath throws', () => {
    assert.throws(
      () => resolveOpenedPath(3, 'C:\\missing', 'win32', fakeFs({ lstatErr: new Error('ENOENT') })),
      /ENOENT/,
    )
    assert.throws(
      () =>
        resolveOpenedPath(
          3,
          'C:\\x',
          'win32',
          fakeFs({ symlink: false, realErr: new Error('EACCES') }),
        ),
      /EACCES/,
    )
  })
})
