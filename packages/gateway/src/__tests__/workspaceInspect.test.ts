import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Gateway, isFileAllowed, isFileBlocked } from '../server.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'
import { WORKSPACE_INSPECT_MAX_JSON_BYTES } from '@openclaude/protocol'
import {
  collectGitSnapshot,
  collectListDir,
  GIT_HERMETIC_ARGS,
  hasGitPathSegment,
  isLinuxFdAnchorAvailable,
  lastGitKillReasonForTests,
  lastOpendirPathForTests,
  lastTrustedGitDirForTests,
  parseGitHead,
  parseGitNumstatZ,
  parseGitStatusZ,
  parseRelPath,
  parseSessionId,
  releaseInspect,
  resetInspectLimiterForTests,
  setInspectTimeoutOverrideForTests,
  setWorkspaceInspectAfterObjectsFdForTests,
  setWorkspaceInspectAfterGitSpawnForTests,
  setWorkspaceInspectHoldForTests,
  setWorkspaceInspectReposRootOverrideForTests,
  setWorkspaceInspectSnapshotOverrideForTests,
  tryAcquireInspect,
  type WorkspaceInspectRuntime,
} from '../workspaceInspect.js'

const ENV_KEY = 'OC_V3_TRUSTED_FILE_SERVE'

function readySnap(workspaceDir: string, version = 1): RepoSnapshot {
  return {
    status: 'ready',
    selectionVersion: version,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    workspaceDir,
    headSha: 'a'.repeat(40),
    errorCode: null,
    errorMessage: null,
  }
}

function makeRt(
  workspaceDir: string,
  reposRoot: string,
  sessionId = 'sess-1',
  snap: RepoSnapshot | null = readySnap(workspaceDir),
): WorkspaceInspectRuntime {
  return {
    getRepoSnapshot: (id) => (id === sessionId ? snap : null),
    reposRoot,
    acl: {
      isFileAllowed: (p) => isFileAllowed(p),
      isFileBlocked,
    },
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 't@t.example'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
}

describe('parseGitStatusZ / parseGitNumstatZ', () => {
  it('parses rename records by destination path', () => {
    const status = Buffer.from('R  new-name\0old-name\0M  kept.txt\0')
    const st = parseGitStatusZ(status, 50)
    assert.deepEqual(st.entries.map((e) => e.path), ['new-name', 'kept.txt'])
    const num = parseGitNumstatZ(Buffer.from(`1\t1\t\0old-name\0new-name\0` + `3\t0\tkept.txt\0`))
    assert.equal(num.entries.find((e) => e.path === 'new-name')?.added, 1)
    assert.equal(num.entries.find((e) => e.path === 'kept.txt')?.added, 3)
  })

  it('parses copy records by destination path', () => {
    const st = parseGitStatusZ(Buffer.from('C  dest.txt\0src.txt\0'), 50)
    assert.deepEqual(st.entries.map((e) => e.path), ['dest.txt'])
    assert.equal(st.entries[0]?.xy[0], 'C')
  })

  it('parses worktree rename/copy from the Y column', () => {
    const renamed = parseGitStatusZ(Buffer.from(' R dest.txt\0orig.txt\0M  kept.txt\0'), 50)
    assert.deepEqual(renamed.entries.map((e) => e.path), ['dest.txt', 'kept.txt'])
    const copied = parseGitStatusZ(Buffer.from(' C dest.txt\0src.txt\0'), 50)
    assert.deepEqual(copied.entries.map((e) => e.path), ['dest.txt'])
  })
})

describe('parseGitHead', () => {
  it('accepts a single trailing LF and rejects other shapes', () => {
    const sha = 'a'.repeat(40)
    assert.deepEqual(parseGitHead(Buffer.from(`${sha}\n`)), { kind: 'sha', sha })
    assert.deepEqual(parseGitHead(Buffer.from('ref: refs/heads/main\n')), {
      kind: 'ref',
      rel: 'refs/heads/main',
    })
    assert.equal(parseGitHead(Buffer.from(' ref: refs/heads/main\n')), null)
    assert.equal(parseGitHead(Buffer.from('ref: refs/heads/main\r\n')), null)
    assert.equal(parseGitHead(Buffer.from('ref: refs/heads/main\nextra\n')), null)
    assert.equal(parseGitHead(Buffer.from('ref: ../../tmp/x\n')), null)
    assert.equal(parseGitHead(Buffer.from('ref: /etc/passwd\n')), null)
  })
})

describe('hasGitPathSegment', () => {
  it('matches exact .git segments only', () => {
    assert.equal(hasGitPathSegment('/home/agent/repo/.git/config'), true)
    assert.equal(hasGitPathSegment('/home/agent/repo/.git'), true)
    assert.equal(hasGitPathSegment('/home/agent/foo.git'), false)
    assert.equal(hasGitPathSegment('/home/agent/.github/workflows'), false)
    assert.equal(hasGitPathSegment('/home/agent/bar.git.bak'), false)
  })
})

describe('parseSessionId / parseRelPath', () => {
  it('accepts safe session ids and rejects others', () => {
    assert.equal(parseSessionId('sess-1'), 'sess-1')
    assert.equal(parseSessionId('bad;rm'), null)
    assert.equal(parseSessionId('../x'), null)
  })

  it('rejects traversal and control characters', () => {
    assert.equal(parseRelPath('').ok, true)
    assert.equal(parseRelPath('src/a.ts').ok, true)
    assert.equal(parseRelPath('../etc').ok, false)
    assert.equal(parseRelPath('/etc/passwd').ok, false)
    assert.equal(parseRelPath('foo\\bar').ok, false)
    assert.equal(parseRelPath('a/./b').ok, false)
    assert.equal(parseRelPath('C:foo').ok, false)
    assert.equal(parseRelPath('foo\0bar').ok, false)
    assert.equal(parseRelPath('a/'.repeat(40)).ok, false)
  })
})

describe('workspace inspect collection', () => {
  let tmp: string
  let reposRoot: string
  let workspaceDir: string
  let prevTrusted: string | undefined

  beforeEach(() => {
    prevTrusted = process.env[ENV_KEY]
    process.env[ENV_KEY] = '1'
    resetInspectLimiterForTests()
    tmp = mkdtempSync(join(tmpdir(), 'oc-inspect-'))
    reposRoot = join(tmp, 'repos')
    workspaceDir = join(reposRoot, 'sess-1', '1')
    initRepo(workspaceDir)
  })

  afterEach(() => {
    setWorkspaceInspectAfterObjectsFdForTests(undefined)
    resetInspectLimiterForTests()
    if (prevTrusted === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevTrusted
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns empty without a ready snapshot and never includes added:0', async () => {
    const rt = makeRt(workspaceDir, reposRoot, 'sess-1', null)
    const result = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(result.kind, 'empty')
    if (result.kind !== 'empty') return
    assert.equal(result.body.snapshot, null)
    assert.equal(JSON.stringify(result.body).includes('"added"'), false)
  })

  it('rejects path traversal variants', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    for (const p of ['../git-creds/token', '/etc/passwd', 'foo\\..\\etc', 'a/../b', '..']) {
      const r = await collectListDir(rt, 'sess-1', p)
      assert.equal(r.kind, 'error', p)
      if (r.kind === 'error') assert.equal(r.body.error.code, 'BAD_PATH')
    }
  })

  it('rejects symlink targets pointing at /etc and git-creds', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    symlinkSync('/etc', join(workspaceDir, 'etc_link'))
    const r1 = await collectListDir(rt, 'sess-1', 'etc_link')
    assert.equal(r1.kind, 'error')
    if (r1.kind === 'error') {
      assert.equal(r1.status, 403)
      assert.equal(r1.body.error.code, 'PATH_DENIED')
    }
    mkdirSync(join(tmp, 'git-creds'), { recursive: true })
    symlinkSync(join(tmp, 'git-creds'), join(workspaceDir, 'creds_link'))
    const r2 = await collectListDir(rt, 'sess-1', 'creds_link')
    assert.equal(r2.kind, 'error')
    if (r2.kind === 'error') assert.equal(r2.body.error.code, 'PATH_DENIED')
  })

  it('lists a child symlink as kind symlink without preview_path', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    symlinkSync('/etc/passwd', join(workspaceDir, 'tmp_link'))
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    const link = r.body.entries.find((e) => e.name === 'tmp_link')
    assert.equal(link?.kind, 'symlink')
    assert.equal(link?.preview_path, undefined)
  })

  it('returns 403 PATH_DENIED when listing .config or .ssh', async () => {
    mkdirSync(join(workspaceDir, '.config'), { recursive: true })
    mkdirSync(join(workspaceDir, '.ssh'), { recursive: true })
    writeFileSync(join(workspaceDir, '.config', 'x'), 'n')
    const rt = makeRt(workspaceDir, reposRoot)
    const c = await collectListDir(rt, 'sess-1', '.config')
    assert.equal(c.kind, 'error')
    if (c.kind === 'error') {
      assert.equal(c.status, 403)
      assert.equal(c.body.error.code, 'PATH_DENIED')
    }
    const s = await collectListDir(rt, 'sess-1', '.ssh')
    assert.equal(s.kind, 'error')
    if (s.kind === 'error') assert.equal(s.body.error.code, 'PATH_DENIED')
  })

  it('marks blocked child directories skipped/denied', async () => {
    mkdirSync(join(workspaceDir, '.config'), { recursive: true })
    mkdirSync(join(workspaceDir, '.ssh'), { recursive: true })
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    const cfg = r.body.entries.find((e) => e.name === '.config')
    const ssh = r.body.entries.find((e) => e.name === '.ssh')
    assert.equal(cfg?.kind, 'skipped')
    assert.equal(cfg?.reason, 'denied')
    assert.equal(ssh?.kind, 'skipped')
    assert.equal(ssh?.reason, 'denied')
  })

  it('skips node_modules as vendor and .git as vcs', async () => {
    mkdirSync(join(workspaceDir, 'node_modules'), { recursive: true })
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    assert.equal(r.body.entries.find((e) => e.name === 'node_modules')?.kind, 'skipped')
    assert.equal(r.body.entries.find((e) => e.name === '.git')?.kind, 'skipped')
    assert.equal(r.body.entries.find((e) => e.name === '.git')?.reason, 'vcs')
  })

  it('stream-truncates after 200 entries', async () => {
    for (let i = 0; i < 210; i++) {
      writeFileSync(join(workspaceDir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    assert.equal(r.body.truncated, true)
    assert.ok(r.body.entries.length <= 200)
    assert.equal(r.body.truncation?.omitted, 'unknown')
  })

  it('strips control characters from names', async () => {
    writeFileSync(join(workspaceDir, 'ok.txt'), 'x')
    try {
      writeFileSync(join(workspaceDir, 'bad\nname.txt'), 'x')
    } catch {
      // some filesystems reject newline names
    }
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    const parsed = JSON.parse(JSON.stringify(r.body)) as { cwd: string; entries: { name: string }[] }
    const blob = `${parsed.cwd}\n${parsed.entries.map((e) => e.name).join('\n')}`
    assert.equal(blob.includes('\nname'), false)
    assert.equal(blob.includes('\u001b'), false)
  })

  it('counts unsanitizable raw dirents toward the list cap', async () => {
    for (let i = 0; i < 180; i++) {
      writeFileSync(join(workspaceDir, `g${String(i).padStart(3, '0')}.txt`), 'x')
    }
    let hidden = 0
    for (let i = 1; i < 32; i++) {
      if (i === 9 || i === 10 || i === 13) continue
      try {
        writeFileSync(join(workspaceDir, String.fromCharCode(i)), 'x')
        hidden++
      } catch {
        /* filesystem rejected the name */
      }
    }
    for (let i = 1; i < 32; i++) {
      try {
        writeFileSync(join(workspaceDir, `\x01${String.fromCharCode(i)}\x7f`), 'x')
        hidden++
      } catch {
        /* filesystem rejected the name */
      }
    }
    assert.ok(hidden >= 9, `need enough hidden names to exceed the raw cap, got ${hidden}`)
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    assert.equal(r.body.truncated, true)
    assert.ok(r.body.entries.length <= 200)
  })

  it('asserts Linux list-dir uses /proc/self/fd', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    const meta = { usedProcSelfFd: false }
    await collectListDir(rt, 'sess-1', '', meta)
    if (isLinuxFdAnchorAvailable()) {
      assert.equal(meta.usedProcSelfFd, true)
      assert.ok(lastOpendirPathForTests?.startsWith('/proc/self/fd/'))
    }
  })

  it('returns 409 when snapshot identity changes', async () => {
    let calls = 0
    const rt: WorkspaceInspectRuntime = {
      getRepoSnapshot: () => {
        calls++
        return readySnap(workspaceDir, calls === 1 ? 1 : 2)
      },
      reposRoot,
      acl: { isFileAllowed: (p) => isFileAllowed(p), isFileBlocked },
    }
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'error')
    if (r.kind === 'error') {
      assert.equal(r.status, 409)
      assert.equal(r.body.error.code, 'WORKSPACE_CHANGED')
    }
  })

  it('rejects .git when it is a symlink', async () => {
    const hidden = join(tmp, 'hidden-git')
    rmSync(join(workspaceDir, '.git'), { recursive: true, force: true })
    mkdirSync(hidden, { recursive: true })
    symlinkSync(hidden, join(workspaceDir, '.git'))
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'error')
    if (r.kind === 'error') {
      assert.equal(r.status, 403)
      assert.equal(r.body.error.code, 'PATH_DENIED')
    }
  })

  it('does not escape via core.worktree=/etc', async () => {
    writeFileSync(
      join(workspaceDir, '.git', 'config'),
      `[core]\n\tworktree = /etc\n`,
      { flag: 'a' },
    )
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    const json = JSON.stringify(r)
    assert.equal(json.includes('/passwd'), false)
    assert.equal(json.includes('/shadow'), false)
    if (r.kind === 'ok' && 'snapshot' in r.body) {
      for (const e of r.body.snapshot.entries) {
        assert.equal(e.path.startsWith('/'), false)
        assert.equal(e.path.includes('passwd'), false)
      }
    }
  })

  it('does not execute hooks or fsmonitor', async () => {
    const sentinel = join(tmp, 'hook-ran')
    mkdirSync(join(workspaceDir, '.git', 'hooks'), { recursive: true })
    writeFileSync(
      join(workspaceDir, '.git', 'hooks', 'post-status'),
      `#!/bin/sh\necho ran > "${sentinel}"\n`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(workspaceDir, '.git', 'config'),
      `\n[core]\n\tfsmonitor = /bin/sh -c 'echo ran > "${sentinel}"'\n`,
      { flag: 'a' },
    )
    const rt = makeRt(workspaceDir, reposRoot)
    await collectGitSnapshot(rt, 'sess-1')
    assert.equal(existsSync(sentinel), false)
  })

  it('returns live HEAD with authority live', async () => {
    writeFileSync(join(workspaceDir, 'changed.txt'), 'x')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    assert.equal(r.body.snapshot.live_head.authority, 'live')
    assert.equal(r.body.snapshot.live_head.sha.length, 40)
    assert.equal(JSON.stringify(r.body).includes('"bind"'), false)
  })

  it('returns a live detached HEAD as ok with branch null', async () => {
    git(workspaceDir, ['checkout', '--detach', 'HEAD'])
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    assert.equal(r.body.snapshot.live_head.detached, true)
    assert.equal(r.body.snapshot.live_head.branch, null)
    assert.equal(r.body.snapshot.live_head.sha.length, 40)
  })

  it('does not execute filter clean/process from repo config', async () => {
    const sentinel = join(tmp, 'filter-ran')
    writeFileSync(
      join(workspaceDir, '.git', 'config'),
      `\n[filter "pwn"]\n\tclean = touch "${sentinel}"\n\tprocess = touch "${sentinel}"\n`,
      { flag: 'a' },
    )
    writeFileSync(join(workspaceDir, '.gitattributes'), '* filter=pwn\n')
    writeFileSync(join(workspaceDir, 'changed.txt'), 'x')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    assert.equal(existsSync(sentinel), false)
  })

  it('treats gitfile .git as not_a_repo', async () => {
    rmSync(join(workspaceDir, '.git'), { recursive: true, force: true })
    writeFileSync(join(workspaceDir, '.git'), 'gitdir: /tmp/other-git\n')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'empty')
    if (r.kind === 'empty') assert.equal(r.body.reason, 'not_a_repo')
  })

  it('rejects a malicious HEAD symbolic ref', async () => {
    writeFileSync(join(workspaceDir, '.git', 'HEAD'), 'ref: ../../tmp/x\n')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'empty')
    if (r.kind === 'empty') assert.equal(r.body.reason, 'not_a_repo')
  })

  it('rejects HEAD with leading whitespace or extra lines', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    writeFileSync(join(workspaceDir, '.git', 'HEAD'), ' ref: refs/heads/main\n')
    const r1 = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r1.kind, 'empty')
    writeFileSync(join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\nextra\n')
    const r2 = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r2.kind, 'empty')
  })

  it('rejects objects when it is a symlink', async () => {
    const objects = join(workspaceDir, '.git', 'objects')
    const moved = join(tmp, 'objects-real')
    rmSync(moved, { recursive: true, force: true })
    renameSync(objects, moved)
    symlinkSync(moved, objects)
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'empty')
    if (r.kind === 'empty') assert.equal(r.body.reason, 'not_a_repo')
  })

  it('does not follow objects swap after ofd is opened', async () => {
    if (!isLinuxFdAnchorAvailable()) return
    writeFileSync(join(workspaceDir, 'README.md'), 'hello\nchanged\n')
    setWorkspaceInspectAfterObjectsFdForTests(({ objectsPath }) => {
      const moved = `${objectsPath}.orig`
      renameSync(objectsPath, moved)
      mkdirSync(objectsPath)
    })
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    assert.equal(r.body.snapshot.live_head.sha.length, 40)
    assert.ok(r.body.snapshot.entries.some((e) => e.path === 'README.md'))
  })

  it('fails immediately on FIFO HEAD and removes the trusted gitdir', async () => {
    const head = join(workspaceDir, '.git', 'HEAD')
    rmSync(head, { force: true })
    execFileSync('mkfifo', [head])
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.notEqual(r.kind, 'ok')
    assert.ok(!lastTrustedGitDirForTests || !existsSync(lastTrustedGitDirForTests))
  })

  it('fails oversized index and removes the trusted gitdir', async () => {
    writeFileSync(join(workspaceDir, '.git', 'index'), Buffer.alloc(9 * 1024 * 1024))
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.notEqual(r.kind, 'ok')
    assert.ok(!lastTrustedGitDirForTests || !existsSync(lastTrustedGitDirForTests))
  })

  it('strips DEL, C1, and bidi but keeps img markup', async () => {
    writeFileSync(join(workspaceDir, 'ok<img>x.txt'), 'x')
    try {
      writeFileSync(join(workspaceDir, `bad\u007fdel.txt`), 'x')
      writeFileSync(join(workspaceDir, `c1\u0085.txt`), 'x')
      writeFileSync(join(workspaceDir, `bidi\u202e.txt`), 'x')
    } catch {
      /* some filesystems reject these names */
    }
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    const parsed = JSON.parse(JSON.stringify(r.body)) as { cwd: string; entries: { name: string }[] }
    const blob = `${parsed.cwd}\n${parsed.entries.map((e) => e.name).join('\n')}`
    assert.equal(blob.includes('\u007f'), false)
    assert.equal(blob.includes('\u0085'), false)
    assert.equal(blob.includes('\u202e'), false)
    assert.ok(parsed.entries.some((e) => e.name.includes('<img>')))
  })

  it('reads packed-only refs without a loose ref file', async () => {
    git(workspaceDir, ['pack-refs', '--all', '--prune'])
    const head = readFileSync(join(workspaceDir, '.git', 'HEAD'), 'utf8').trim()
    assert.ok(head.startsWith('ref: '))
    const loose = join(workspaceDir, '.git', head.slice('ref: '.length))
    assert.equal(existsSync(loose), false)
    assert.equal(existsSync(join(workspaceDir, '.git', 'packed-refs')), true)
    const packed = readFileSync(join(workspaceDir, '.git', 'packed-refs'), 'utf8')
    assert.ok(packed.includes(head.slice('ref: '.length)))
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind === 'ok' && 'snapshot' in r.body) {
      assert.equal(r.body.snapshot.live_head.sha.length, 40)
    }
  })

  it('does not report a fake clean snapshot when git exits non-zero', async () => {
    rmSync(join(workspaceDir, '.git', 'objects'), { recursive: true, force: true })
    mkdirSync(join(workspaceDir, '.git', 'objects'), { recursive: true })
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.notEqual(r.kind, 'ok')
    assert.equal(JSON.stringify(r).includes('"added":0'), false)
  })

  it('does not preview a tracked symlink that points outside the workspace', async () => {
    symlinkSync('/etc/passwd', join(workspaceDir, 'leak'))
    git(workspaceDir, ['add', '-f', 'leak'])
    const rt = makeRt(workspaceDir, reposRoot)
    const listed = await collectListDir(rt, 'sess-1', '')
    assert.equal(listed.kind, 'ok')
    if (listed.kind === 'ok' && 'entries' in listed.body) {
      const leak = listed.body.entries.find((e) => e.name === 'leak')
      assert.equal(leak?.kind, 'symlink')
      assert.equal(leak?.preview_path, undefined)
    }
    const snap = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(snap.kind, 'ok')
    if (snap.kind === 'ok' && 'snapshot' in snap.body) {
      const leak = snap.body.snapshot.entries.find((e) => e.path === 'leak')
      assert.ok(leak)
      assert.equal(leak.previewable, false)
      assert.equal(leak.preview_path, undefined)
    }
  })

  it('sanitizes cwd in JSON.parse values', async () => {
    const raw = 'dir\u202e'
    mkdirSync(join(workspaceDir, raw), { recursive: true })
    writeFileSync(join(workspaceDir, raw, 'a.txt'), 'x')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectListDir(rt, 'sess-1', raw)
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('cwd' in r.body)) return
    const parsed = JSON.parse(JSON.stringify(r.body)) as { cwd: string }
    assert.equal(parsed.cwd.includes('\u202e'), false)
    assert.equal(parsed.cwd, 'dir')
  })

  it('does not preview an allowed file whose path contains T6 controls', async () => {
    const nasty = 'ok<img>' + '\u0085\u202e' + '.txt'
    writeFileSync(join(workspaceDir, nasty), 'x')
    writeFileSync(join(workspaceDir, 'ok<img>plain.txt'), 'x')
    const rt: WorkspaceInspectRuntime = {
      ...makeRt(workspaceDir, reposRoot),
      acl: { isFileAllowed: () => true, isFileBlocked },
    }
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('entries' in r.body)) return
    const wire = JSON.stringify(r.body)
    assert.equal(wire.includes('\u0085'), false)
    assert.equal(wire.includes('\u202e'), false)
    const nastyEntry = r.body.entries.find((e) => e.name === 'ok<img>.txt')
    assert.ok(nastyEntry, JSON.stringify(r.body.entries.map((e) => e.name)))
    assert.equal(nastyEntry?.previewable, false)
    assert.equal(nastyEntry?.preview_path, undefined)
    const clean = r.body.entries.find((e) => e.name === 'ok<img>plain.txt')
    const cleanPreview = clean?.preview_path ?? ''
    assert.ok(cleanPreview)
    assert.equal(cleanPreview.includes('<img>'), true)
    assert.equal(cleanPreview.includes('\u0085'), false)
  })


  it('reports git mv as renamed destination not origin', async () => {
    git(workspaceDir, ['mv', 'README.md', 'README2.md'])
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    const paths = r.body.snapshot.entries.map((e) => e.path)
    assert.equal(paths.includes('README2.md'), true)
    assert.equal(paths.includes('README.md'), false)
    const row = r.body.snapshot.entries.find((e) => e.path === 'README2.md')
    assert.equal(row?.status, 'renamed')
  })

  it('kills git at the entry cap and releases the inspect limiter', async () => {
    for (let i = 0; i < 520; i++) {
      writeFileSync(join(workspaceDir, `u${String(i).padStart(4, '0')}.txt`), 'x')
    }
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    assert.equal(r.body.snapshot.truncated, true)
    assert.equal(r.body.snapshot.truncation?.reason, 'max_entries')
    assert.ok(r.body.snapshot.entries.length <= 500)
    assert.equal(lastGitKillReasonForTests, 'entries')
    assert.equal(tryAcquireInspect('sess-1'), 'ok')
    releaseInspect('sess-1')
  })

  it('truncates git JSON to the wire 256KiB envelope', async () => {
    const seg = '测'.repeat(80)
    const rel = [seg, seg, seg].join('/')
    mkdirSync(join(workspaceDir, rel), { recursive: true })
    writeFileSync(join(workspaceDir, rel, '.keep'), '')
    git(workspaceDir, ['add', '--', join(rel, '.keep')])
    git(workspaceDir, ['commit', '-m', 'keep'])
    for (let i = 0; i < 400; i++) {
      writeFileSync(join(workspaceDir, rel, `f${i}.txt`), 'x')
    }
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
    if (r.kind !== 'ok' || !('snapshot' in r.body)) return
    const wire = JSON.stringify(r.body)
    assert.ok(Buffer.byteLength(wire, 'utf8') <= WORKSPACE_INSPECT_MAX_JSON_BYTES)
    assert.equal(r.body.snapshot.truncated, true)
    assert.equal(r.body.snapshot.truncation?.reason, 'byte_budget')
    assert.ok(r.body.snapshot.entries.length < 400)
  })

  it('returns 409 when only the workspace inode changes', async () => {
    const rt = makeRt(workspaceDir, reposRoot)
    setWorkspaceInspectHoldForTests(async () => {
      const prev = `${workspaceDir}.prev`
      renameSync(workspaceDir, prev)
      mkdirSync(workspaceDir, { recursive: true })
    })
    const r = await collectListDir(rt, 'sess-1', '')
    assert.equal(r.kind, 'error')
    if (r.kind === 'error') {
      assert.equal(r.status, 409)
      assert.equal(r.body.error.code, 'WORKSPACE_CHANGED')
    }
  })

  it('second acquire for the same session is immediate IN_FLIGHT', () => {
    const t0 = Date.now()
    assert.equal(tryAcquireInspect('sess-1'), 'ok')
    assert.equal(tryAcquireInspect('sess-1'), 'session')
    assert.ok(Date.now() - t0 < 50)
    assert.equal(tryAcquireInspect('sess-2'), 'ok')
    assert.equal(tryAcquireInspect('sess-3'), 'process')
    releaseInspect('sess-1')
    releaseInspect('sess-2')
  })
})

describe('hermetic git argv', () => {
  it('does not pass --no-lazy-fetch and is accepted by installed git', () => {
    assert.equal((GIT_HERMETIC_ARGS as readonly string[]).includes('--no-lazy-fetch'), false)
    execFileSync('git', [...GIT_HERMETIC_ARGS, 'version'], { stdio: 'ignore' })
  })
})

describe('workspace inspect HTTP handler', () => {
  it('returns 403 HOST_FORBIDDEN when OC_CONTAINER_ID is unset', async () => {
    const prev = process.env.OC_CONTAINER_ID
    delete process.env.OC_CONTAINER_ID
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/git-snapshot?sessionId=s1`)
      const body = await res.json() as { error?: { code?: string } }
      assert.equal(res.status, 403)
      assert.equal(body.error?.code, 'HOST_FORBIDDEN')
    } finally {
      if (prev !== undefined) process.env.OC_CONTAINER_ID = prev
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  it('second concurrent request for the same session is immediate 429', async () => {
    process.env.OC_CONTAINER_ID = '123'
    resetInspectLimiterForTests()
    assert.equal(tryAcquireInspect('sess-lock'), 'ok')
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const t0 = Date.now()
      const res = await fetch(`http://127.0.0.1:${port}/api/workspace/list-dir?sessionId=sess-lock`)
      const body = await res.json() as { error?: { code?: string } }
      assert.equal(res.status, 429)
      assert.equal(body.error?.code, 'IN_FLIGHT')
      assert.ok(Date.now() - t0 < 200)
    } finally {
      releaseInspect('sess-lock')
      resetInspectLimiterForTests()
      delete process.env.OC_CONTAINER_ID
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
    }
  })

  it('timeout response is 504 without a partial snapshot body', async () => {
    process.env.OC_CONTAINER_ID = '123'
    process.env[ENV_KEY] = '1'
    resetInspectLimiterForTests()
    const tmp = mkdtempSync(join(tmpdir(), 'oc-inspect-http-'))
    const reposRoot = join(tmp, 'repos')
    const workspaceDir = join(reposRoot, 'sess-1', '1')
    initRepo(workspaceDir)
    setWorkspaceInspectReposRootOverrideForTests(reposRoot)
    setWorkspaceInspectSnapshotOverrideForTests(() => readySnap(workspaceDir))
    setInspectTimeoutOverrideForTests({ git: 300 })
    setWorkspaceInspectAfterGitSpawnForTests(() => new Promise<void>((resolve) => { setTimeout(resolve, 1500) }))
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch('http://127.0.0.1:' + port + '/api/workspace/git-snapshot?sessionId=sess-1')
      const text = await res.text()
      assert.equal(res.status, 504)
      const body = JSON.parse(text)
      assert.equal(body.ok, false)
      assert.equal(body.error?.code, 'GIT_TIMEOUT')
      assert.equal('entries' in body, false)
      assert.equal('snapshot' in body, false)
    } finally {
      await new Promise<void>((r) => { setTimeout(r, 1800) })
      setWorkspaceInspectAfterGitSpawnForTests(undefined)
      setInspectTimeoutOverrideForTests(undefined)
      setWorkspaceInspectReposRootOverrideForTests(undefined)
      setWorkspaceInspectSnapshotOverrideForTests(undefined)
      resetInspectLimiterForTests()
      delete process.env.OC_CONTAINER_ID
      rmSync(tmp, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())) })
    }
  })

  it('HTTP git-snapshot entry cap kills git and releases the limiter', async () => {
    process.env.OC_CONTAINER_ID = '123'
    process.env[ENV_KEY] = '1'
    resetInspectLimiterForTests()
    const tmp = mkdtempSync(join(tmpdir(), 'oc-inspect-http-'))
    const reposRoot = join(tmp, 'repos')
    const workspaceDir = join(reposRoot, 'sess-1', '1')
    initRepo(workspaceDir)
    for (let i = 0; i < 520; i++) {
      writeFileSync(join(workspaceDir, `u${String(i).padStart(4, '0')}.txt`), 'x')
    }
    setWorkspaceInspectReposRootOverrideForTests(reposRoot)
    setWorkspaceInspectSnapshotOverrideForTests(() => readySnap(workspaceDir))
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch('http://127.0.0.1:' + port + '/api/workspace/git-snapshot?sessionId=sess-1')
      const body = await res.json() as {
        ok?: boolean
        snapshot?: { truncated?: boolean; truncation?: { reason?: string }; entries?: unknown[] }
      }
      assert.equal(res.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.snapshot?.truncated, true)
      assert.equal(body.snapshot?.truncation?.reason, 'max_entries')
      assert.ok((body.snapshot?.entries?.length ?? 999) <= 500)
      assert.equal(lastGitKillReasonForTests, 'entries')
      assert.equal(tryAcquireInspect('sess-1'), 'ok')
      releaseInspect('sess-1')
    } finally {
      setWorkspaceInspectReposRootOverrideForTests(undefined)
      setWorkspaceInspectSnapshotOverrideForTests(undefined)
      resetInspectLimiterForTests()
      delete process.env.OC_CONTAINER_ID
      rmSync(tmp, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())) })
    }
  })

  it('two real HTTP requests: second is immediate 429 while first is in flight', async () => {
    process.env.OC_CONTAINER_ID = '123'
    process.env[ENV_KEY] = '1'
    resetInspectLimiterForTests()
    const tmp = mkdtempSync(join(tmpdir(), 'oc-inspect-http-'))
    const reposRoot = join(tmp, 'repos')
    const workspaceDir = join(reposRoot, 'sess-1', '1')
    initRepo(workspaceDir)
    setWorkspaceInspectReposRootOverrideForTests(reposRoot)
    setWorkspaceInspectSnapshotOverrideForTests(() => readySnap(workspaceDir))
    let entered = false
    let releaseHold: () => void = () => {}
    setWorkspaceInspectHoldForTests(async () => {
      entered = true
      await new Promise<void>((resolve) => { releaseHold = resolve })
    })
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as AddressInfo).port
      const p1 = fetch('http://127.0.0.1:' + port + '/api/workspace/list-dir?sessionId=sess-1')
      const tWait = Date.now()
      while (!entered && Date.now() - tWait < 2000) {
        await new Promise<void>((r) => { setTimeout(r, 5) })
      }
      assert.equal(entered, true)
      const t0 = Date.now()
      const r2 = await fetch('http://127.0.0.1:' + port + '/api/workspace/list-dir?sessionId=sess-1')
      const b2 = await r2.json() as { error?: { code?: string } }
      assert.equal(r2.status, 429)
      assert.equal(b2.error?.code, 'IN_FLIGHT')
      assert.ok(Date.now() - t0 < 200)
      releaseHold()
      const r1 = await p1
      assert.notEqual(r1.status, 429)
    } finally {
      releaseHold()
      setWorkspaceInspectHoldForTests(undefined)
      setWorkspaceInspectReposRootOverrideForTests(undefined)
      setWorkspaceInspectSnapshotOverrideForTests(undefined)
      resetInspectLimiterForTests()
      delete process.env.OC_CONTAINER_ID
      rmSync(tmp, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())) })
    }
  })

  it('T6 control characters are absent from HTTP wire bytes', async () => {
    process.env.OC_CONTAINER_ID = '123'
    process.env[ENV_KEY] = '1'
    resetInspectLimiterForTests()
    const tmp = realpathSync(mkdtempSync('/tmp/openclaude-inspect-http-'))
    const reposRoot = join(tmp, 'repos')
    const workspaceDir = join(reposRoot, 'sess-1', '1')
    initRepo(workspaceDir)
    writeFileSync(join(workspaceDir, 'ok<img>' + '\u0085\u202e' + '.txt'), 'x')
    try {
      writeFileSync(join(workspaceDir, 'bad\u007fdel.txt'), 'x')
      writeFileSync(join(workspaceDir, 'c1\u0085.txt'), 'x')
      writeFileSync(join(workspaceDir, 'bidi\u202e.txt'), 'x')
    } catch {}
    setWorkspaceInspectReposRootOverrideForTests(reposRoot)
    setWorkspaceInspectSnapshotOverrideForTests(() => readySnap(workspaceDir))
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: 't' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'x', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [],
      } as never,
      agentsConfig: { agents: [] } as never,
    })
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void gw.handleWorkspaceInspectForTests(req, res, url)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const port = (server.address() as AddressInfo).port
      const res = await fetch('http://127.0.0.1:' + port + '/api/workspace/list-dir?sessionId=sess-1')
      const text = await res.text()
      assert.equal(res.status, 200)
      assert.equal(text.includes('\u007f'), false)
      assert.equal(text.includes('\u0085'), false)
      assert.equal(text.includes('\u202e'), false)
      assert.equal(text.includes('<img>'), true)
      const parsed = JSON.parse(text) as { entries?: Array<{ preview_path?: string; previewable?: boolean; name?: string }> }
      const nastyEntry = parsed.entries?.find((e) => e.name === 'ok<img>.txt')
      assert.equal(nastyEntry?.preview_path, undefined)
      for (const e of parsed.entries ?? []) {
        assert.equal((e.preview_path ?? '').includes('\u0085'), false)
        assert.equal((e.preview_path ?? '').includes('\u202e'), false)
      }
    } finally {
      setWorkspaceInspectReposRootOverrideForTests(undefined)
      setWorkspaceInspectSnapshotOverrideForTests(undefined)
      resetInspectLimiterForTests()
      delete process.env.OC_CONTAINER_ID
      rmSync(tmp, { recursive: true, force: true })
      await new Promise<void>((resolve, reject) => { server.close((e) => (e ? reject(e) : resolve())) })
    }
  })
})
