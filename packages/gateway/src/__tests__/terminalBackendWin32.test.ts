import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localBackendSpawnOptions } from '../terminalBackend.js'

const base = {
  command: 'node',
  args: ['-e', '0'],
  ccbBinaryDir: '/opt/ccb',
  env: {} as Record<string, string>,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  detached: true,
}

describe('LocalBackend spawn options — B4 win32 windowsHide, no detached', () => {
  it('linux keeps detached from the caller and does not set windowsHide', () => {
    const opts = localBackendSpawnOptions(base, 'linux')
    assert.equal(opts.cwd, '/opt/ccb')
    assert.equal(opts.detached, true)
    assert.equal('windowsHide' in opts && opts.windowsHide, false)
  })

  it('linux subprocessCwd still wins', () => {
    const opts = localBackendSpawnOptions({ ...base, subprocessCwd: '/work' }, 'linux')
    assert.equal(opts.cwd, '/work')
    assert.equal(opts.detached, true)
  })

  it('win32 forces windowsHide:true and detached:false', () => {
    const opts = localBackendSpawnOptions(base, 'win32')
    assert.equal(opts.windowsHide, true)
    assert.equal(opts.detached, false)
  })
})
