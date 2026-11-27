import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(import.meta.dirname, '../..')
const HOOK_SRC = join(ROOT, '.githooks/pre-push')
const ZERO_SHA = '0000000000000000000000000000000000000000'
const TARGET_REF = 'refs/heads/feat/v5-selfhost'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

type FixtureOpts = {
  trailerExit?: number
  ratchetExit?: number
  a0Mode?: 'absent' | 'pass' | 'fail'
}

function createFixture(t: test.TestContext, opts: FixtureOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-pre-push-hook-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  git(dir, 'init', '-b', 'feat/v5-selfhost')
  mkdirSync(join(dir, '.githooks'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(HOOK_SRC, join(dir, '.githooks/pre-push'))
  chmodSync(join(dir, '.githooks/pre-push'), 0o755)

  const logFile = join(dir, '.hook-invocations.log')
  const fakeTsx = join(dir, 'fake-tsx.sh')
  writeFileSync(
    fakeTsx,
    `#!/usr/bin/env bash
set -euo pipefail
script="$1"; shift
printf 'tsx:%s:%s\\n' "$(basename "$script")" "$*" >> ${JSON.stringify(logFile)}
case "$(basename "$script")" in
  check-file-size-ratchet.ts) exit ${opts.ratchetExit ?? 0} ;;
  check-a0-monotonic.ts) exit ${opts.a0Mode === 'fail' ? 1 : 0} ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(fakeTsx, 0o755)

  writeFileSync(
    join(dir, 'scripts/check-v5-fix-trailers.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'trailers:%s\\n' "$*" >> ${JSON.stringify(logFile)}
exit ${opts.trailerExit ?? 0}
`,
  )
  chmodSync(join(dir, 'scripts/check-v5-fix-trailers.sh'), 0o755)

  writeFileSync(join(dir, 'scripts/check-file-size-ratchet.ts'), '// stub\n')
  if (opts.a0Mode && opts.a0Mode !== 'absent') {
    writeFileSync(join(dir, 'scripts/check-a0-monotonic.ts'), '// stub\n')
  }
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n')

  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'chore(v5): base commit')
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  writeFileSync(join(dir, 'tracked.txt'), 'v2\n')
  git(dir, 'add', 'tracked.txt')
  git(dir, 'commit', '-m', 'chore(v5): second commit')
  const headSha = git(dir, 'rev-parse', 'HEAD')

  const runHook = (stdinLine: string) =>
    spawnSync('bash', [join(dir, '.githooks/pre-push'), 'origin', 'https://example.invalid/repo.git'], {
      cwd: dir,
      input: `${stdinLine}\n`,
      encoding: 'utf8',
      env: {
        ...process.env,
        OC_PRE_PUSH_TSX_BIN: fakeTsx,
      },
      timeout: 15_000,
    })

  const readLog = () => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  return { dir, baseSha, headSha, runHook, readLog }
}

test('.githooks/pre-push exists and is executable', () => {
  const st = statSync(HOOK_SRC)
  assert.ok((st.mode & 0o111) !== 0, '.githooks/pre-push must have executable permission bits')
})

test('non-protected feature branch push exits 0 without blocking even when worktree is dirty', (t) => {
  const f = createFixture(t, { trailerExit: 1, ratchetExit: 1, a0Mode: 'fail' })
  writeFileSync(join(f.dir, 'tracked.txt'), 'dirty uncommitted edit\n')
  const r = f.runHook(`refs/heads/feat/dev ${f.headSha} refs/heads/feat/dev ${f.baseSha}`)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(f.readLog(), [])
})

test('blocks deleting feat/v5-selfhost', (t) => {
  const f = createFixture(t)
  const r = f.runHook(`(delete) ${ZERO_SHA} ${TARGET_REF} ${f.baseSha}`)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /refusing to delete protected branch/)
})

test('blocks force-push / non-fast-forward history rewrite to feat/v5-selfhost', (t) => {
  const f = createFixture(t)
  // Create a diverged commit whose parent is baseSha (so headSha is NOT an ancestor of divergedSha)
  git(f.dir, 'checkout', '-b', 'diverged', f.baseSha)
  writeFileSync(join(f.dir, 'tracked.txt'), 'diverged\n')
  git(f.dir, 'add', 'tracked.txt')
  git(f.dir, 'commit', '-m', 'chore(v5): diverged')
  const divergedSha = git(f.dir, 'rev-parse', 'HEAD')

  const r = f.runHook(`refs/heads/diverged ${divergedSha} ${TARGET_REF} ${f.headSha}`)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /force-push \/ non-fast-forward/)
})

test('blocks pushing feat/v5-selfhost with dirty tracked files, but allows untracked scratch files', (t) => {
  const f = createFixture(t, { a0Mode: 'absent' })
  // Untracked file should NOT block normal development.
  writeFileSync(join(f.dir, 'scratch-notes.tmp'), 'temporary note\n')
  const okUntracked = f.runHook(`${TARGET_REF} ${f.headSha} ${TARGET_REF} ${f.baseSha}`)
  assert.equal(okUntracked.status, 0, okUntracked.stderr)

  // Unstaged tracked modification MUST block.
  writeFileSync(join(f.dir, 'tracked.txt'), 'uncommitted tracked edit\n')
  const blockedUnstaged = f.runHook(`${TARGET_REF} ${f.headSha} ${TARGET_REF} ${f.baseSha}`)
  assert.equal(blockedUnstaged.status, 1)
  assert.match(blockedUnstaged.stderr, /tracked working tree has uncommitted changes/)

  // Staged uncommitted modification MUST also block.
  git(f.dir, 'add', 'tracked.txt')
  const blockedStaged = f.runHook(`${TARGET_REF} ${f.headSha} ${TARGET_REF} ${f.baseSha}`)
  assert.equal(blockedStaged.status, 1)
  assert.match(blockedStaged.stderr, /tracked working tree has uncommitted changes/)
})

test('fast-forward push runs trailers + incremental file-size ratchet + optional check-a0-monotonic', (t) => {
  const f = createFixture(t, { a0Mode: 'pass' })
  const r = f.runHook(`${TARGET_REF} ${f.headSha} ${TARGET_REF} ${f.baseSha}`)
  assert.equal(r.status, 0, r.stderr)
  const calls = f.readLog()
  assert.equal(calls.length, 3, JSON.stringify(calls))
  assert.match(calls[0]!, new RegExp(`^trailers:.*--head ${f.headSha}`))
  assert.equal(calls[1], `tsx:check-file-size-ratchet.ts:--base ${f.baseSha} --head ${f.headSha}`)
  assert.equal(calls[2], `tsx:check-a0-monotonic.ts:--base ${f.baseSha}`)
})

test('fails closed when any of trailers, file-size ratchet, or check-a0-monotonic fails', (t) => {
  const badTrailer = createFixture(t, { trailerExit: 1, a0Mode: 'pass' })
  assert.equal(
    badTrailer.runHook(`${TARGET_REF} ${badTrailer.headSha} ${TARGET_REF} ${badTrailer.baseSha}`).status,
    1,
  )

  const badRatchet = createFixture(t, { ratchetExit: 1, a0Mode: 'pass' })
  assert.equal(
    badRatchet.runHook(`${TARGET_REF} ${badRatchet.headSha} ${TARGET_REF} ${badRatchet.baseSha}`).status,
    1,
  )

  const badA0 = createFixture(t, { a0Mode: 'fail' })
  assert.equal(
    badA0.runHook(`${TARGET_REF} ${badA0.headSha} ${TARGET_REF} ${badA0.baseSha}`).status,
    1,
  )
})
