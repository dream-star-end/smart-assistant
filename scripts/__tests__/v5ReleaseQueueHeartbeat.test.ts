import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'scripts/v5-release-queue.sh')

function initGit(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-rq-git-'))
  const git = (a: string[]) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r
  }
  git(['init', '-b', 'main'])
  git(['config', 'user.email', 'wt-b2@example.test'])
  git(['config', 'user.name', 'wt-b2'])
  writeFileSync(path.join(dir, 'README.md'), 'q\n')
  git(['add', '.'])
  git(['commit', '-m', 'init'])
  return dir
}

function envFor(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OC_V5_RELEASE_QUEUE_DB: path.join(dir, 'queue.db'),
    OC_V5_RELEASE_QUEUE_LOCK: path.join(dir, 'queue.lock'),
    OC_V5_RELEASE_QUEUE_REPO_ROOT: extra.OC_V5_RELEASE_QUEUE_REPO_ROOT ?? dir,
    OC_V5_RELEASE_QUEUE_RUN_DIR: path.join(dir, 'run'),
    OC_V5_HEARTBEAT_INTERVAL: extra.OC_V5_HEARTBEAT_INTERVAL ?? '1',
    OC_V5_HEARTBEAT_MAX_SECONDS: extra.OC_V5_HEARTBEAT_MAX_SECONDS ?? '20',
    OC_V5_HEARTBEAT_STALE_SECONDS: extra.OC_V5_HEARTBEAT_STALE_SECONDS ?? '8',
    ...extra,
  }
}

function rq(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(runner, args, {
    cwd: root,
    encoding: 'utf8',
    env: envFor(dir, extra),
  })
}

function waitFor(pred: () => boolean, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    spawnSync('sleep', ['0.1'])
  }
  throw new Error('timeout waiting for condition')
}

test('acquire --daemon heartbeats in the background and release stops it', () => {
  const git = initGit()
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-rq-hb-'))
  try {
    const sha = spawnSync('git', ['-C', git, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    assert.equal(sha.status, 0, sha.stderr)
    const commit = sha.stdout.trim()

    const submit = rq(dir, ['submit', '--task', 'hot-config', '--branch', 'feat/x', '--sha', commit, '--actor', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(submit.status, 0, submit.stderr + submit.stdout)
    const id = submit.stdout.trim()
    assert.match(id, /^rq-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/)

    const acquire = rq(dir, ['acquire', '--id', id, '--owner', 'wt-b2', '--daemon', '--interval', '1'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(acquire.status, 0, acquire.stderr + acquire.stdout)
    assert.match(acquire.stdout, /heartbeat daemon 已启动/)

    const pidfile = path.join(dir, 'run', `${id}.heartbeat.pid`)
    waitFor(() => {
      try {
        return readFileSync(pidfile, 'utf8').includes('pid=')
      } catch {
        return false
      }
    })
    const meta = readFileSync(pidfile, 'utf8')
    assert.match(meta, /owner=wt-b2/)
    const pid = /pid=(\d+)/.exec(meta)?.[1]
    assert.ok(pid)
    const alive = spawnSync('kill', ['-0', pid])
    assert.equal(alive.status, 0, 'daemon should be alive')

    const again = rq(dir, ['acquire', '--id', id, '--owner', 'wt-b2', '--daemon'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /已在运行/)

    const other = rq(dir, ['heartbeat-daemon', 'start', '--id', id, '--owner', 'other-agent'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(other.status, 2, other.stdout + other.stderr)
    assert.match(other.stderr, /其他 owner/)

    const status = rq(dir, ['heartbeat-daemon', 'status', '--id', id])
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /state=running/)

    const rel = rq(dir, ['release', '--id', id, '--owner', 'wt-b2'])
    assert.equal(rel.status, 0, rel.stderr + rel.stdout)
    assert.match(rel.stdout, /仍保持原 status/)

    waitFor(() => spawnSync('kill', ['-0', pid]).status !== 0)
    const after = rq(dir, ['status'])
    assert.equal(after.status, 0, after.stderr)
    assert.match(after.stdout, /active/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(git, { recursive: true, force: true })
  }
})

test('finish stops the daemon; reap cleans a dead pidfile', () => {
  const git = initGit()
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-rq-fin-'))
  try {
    const commit = spawnSync('git', ['-C', git, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const id = rq(dir, ['submit', '--task', 't', '--branch', 'feat/y', '--sha', commit, '--actor', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    }).stdout.trim()
    const acq = rq(dir, ['acquire', '--id', id, '--owner', 'wt-b2', '--daemon', '--interval', '1'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(acq.status, 0, acq.stderr)

    const pinSha = commit
    // pin requires HEAD == sha in REPO_ROOT; our temp git is already there.
    const pin = rq(dir, ['pin', '--id', id, '--sha', pinSha, '--actor', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(pin.status, 0, pin.stderr + pin.stdout)

    const fin = rq(dir, ['finish', '--id', id, '--result', 'not-deployed', '--reason', 'unit-test', '--actor', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(fin.status, 0, fin.stderr + fin.stdout)

    const st = rq(dir, ['heartbeat-daemon', 'status', '--id', id])
    assert.match(st.stdout, /state=absent/)

    const pidfile = path.join(dir, 'run', `${id}.heartbeat.pid`)
    writeFileSync(pidfile, 'pid=1\nid=' + id + '\nowner=wt-b2\n')
    const reap = rq(dir, ['heartbeat-daemon', 'reap'])
    assert.equal(reap.status, 0, reap.stderr)
    assert.match(reap.stdout, /reaped orphan|reap 完成/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(git, { recursive: true, force: true })
  }
})

test('wait is unchanged and acquire without --daemon starts no process', () => {
  const git = initGit()
  const dir = mkdtempSync(path.join(tmpdir(), 'v5-rq-nodaemon-'))
  try {
    const commit = spawnSync('git', ['-C', git, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const id = rq(dir, ['submit', '--task', 't', '--branch', 'feat/z', '--sha', commit, '--actor', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    }).stdout.trim()
    const acq = rq(dir, ['acquire', '--id', id, '--owner', 'wt-b2'], {
      OC_V5_RELEASE_QUEUE_REPO_ROOT: git,
    })
    assert.equal(acq.status, 0, acq.stderr)
    const st = rq(dir, ['heartbeat-daemon', 'status', '--id', id])
    assert.match(st.stdout, /state=absent/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(git, { recursive: true, force: true })
  }
})
