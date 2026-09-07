/**
 * Regression for the 2026-09-07 selfhost STALE_RESUME_ID loop.
 *
 * Turn 1 (unbound, isolated_v1) ran with cwd `workspace/sessions/<id>`; CCB wrote
 * `projects/-…-workspace-sessions-<id>/<uuid>.jsonl`. Turn 2 was project-bound
 * (cwd `workspace`) so CCB looked in `projects/-…-workspace/` → "No conversation
 * found" → exit 1, while the gateway's any-dir probe kept saying "resumable".
 */
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ccbProjectDirForCwd,
  ccbProjectDirName,
  findCcbJsonlAnywhere,
  relocateCcbJsonlToCwd,
} from '../engine/ccbTranscriptRelocate.js'

const ID = '245eb67f-6991-4788-9691-fdccd0c51c7b'

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ccb-relocate-'))
  const configDir = join(dir, 'claude-config')
  const oldCwd = join(dir, 'workspace', 'sessions', 'webmtqk468nmfkvrb')
  const newCwd = join(dir, 'workspace')
  mkdirSync(oldCwd, { recursive: true })
  mkdirSync(join(configDir, 'projects'), { recursive: true })
  return { dir, configDir, oldCwd, newCwd }
}

test('ccbProjectDirName mirrors Claude Code sanitizePath', () => {
  assert.equal(
    ccbProjectDirName('/home/agent/.openclaude/workspace/sessions/webmtqk468nmfkvrb'),
    '-home-agent--openclaude-workspace-sessions-webmtqk468nmfkvrb',
  )
  assert.equal(
    ccbProjectDirName('/home/agent/.openclaude/workspace'),
    '-home-agent--openclaude-workspace',
  )
  // >200 chars → hash suffix we cannot reproduce portably → undefined
  assert.equal(ccbProjectDirName(`/${'a'.repeat(250)}`), undefined)
})

test('ccbProjectDirForCwd resolves symlinks like CCB does', () => {
  const { dir, configDir, newCwd } = scaffold()
  try {
    mkdirSync(newCwd, { recursive: true })
    const projected = ccbProjectDirForCwd(newCwd, configDir)
    assert.ok(projected)
    assert.ok(projected.startsWith(join(configDir, 'projects')))
    // tmpdir may itself be a symlink on some hosts; the projection must use the realpath.
    assert.equal(projected, join(configDir, 'projects', ccbProjectDirName(realpathSync(newCwd))!))
    assert.equal(ccbProjectDirForCwd(newCwd, ''), undefined)
    assert.equal(ccbProjectDirForCwd('', configDir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relocate: transcript under old cwd dir becomes visible under new cwd dir (hard link, same inode)', () => {
  const { dir, configDir, oldCwd, newCwd } = scaffold()
  try {
    const oldProj = ccbProjectDirForCwd(oldCwd, configDir)!
    const newProj = ccbProjectDirForCwd(newCwd, configDir)!
    assert.notEqual(oldProj, newProj)
    mkdirSync(oldProj, { recursive: true })
    writeFileSync(join(oldProj, `${ID}.jsonl`), '{"type":"user"}\n')

    const r = relocateCcbJsonlToCwd({ innerId: ID, cwd: newCwd, claudeConfigDir: configDir })
    assert.ok(r)
    assert.equal(r.relocated, true)
    assert.equal(r.path, join(newProj, `${ID}.jsonl`))
    assert.equal(r.from, oldProj)
    // same inode: appends CCB makes after --resume are visible through both paths
    assert.equal(statSync(r.path).ino, statSync(join(oldProj, `${ID}.jsonl`)).ino)
    assert.equal(readFileSync(r.path, 'utf8'), '{"type":"user"}\n')
    // source is kept (older probes / cwd flip-back still work)
    assert.equal(statSync(join(oldProj, `${ID}.jsonl`)).size > 0, true)

    // idempotent: second call is a no-op
    const again = relocateCcbJsonlToCwd({ innerId: ID, cwd: newCwd, claudeConfigDir: configDir })
    assert.deepEqual(again, { path: join(newProj, `${ID}.jsonl`), relocated: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relocate: already in place / nowhere on disk / malformed id / no config dir → no-op', () => {
  const { dir, configDir, newCwd } = scaffold()
  try {
    const newProj = ccbProjectDirForCwd(newCwd, configDir)!
    mkdirSync(newProj, { recursive: true })
    writeFileSync(join(newProj, `${ID}.jsonl`), '{"type":"user"}\n')
    assert.deepEqual(
      relocateCcbJsonlToCwd({ innerId: ID, cwd: newCwd, claudeConfigDir: configDir }),
      { path: join(newProj, `${ID}.jsonl`), relocated: false },
    )
    const missing = '99999999-9999-4999-8999-999999999999'
    assert.equal(
      relocateCcbJsonlToCwd({ innerId: missing, cwd: newCwd, claudeConfigDir: configDir }),
      undefined,
    )
    assert.equal(
      relocateCcbJsonlToCwd({ innerId: 'sand-ccb:x', cwd: newCwd, claudeConfigDir: configDir }),
      undefined,
    )
    assert.equal(
      relocateCcbJsonlToCwd({ innerId: ID, cwd: newCwd, claudeConfigDir: '', env: {} }),
      undefined,
    )
    // 0-byte file elsewhere is not an artifact
    const other = join(configDir, 'projects', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, `${missing}.jsonl`), '')
    assert.equal(findCcbJsonlAnywhere(missing, configDir), undefined)
    assert.equal(
      relocateCcbJsonlToCwd({ innerId: missing, cwd: newCwd, claudeConfigDir: configDir }),
      undefined,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('relocate: env CLAUDE_CONFIG_DIR is honoured when claudeConfigDir is not passed', () => {
  const { dir, configDir, oldCwd, newCwd } = scaffold()
  try {
    const oldProj = ccbProjectDirForCwd(oldCwd, configDir)!
    mkdirSync(oldProj, { recursive: true })
    writeFileSync(join(oldProj, `${ID}.jsonl`), '{"type":"user"}\n')
    const r = relocateCcbJsonlToCwd({
      innerId: ID,
      cwd: newCwd,
      env: { CLAUDE_CONFIG_DIR: configDir },
    })
    assert.equal(r?.relocated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
