import * as assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { sessionRepoRoots } from '../sessionRepoWorkspace.js'
import { paths } from '@openclaude/storage'

describe('sessionRepoRoots — B5 DATA_ROOT follows paths.home / OPENCLAUDE_HOME', () => {
  it('defaults to paths.home (Linux current value when OPENCLAUDE_HOME unset)', () => {
    const roots = sessionRepoRoots()
    assert.equal(roots.dataRoot, paths.home)
    assert.equal(roots.reposRoot, join(paths.home, 'repos'))
    assert.equal(roots.credsRoot, join(paths.home, 'git-creds'))
  })

  it('accepts an explicit home override', () => {
    const roots = sessionRepoRoots('D:\\Clarvy\\profile')
    assert.equal(roots.dataRoot, 'D:\\Clarvy\\profile')
    assert.equal(roots.reposRoot, join('D:\\Clarvy\\profile', 'repos'))
  })
})
