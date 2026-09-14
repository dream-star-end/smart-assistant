import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { presentStrictNativeResumes } from '../engine/resumeArtifacts.js'

test('batch native hints find all trusted IDs, but never positive on empty, symlink or unknown evidence', () => {
  const home = mkdtempSync(join(tmpdir(), 'native-hints-private-'))
  const ids = Array.from({ length: 50 }, (_, i) => `00000000-0000-0000-0000-${i.toString().padStart(12, '0')}`)
  const dir = join(home, 'sessions/2026/01/01'); mkdirSync(dir, { recursive: true })
  try {
    for (const id of ids) writeFileSync(join(dir, `rollout-private-${id}.jsonl`), 'private')
    assert.equal(presentStrictNativeResumes(ids, { codexHome: home }).size, 50)
    const file = join(dir, `rollout-private-${ids[0]}.jsonl`)
    writeFileSync(file, ''); assert.equal(presentStrictNativeResumes(ids, { codexHome: home }).size, 49)
    rmSync(file); symlinkSync(join(dir, `rollout-private-${ids[1]}.jsonl`), file)
    assert.equal(presentStrictNativeResumes(ids, { codexHome: home }).size, 49)
    assert.equal(presentStrictNativeResumes(ids, { codexHome: join(home, 'missing') }).size, 0)
    assert.throws(() => presentStrictNativeResumes([...ids, ids[0]!], { codexHome: home }))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('directory enumeration has a fixed shared read budget, not one full scan per ID', () => {
  const home = mkdtempSync(join(tmpdir(), 'native-hints-private-'))
  const root = join(home, 'sessions'); mkdirSync(root)
  const original = fs.opendirSync
  let reads = 0, opens = 0
  fs.opendirSync = ((...args: Parameters<typeof fs.opendirSync>) => {
    const dir = original(...args); opens++
    const read = dir.readSync.bind(dir)
    dir.readSync = () => { reads++; return read() }
    return dir
  }) as typeof fs.opendirSync
  syncBuiltinESMExports()
  try {
    for (let i = 0; i < 8300; i++) writeFileSync(join(root, `irrelevant-${i}`), '')
    const id = '00000000-0000-0000-0000-000000000001'
    assert.equal(presentStrictNativeResumes([id], { codexHome: home }).size, 0)
    assert.equal(opens, 1); assert.equal(reads, 8192, 'real directory reads must stop at the shared budget')
  } finally { fs.opendirSync = original; syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }) }
})
