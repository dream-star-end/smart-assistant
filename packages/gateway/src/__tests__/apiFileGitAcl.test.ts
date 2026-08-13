/**
 * Real /api/file handler HTTP round-trips for the lexical `.git` ACL.
 * Must not be replaced by a unit test of hasGitPathSegment alone.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AddressInfo } from 'node:net'
import { apiFileTestHooks, Gateway } from '../server.js'

const ENV_KEY = 'OC_V3_TRUSTED_FILE_SERVE'

function stubConfig() {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: 'test-token' },
    auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
    defaults: { model: 'x', permissionMode: 'default' },
    channels: { webchat: { enabled: true } },
    mcpServers: [],
  }
}

async function withApiFileServer(
  fn: (base: string, spies: { resolve: number; realpath: number; remote: number }) => Promise<void>,
): Promise<void> {
  const spies = { resolve: 0, realpath: 0, remote: 0 }
  apiFileTestHooks.onResolveMediaDirs = () => {
    spies.resolve++
  }
  apiFileTestHooks.realpathSync = (p) => {
    spies.realpath++
    return realpathSync(p)
  }
  apiFileTestHooks.onRemotePull = () => {
    spies.remote++
  }
  const gw = new Gateway({
    config: stubConfig() as never,
    agentsConfig: { agents: [] } as never,
  })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    gw.handleApiFileForTests(req, res, url).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('test error')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await fn(`http://127.0.0.1:${port}`, spies)
  } finally {
    apiFileTestHooks.onResolveMediaDirs = undefined
    apiFileTestHooks.realpathSync = undefined
    apiFileTestHooks.onRemotePull = undefined
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

async function getFile(base: string, absPath: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/api/file?path=${encodeURIComponent(absPath)}`)
  return { status: res.status, body: await res.text() }
}

describe('/api/file git ACL handler', () => {
  let tmp: string
  let prevTrusted: string | undefined

  beforeEach(() => {
    prevTrusted = process.env[ENV_KEY]
    process.env[ENV_KEY] = '1'
    tmp = mkdtempSync(join(tmpdir(), 'oc-apifile-git-'))
  })

  afterEach(() => {
    if (prevTrusted === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevTrusted
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns 403 for a direct .git/config path without resolver or realpath', async () => {
    const gitConfig = join(tmp, 'workspace', '.git', 'config')
    mkdirSync(join(tmp, 'workspace', '.git'), { recursive: true })
    writeFileSync(gitConfig, '[core]\n')
    await withApiFileServer(async (base, spies) => {
      const r = await getFile(base, gitConfig)
      assert.equal(r.status, 403)
      assert.equal(r.body, 'access denied')
      assert.equal(spies.resolve, 0)
      assert.equal(spies.realpath, 0)
      assert.equal(spies.remote, 0)
    })
  })

  it('returns 403 when parent .git is a symlink that realpath would erase', async () => {
    const hidden = join(tmp, 'x')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(hidden, 'config'), 'secret helper\n')
    const workspace = join(tmp, 'workspace')
    mkdirSync(workspace, { recursive: true })
    symlinkSync(hidden, join(workspace, '.git'))
    const requestPath = join(workspace, '.git', 'config')
    await withApiFileServer(async (base, spies) => {
      const r = await getFile(base, requestPath)
      assert.equal(r.status, 403)
      assert.equal(r.body, 'access denied')
      assert.equal(spies.resolve, 0)
      assert.equal(spies.realpath, 0)
      assert.equal(spies.remote, 0)
    })
  })

  it('does not 403 foo.git via the git-segment guard', async () => {
    const file = `/tmp/openclaude-apitest-${Date.now()}/foo.git`
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'not a git dir\n')
    await withApiFileServer(async (base, spies) => {
      apiFileTestHooks.realpathSync = (p) => {
        spies.realpath++
        return p.startsWith('/tmp/') ? p : realpathSync(p)
      }
      const r = await getFile(base, file)
      assert.ok(spies.resolve > 0, 'lexical git guard must not fire for foo.git')
      assert.ok(spies.realpath > 0)
      assert.notEqual(r.status, 403)
    })
    rmSync(join(file, '..'), { recursive: true, force: true })
  })

  it('still 404s directories', async () => {
    const dir = `/tmp/openclaude-apitest-dir-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    await withApiFileServer(async (base, spies) => {
      apiFileTestHooks.realpathSync = (p) => {
        spies.realpath++
        return p.startsWith('/tmp/') ? p : realpathSync(p)
      }
      const r = await getFile(base, dir)
      assert.ok(spies.resolve > 0, 'directories must pass lexical git guard')
      assert.equal(r.status, 404)
    })
    rmSync(dir, { recursive: true, force: true })
  })
})
