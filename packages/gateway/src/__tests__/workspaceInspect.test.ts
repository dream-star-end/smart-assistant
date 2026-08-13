import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Gateway, isFileAllowed, isFileBlocked } from '../server.js'
import type { RepoSnapshot } from '../sessionRepoWorkspace.js'
import {
  collectGitSnapshot,
  collectListDir,
  hasGitPathSegment,
  isLinuxFdAnchorAvailable,
  lastOpendirPathForTests,
  lastTrustedGitDirForTests,
  parseGitHead,
  parseRelPath,
  parseSessionId,
  releaseInspect,
  resetInspectLimiterForTests,
  setWorkspaceInspectAfterObjectsFdForTests,
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
    const json = JSON.stringify(r.body)
    assert.equal(json.includes('\nname'), false)
    assert.equal(json.includes('\u001b'), false)
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
    setWorkspaceInspectAfterObjectsFdForTests(({ objectsPath }) => {
      const moved = `${objectsPath}.orig`
      renameSync(objectsPath, moved)
      symlinkSync(tmp, objectsPath)
    })
    writeFileSync(join(workspaceDir, 'changed.txt'), 'x')
    const rt = makeRt(workspaceDir, reposRoot)
    const r = await collectGitSnapshot(rt, 'sess-1')
    assert.equal(r.kind, 'ok')
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
    const json = JSON.stringify(r.body)
    assert.equal(json.includes('\u007f'), false)
    assert.equal(json.includes('\u0085'), false)
    assert.equal(json.includes('\u202e'), false)
    assert.equal(json.includes('<img>'), true)
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
})
