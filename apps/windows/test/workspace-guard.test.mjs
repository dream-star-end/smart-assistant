import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isPathWithinAnyWorkspace, isPathWithinWorkspace } from '../src/host/workspace/guard.mjs'

const identity = (value) => value
const srcPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/host/workspace/guard.mjs')

test('workspace guard source does not use startsWith(root as the decision', () => {
  const src = fs.readFileSync(srcPath, 'utf8')
  assert.equal(src.includes('startsWith(root'), false)
  assert.equal(/startsWith\(\s*root/.test(src), false)
})

test('win32 DES-02 proj-evil prefix is rejected (C:\\w\\proj vs C:\\w\\proj-evil\\x)', () => {
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', 'C:\\w\\proj-evil\\x', { platform: 'win32', realpath: identity }),
    false,
  )
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', 'C:\\w\\proj\\a', { platform: 'win32', realpath: identity }),
    true,
  )
})

test('win32 junction that escapes the workspace root is rejected', () => {
  const realpath = (input) => (input === 'C:\\w\\proj\\link' ? 'D:\\other' : input)
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', 'C:\\w\\proj\\link', { platform: 'win32', realpath }),
    false,
  )
})

test('win32 \\\\?\\ namespaced prefix of an in-root path is allowed', () => {
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', '\\\\?\\C:\\w\\proj\\a', { platform: 'win32', realpath: identity }),
    true,
  )
})

test('win32 case-insensitive NTFS match C:\\W\\PROJ\\a is allowed', () => {
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', 'C:\\W\\PROJ\\a', { platform: 'win32', realpath: identity }),
    true,
  )
})

test('win32 UNC \\\\server\\share\\.. is rejected', () => {
  assert.equal(
    isPathWithinWorkspace('\\\\server\\share', '\\\\server\\share\\..', { platform: 'win32', realpath: identity }),
    false,
  )
})

test('win32 drive-letter jump D:\\x is rejected', () => {
  assert.equal(
    isPathWithinWorkspace('C:\\w\\proj', 'D:\\x', { platform: 'win32', realpath: identity }),
    false,
  )
})

test('posix isomorphic /w/proj vs /w/proj-evil is rejected', () => {
  assert.equal(
    isPathWithinWorkspace('/w/proj', '/w/proj-evil', { platform: 'posix', realpath: identity }),
    false,
  )
  assert.equal(
    isPathWithinWorkspace('/w/proj', '/w/proj/a', { platform: 'posix', realpath: identity }),
    true,
  )
  assert.equal(
    isPathWithinWorkspace('/w/proj', '/w/proj', { platform: 'posix', realpath: identity }),
    true,
  )
})

test('isPathWithinAnyWorkspace requires a matching root', () => {
  assert.equal(
    isPathWithinAnyWorkspace(['/w/proj', '/w/other'], '/w/other/x', { platform: 'posix', realpath: identity }),
    true,
  )
  assert.equal(
    isPathWithinAnyWorkspace(['/w/proj'], '/w/proj-evil/x', { platform: 'posix', realpath: identity }),
    false,
  )
})

test('realpath throw or empty input fail closed', () => {
  assert.equal(isPathWithinWorkspace('', '/w/proj', { platform: 'posix', realpath: identity }), false)
  assert.equal(
    isPathWithinWorkspace('/w/proj', '/w/proj/a', {
      platform: 'posix',
      realpath: () => {
        throw new Error('enoent')
      },
    }),
    false,
  )
})
