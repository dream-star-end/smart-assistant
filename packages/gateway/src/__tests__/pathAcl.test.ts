import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasResolvedPrefix,
  isPathWithinRoot,
  openclaudeTempPrefix,
  trustedContainerHome,
} from '../pathAcl.js'

describe('isPathWithinRoot — B8 Linux regression (must match startsWith(root+/) )', () => {
  it('allows the root itself and children, rejects sibling prefix collisions', () => {
    assert.equal(isPathWithinRoot('/home/agent', '/home/agent', 'linux'), true)
    assert.equal(isPathWithinRoot('/home/agent/hello.txt', '/home/agent', 'linux'), true)
    assert.equal(isPathWithinRoot('/home/agent/.openclaude/x', '/home/agent', 'linux'), true)
    assert.equal(isPathWithinRoot('/home/agent2/x', '/home/agent', 'linux'), false)
    assert.equal(isPathWithinRoot('/home/agent-evil/x', '/home/agent', 'linux'), false)
    assert.equal(isPathWithinRoot('/etc/passwd', '/home/agent', 'linux'), false)
  })

  it('matches FILE_ALLOWED_DIRS / makeUserScopedMediaPredicate boundary (dir + /)', () => {
    const dir = '/var/lib/docker/volumes/oc-v5-data-u3/_data/uploads'
    assert.equal(isPathWithinRoot(dir, dir, 'linux'), true)
    assert.equal(isPathWithinRoot(`${dir}/a.png`, dir, 'linux'), true)
    assert.equal(isPathWithinRoot(`${dir}-evil/a.png`, dir, 'linux'), false)
  })

  it('win32 folds case and uses path.sep, not a bare startsWith', () => {
    assert.equal(
      isPathWithinRoot('C:\\Users\\Ada\\file.txt', 'C:\\Users\\Ada', 'win32'),
      true,
    )
    assert.equal(
      isPathWithinRoot('c:\\users\\ada\\file.txt', 'C:\\Users\\Ada', 'win32'),
      true,
    )
    assert.equal(
      isPathWithinRoot('C:\\Users\\Ada2\\file.txt', 'C:\\Users\\Ada', 'win32'),
      false,
    )
  })
})

describe('hasResolvedPrefix — TEMP /tmp/openclaude-* Linux regression', () => {
  it('keeps the current /tmp/openclaude- filename prefix (no trailing slash required)', () => {
    const prefix = openclaudeTempPrefix('linux')
    assert.equal(prefix, '/tmp/openclaude-')
    assert.equal(hasResolvedPrefix('/tmp/openclaude-abc/x.png', prefix, 'linux'), true)
    assert.equal(hasResolvedPrefix('/tmp/openclaude-abc123', prefix, 'linux'), true)
    assert.equal(hasResolvedPrefix('/tmp/random-file.txt', prefix, 'linux'), false)
    assert.equal(hasResolvedPrefix('/tmp/openclaude', prefix, 'linux'), false)
  })
})

describe('trustedContainerHome / temp prefix platform defaults', () => {
  it('linux trusted home stays /home/agent', () => {
    assert.equal(trustedContainerHome('linux', {}), '/home/agent')
  })

  it('win32 trusted home uses USERPROFILE', () => {
    assert.equal(
      trustedContainerHome('win32', { USERPROFILE: 'C:\\Users\\Ada' }).toLowerCase(),
      'c:\\users\\ada',
    )
  })
})
