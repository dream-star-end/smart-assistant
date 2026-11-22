import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-changelog-guard.ts',
)

function initRepo(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-guard-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.0","releases":[]}\n')
  writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('tag', 'base')
  return dir
}

function runCli(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  const { BOSS_APPROVED_CHANGELOG: _ignored, ...restEnv } = process.env
  const cleanEnv: NodeJS.ProcessEnv = { ...restEnv, ...env }
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--root', dir, ...args], {
    encoding: 'utf8',
    env: cleanEnv,
  })
}

describe('check-changelog-guard', () => {
  test('GREEN: passes when changelog.json is untouched in working tree and git diff', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'README.md'), 'updated\n')
    execFileSync('git', ['-C', dir, 'add', 'README.md'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'docs'])
    const r = runCli(dir, ['--base', 'base'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /untouched/)
  })

  test('RED: blocks unstaged working-tree edit to changelog.json without BOSS_APPROVED_CHANGELOG=1', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.1","releases":[]}\n')
    const r = runCli(dir, [])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\[GATE-ERROR\] CHANGELOG-GUARD/)
    assert.match(r.stderr, /BOSS_APPROVED_CHANGELOG=1/)
  })

  test('RED: blocks committed base...HEAD edit to changelog.json without BOSS_APPROVED_CHANGELOG=1', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.2","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'sneaky changelog'])
    const r = runCli(dir, ['--base', 'base'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /\[GATE-ERROR\] CHANGELOG-GUARD/)
  })

  test('GREEN: allows edit when BOSS_APPROVED_CHANGELOG=1 is set', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.3","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'boss approved'])
    const r = runCli(dir, ['--base', 'base'], { BOSS_APPROVED_CHANGELOG: '1' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /explicitly approved/)
  })

  test('GREEN: allows committed edit when --approved-commit matches exact HEAD SHA even with BOSS_APPROVED_CHANGELOG=0', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.4","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'approved by PR review'])
    const headSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    const ok = runCli(dir, ['--base', 'base', '--approved-commit', headSha], {
      BOSS_APPROVED_CHANGELOG: '0',
    })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, new RegExp(`--approved-commit=${headSha}`))
  })

  test('RED: blocks when --approved-commit does not match HEAD SHA or when dirty working tree edits changelog.json', (t) => {
    const dir = initRepo(t)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.5","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'new unreviewed commit'])
    const headSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const wrongSha = headSha.startsWith('0') ? `1${headSha.slice(1)}` : `0${headSha.slice(1)}`

    const mismatch = runCli(dir, ['--base', 'base', '--approved-commit', wrongSha], {
      BOSS_APPROVED_CHANGELOG: '0',
    })
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /\[GATE-ERROR\] CHANGELOG-GUARD/)

    // Dirty working-tree edit on top of approved HEAD must STILL be rejected
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.6-dirty","releases":[]}\n')
    const dirty = runCli(dir, ['--base', 'base', '--approved-commit', headSha], {
      BOSS_APPROVED_CHANGELOG: '0',
    })
    assert.equal(dirty.status, 1)
    assert.match(dirty.stderr, /\[GATE-ERROR\] CHANGELOG-GUARD/)
  })

  test('GREEN/RED: batch push allows commit-bound approval when later commits do not touch changelog.json, and rejects if later commit modifies it', (t) => {
    const dir = initRepo(t)
    // Commit A modifies changelog.json (approved by Boss)
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.7","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'approved changelog commit A'])
    const commitA = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    // Commit B only modifies unrelated doc file (batch push tail)
    writeFileSync(path.join(dir, 'README.md'), 'updated docs\n')
    execFileSync('git', ['-C', dir, 'add', 'README.md'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'unrelated docs commit B'])

    const batchOk = runCli(dir, ['--base', 'base', '--approved-commit', commitA], {
      BOSS_APPROVED_CHANGELOG: '0',
    })
    assert.equal(batchOk.status, 0, batchOk.stderr)

    // Commit C touches changelog.json again without new approval -> commitA must NOT authorize C
    writeFileSync(path.join(dir, 'changelog.json'), '{"currentVersion":"v1.0.8","releases":[]}\n')
    execFileSync('git', ['-C', dir, 'add', 'changelog.json'])
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'unapproved changelog edit C'])

    const staleApproval = runCli(dir, ['--base', 'base', '--approved-commit', commitA], {
      BOSS_APPROVED_CHANGELOG: '0',
    })
    assert.equal(staleApproval.status, 1)
    assert.match(staleApproval.stderr, /\[GATE-ERROR\] CHANGELOG-GUARD/)
  })

  test('FAIL-CLOSED: malformed --approved-commit or bad --base ref exits 2', (t) => {
    const dir = initRepo(t)
    assert.equal(runCli(dir, ['--base', 'does-not-exist']).status, 2)
    assert.equal(runCli(dir, ['--approved-commit', 'short-sha']).status, 2)
  })
})
