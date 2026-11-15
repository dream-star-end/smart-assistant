// OCV5-751: Tests for scripts/v5-selfhost-harness-autosave.sh using fake
// AUTOSAVE_DOCKER_BIN and AUTOSAVE_LOGGER_BIN backed by real temp git repos.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const script = path.join(root, 'scripts/v5-selfhost-harness-autosave.sh')

let dir: string
let remoteDir: string
let repoDir: string
let statusFile: string
let lockFile: string
let dockerCallsLog: string
let loggerCallsLog: string
let fakeRootEntriesFile: string
let fakeDockerBin: string
let fakeLoggerBin: string

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function makeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    AUTOSAVE_CONTAINER: 'test-container',
    AUTOSAVE_REPO_DIR: repoDir,
    AUTOSAVE_AGENT_UID: '1000',
    AUTOSAVE_AGENT_GID: '1000',
    AUTOSAVE_REMOTE: 'origin',
    AUTOSAVE_BRANCH: 'main',
    AUTOSAVE_STATUS_FILE: statusFile,
    AUTOSAVE_LOCK_FILE: lockFile,
    AUTOSAVE_DOCKER_BIN: fakeDockerBin,
    AUTOSAVE_LOGGER_BIN: fakeLoggerBin,
    FAKE_DOCKER_LOG: dockerCallsLog,
    FAKE_LOGGER_LOG: loggerCallsLog,
    FAKE_ROOT_ENTRIES_FILE: fakeRootEntriesFile,
    ...extra,
  }
}

function runAutosave(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], {
    env: makeEnv(extraEnv),
    encoding: 'utf8',
    timeout: 20_000,
  })
}

function readStatus(): Record<string, unknown> {
  return JSON.parse(readFileSync(statusFile, 'utf8')) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ocv5-751-autosave-'))
  remoteDir = path.join(dir, 'remote.git')
  repoDir = path.join(dir, 'repo')
  statusFile = path.join(dir, 'state', 'harness-autosave-status.json')
  lockFile = path.join(dir, 'run', 'harness-autosave.lock')
  dockerCallsLog = path.join(dir, 'docker-calls.log')
  loggerCallsLog = path.join(dir, 'logger-calls.log')
  fakeRootEntriesFile = path.join(dir, 'fake-root-entries.txt')
  fakeDockerBin = path.join(dir, 'fake-docker.sh')
  fakeLoggerBin = path.join(dir, 'fake-logger.sh')

  mkdirSync(remoteDir, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir])

  mkdirSync(repoDir, { recursive: true })
  gitIn(repoDir, ['init', '--initial-branch=main'])
  gitIn(repoDir, ['config', 'user.email', 'agent@example.com'])
  gitIn(repoDir, ['config', 'user.name', 'Agent'])
  gitIn(repoDir, ['remote', 'add', 'origin', remoteDir])
  writeFileSync(path.join(repoDir, 'MEMORY.md'), '# init\n')
  gitIn(repoDir, ['add', 'MEMORY.md'])
  gitIn(repoDir, ['commit', '-m', 'initial'])
  gitIn(repoDir, ['push', '-u', 'origin', 'main'])

  writeFileSync(
    fakeDockerBin,
    `#!/usr/bin/env bash
set -euo pipefail
sub="$1"; shift
[[ "$sub" == "exec" ]] || { echo "unexpected docker subcommand: $sub" >&2; exit 2; }
u=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -u) u="$2"; shift 2 ;;
    *) break ;;
  esac
done
container="$1"; shift
printf 'u=%s container=%s cmd=%s\\n' "$u" "$container" "$*" >>"$FAKE_DOCKER_LOG"

if [[ "$1" == "find" ]]; then
  [[ "$u" == "0" ]] || { echo "find must run as uid 0" >&2; exit 99; }
  if [[ -n "\${FAKE_FIND_FAIL:-}" ]]; then
    echo "simulated find failure" >&2
    exit 1
  fi
  if [[ "$*" == *"-exec chown -h"* ]]; then
    if [[ -n "\${FAKE_CHOWN_FAIL:-}" ]]; then
      echo "simulated chown failure" >&2
      exit 1
    fi
    if [[ -z "\${FAKE_CHOWN_STUBBORN:-}" ]]; then
      : >"$FAKE_ROOT_ENTRIES_FILE"
    fi
    exit 0
  fi
  if [[ -f "$FAKE_ROOT_ENTRIES_FILE" ]]; then
    cat "$FAKE_ROOT_ENTRIES_FILE"
  fi
  exit 0
fi

if [[ "$1" == "git" ]]; then
  [[ "$u" == "1000:1000" ]] || { echo "git must run as 1000:1000, got $u" >&2; exit 98; }
  shift
  # Expect -C <repo>
  if [[ "$1" == "-C" ]]; then
    repo="$2"; shift 2
  else
    echo "expected git -C" >&2; exit 2
  fi
  subgit="\${1:-}"
  if [[ -n "\${FAKE_FAIL_GIT_SUBCMD:-}" && "$subgit" == "$FAKE_FAIL_GIT_SUBCMD" ]]; then
    printf 'simulated %s failure\\nwith newline\\n' "$subgit" >&2
    exit 1
  fi
  exec git -C "$repo" "$@"
fi

echo "unexpected command: $*" >&2
exit 2
`,
  )
  chmodSync(fakeDockerBin, 0o755)

  writeFileSync(
    fakeLoggerBin,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_LOGGER_LOG"
`,
  )
  chmodSync(fakeLoggerBin, 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('v5-selfhost-harness-autosave.sh', () => {
  test('--status reports not installed before any run', () => {
    const r = runAutosave(['--status'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { installed: false })
  })

  test('clean no-op runs git as 1000:1000 and writes atomic 0644 status JSON', () => {
    const initialSha = gitIn(repoDir, ['rev-parse', 'HEAD'])
    const r = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T01:00:00Z' })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

    const status = readStatus()
    assert.equal(status.schema, 1)
    assert.equal(status.checkedAt, '2026-11-15T01:00:00Z')
    assert.equal(status.lastOkAt, '2026-11-15T01:00:00Z')
    assert.equal(status.lastCommitSha, initialSha)
    assert.equal(status.dirtyCount, 0)
    assert.equal(status.dirtySince, null)
    assert.equal(status.nonAgentGitEntries, 0)
    assert.equal(status.lastHealedAt, null)
    assert.equal(status.lastHealedCount, 0)
    assert.equal(status.lastFailAt, null)
    assert.equal(status.lastError, null)
    assert.equal(status.consecutiveFailures, 0)

    assert.equal(statSync(statusFile).mode & 0o777, 0o644)
    const stateEntries = readdirSync(path.dirname(statusFile))
    assert.deepEqual(stateEntries, ['harness-autosave-status.json'])

    const calls = readFileSync(dockerCallsLog, 'utf8').trim().split('\n')
    const gitCalls = calls.filter((line) => line.includes(' cmd=git '))
    assert.ok(gitCalls.length >= 4)
    for (const line of gitCalls) {
      assert.match(line, /^u=1000:1000 /)
    }
    assert.equal(existsSync(loggerCallsLog), false)

    const st = runAutosave(['--status'])
    assert.equal(st.status, 0)
    assert.deepEqual(JSON.parse(st.stdout), status)
  })

  test('dirty repo commits and pushes to bare remote as uid 1000', () => {
    const beforeSha = gitIn(repoDir, ['rev-parse', 'HEAD'])
    writeFileSync(path.join(repoDir, 'notes.md'), 'hello autosave\n')

    const r = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T02:00:00Z' })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

    const remoteSha = gitIn(remoteDir, ['rev-parse', 'main'])
    assert.notEqual(remoteSha, beforeSha)
    assert.equal(
      gitIn(repoDir, ['log', '-1', '--format=%s']),
      gitIn(remoteDir, ['log', '-1', '--format=%s', 'main']),
    )
    assert.match(gitIn(repoDir, ['log', '-1', '--format=%s']), /^autosave /)

    const status = readStatus()
    assert.equal(status.lastCommitSha, remoteSha)
    assert.equal(status.dirtyCount, 0)
    assert.equal(status.dirtySince, null)
    assert.equal(status.lastOkAt, '2026-11-15T02:00:00Z')
    assert.equal(status.consecutiveFailures, 0)
  })

  test('non-1000 .git entries trigger oc-autosave-fail log, chown -h heal, and commit', () => {
    writeFileSync(
      fakeRootEntriesFile,
      `${repoDir}/.git/objects/aa/deadbeef\n${repoDir}/.git/objects/bb/cafebabe\n`,
    )
    writeFileSync(path.join(repoDir, 'healed.md'), 'after heal\n')

    const r = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T03:00:00Z' })
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)

    const loggerOut = readFileSync(loggerCallsLog, 'utf8')
    assert.match(
      loggerOut,
      new RegExp(
        `-t oc-autosave-fail detected 2 non-uid-1000 entries in ${repoDir}/.git; healing ownership`,
      ),
    )

    const dockerOut = readFileSync(dockerCallsLog, 'utf8')
    assert.match(dockerOut, /u=0 .*find .* ! -user 1000 -exec chown -h 1000:1000 \{\} \+/)

    const status = readStatus()
    assert.equal(status.nonAgentGitEntries, 0)
    assert.equal(status.lastHealedAt, '2026-11-15T03:00:00Z')
    assert.equal(status.lastHealedCount, 2)
    assert.equal(status.consecutiveFailures, 0)
    assert.equal(status.dirtyCount, 0)
    assert.equal(status.lastOkAt, '2026-11-15T03:00:00Z')
  })

  test('unhealable .git ownership records nonAgentGitEntries and exits 1', () => {
    writeFileSync(fakeRootEntriesFile, `${repoDir}/.git/objects/cc/123456\n`)
    const r = runAutosave(['--once'], {
      AUTOSAVE_NOW_ISO: '2026-11-15T03:30:00Z',
      FAKE_CHOWN_STUBBORN: '1',
    })
    assert.equal(r.status, 1)

    const status = readStatus()
    assert.equal(status.nonAgentGitEntries, 1)
    assert.equal(status.consecutiveFailures, 1)
    assert.equal(status.lastFailAt, '2026-11-15T03:30:00Z')
    assert.match(String(status.lastError), /ownership heal incomplete/)
    assert.match(
      readFileSync(loggerCallsLog, 'utf8'),
      /-t oc-autosave-fail ownership heal incomplete/,
    )
  })

  test('git add and git push failures log oc-autosave-fail, increment consecutiveFailures, and preserve dirtySince & lastOkAt', () => {
    const okRun = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T04:00:00Z' })
    assert.equal(okRun.status, 0)
    const okSha = readStatus().lastCommitSha

    writeFileSync(path.join(repoDir, 'stuck.md'), 'dirty file\n')

    const fail1 = runAutosave(['--once'], {
      AUTOSAVE_NOW_ISO: '2026-11-15T04:15:00Z',
      FAKE_FAIL_GIT_SUBCMD: 'add',
    })
    assert.equal(fail1.status, 1)
    let st = readStatus()
    assert.equal(st.lastOkAt, '2026-11-15T04:00:00Z')
    assert.equal(st.lastCommitSha, okSha)
    assert.equal(st.dirtyCount, 1)
    assert.equal(st.dirtySince, '2026-11-15T04:15:00Z')
    assert.equal(st.lastFailAt, '2026-11-15T04:15:00Z')
    assert.equal(st.consecutiveFailures, 1)
    assert.equal(String(st.lastError).includes('\n'), false)
    assert.ok(String(st.lastError).length <= 300)
    assert.match(String(st.lastError), /git add -A failed/)

    const fail2 = runAutosave(['--once'], {
      AUTOSAVE_NOW_ISO: '2026-11-15T06:30:00Z',
      FAKE_FAIL_GIT_SUBCMD: 'push',
    })
    assert.equal(fail2.status, 1)
    st = readStatus()
    assert.equal(st.lastOkAt, '2026-11-15T04:00:00Z')
    assert.equal(st.lastCommitSha, okSha)
    assert.equal(st.dirtyCount, 0)
    assert.equal(st.dirtySince, null)
    assert.equal(st.lastFailAt, '2026-11-15T06:30:00Z')
    assert.equal(st.consecutiveFailures, 2)
    assert.match(String(st.lastError), /git push failed/)

    // Re-dirty and fail again, then verify dirtySince persists across consecutive dirty failures
    writeFileSync(path.join(repoDir, 'stuck2.md'), 'dirty 2\n')
    const fail3 = runAutosave(['--once'], {
      AUTOSAVE_NOW_ISO: '2026-11-15T06:45:00Z',
      FAKE_FAIL_GIT_SUBCMD: 'add',
    })
    assert.equal(fail3.status, 1)
    st = readStatus()
    assert.equal(st.dirtySince, '2026-11-15T06:45:00Z')
    assert.equal(st.consecutiveFailures, 3)

    const fail4 = runAutosave(['--once'], {
      AUTOSAVE_NOW_ISO: '2026-11-15T07:00:00Z',
      FAKE_FAIL_GIT_SUBCMD: 'add',
    })
    assert.equal(fail4.status, 1)
    st = readStatus()
    assert.equal(st.dirtySince, '2026-11-15T06:45:00Z')
    assert.equal(st.consecutiveFailures, 4)

    const loggerLines = readFileSync(loggerCallsLog, 'utf8').trim().split('\n')
    assert.equal(loggerLines.length, 4)
    for (const line of loggerLines) {
      assert.match(line, /^-t oc-autosave-fail /)
    }

    const recover = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T07:15:00Z' })
    assert.equal(recover.status, 0, `${recover.stdout}${recover.stderr}`)
    st = readStatus()
    assert.equal(st.lastOkAt, '2026-11-15T07:15:00Z')
    assert.equal(st.lastFailAt, '2026-11-15T07:00:00Z')
    assert.equal(st.lastError, null)
    assert.equal(st.consecutiveFailures, 0)
    assert.equal(st.dirtyCount, 0)
    assert.equal(st.dirtySince, null)
  })

  test('lock contention exits 0 without clobbering status', async () => {
    mkdirSync(path.dirname(statusFile), { recursive: true })
    mkdirSync(path.dirname(lockFile), { recursive: true })
    const sentinel = { schema: 1, sentinel: 'keep-me' }
    writeFileSync(statusFile, JSON.stringify(sentinel))

    const readyFile = path.join(dir, 'lock-ready')
    const holder = spawn('bash', [
      '-c',
      'exec 9>"$1"; flock -x 9; touch "$2"; sleep 10',
      'holder',
      lockFile,
      readyFile,
    ])

    try {
      const deadline = Date.now() + 5000
      while (!existsSync(readyFile) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.equal(existsSync(readyFile), true, 'lock holder did not acquire lock in time')

      const r = runAutosave(['--once'], { AUTOSAVE_NOW_ISO: '2026-11-15T05:00:00Z' })
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
      assert.deepEqual(readStatus(), sentinel)
      assert.equal(existsSync(dockerCallsLog), false)
    } finally {
      holder.kill('SIGKILL')
    }
  })
})
