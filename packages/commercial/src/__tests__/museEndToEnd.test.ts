// Muse media bridge end to end (OCV5-561): real master handlers on a local HTTP server, the
// real muse_bridge.py driving a stub media-generation, and the real oc-muse CLI.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { type ContainerIdentityRepo, hashSecret } from '../auth/containerIdentity.js'
import { makeMuseBridgeHttpHandler } from '../muse/bridgeHttp.js'
import { MuseBridgeHub } from '../muse/hub.js'
import { makeMuseInternalHandler } from '../muse/internalHttp.js'
import { MUSE_INTERNAL_PREFIX } from '../muse/protocol.js'
import type { MuseStore } from '../muse/store.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BRIDGE = join(REPO_ROOT, 'packages/commercial/muse-bridge/muse_bridge.py')
const FAKE_CLI = join(REPO_ROOT, 'packages/commercial/muse-bridge/tests/fake-media-generation')
const OC_MUSE = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-muse.py')
const BRIDGE_TOKEN = `mbr_${'e'.repeat(43)}`
const SECRET = 'b'.repeat(64)
const HOST = 'host-e2e'
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
])

function memStore(): MuseStore {
  const rows = new Map<
    string,
    { status: string; userId: string; kind: 'image' | 'video'; error: string | null }
  >()
  const cred = createHash('sha256').update(BRIDGE_TOKEN).digest('hex')
  return {
    async insertJob(r) {
      rows.set(r.id, { status: 'queued', userId: r.userId, kind: r.kind, error: null })
    },
    async markRunning(id) {
      const r = rows.get(id)
      if (r) r.status = 'running'
    },
    async finishJob(id, f) {
      const r = rows.get(id)
      if (r) Object.assign(r, { status: f.status, error: f.errorCode })
    },
    async countRecent() {
      return { hour: 0, day: 0 }
    },
    async failOrphans() {
      return 0
    },
    async findJob(userId, id) {
      const r = rows.get(id)
      return r && r.userId === userId
        ? { id, kind: r.kind, status: r.status as 'failed', errorCode: r.error }
        : null
    },
    async findCredential(sha) {
      return sha.toString('hex') === cred ? { id: '1' } : null
    },
    async touchCredential() {},
  }
}

// Container 42 belongs to uid 3 (allowed), container 43 to uid 765 (not allowed).
const identityRepo: ContainerIdentityRepo = {
  async findActiveByHostAndBoundIp(hostUuid, boundIp) {
    if (hostUuid !== HOST) return null
    const id = boundIp === '10.0.0.42' ? 42 : boundIp === '10.0.0.43' ? 43 : null
    if (!id) return null
    return {
      id,
      user_id: id === 42 ? 3 : 765,
      bound_ip: boundIp,
      host_uuid: HOST,
      secret_hash: hashSecret(SECRET),
    }
  },
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
  })
}

describe('muse end to end (bridge.py + master + oc-muse)', { timeout: 240_000 }, () => {
  let work: string
  let server: Server
  let hub: MuseBridgeHub
  let bridge: ChildProcess
  let base: string

  before(async () => {
    work = mkdtempSync(join(tmpdir(), 'muse-e2e-'))
    const store = memStore()
    hub = new MuseBridgeHub({
      store,
      stateRoot: join(work, 'state'),
      allowedUids: new Set(['3']),
      rate: { imagePerHour: 100, imagePerDay: 100, videoPerHour: 100, videoPerDay: 100 },
      cliTimeoutSec: { image: 60, video: 60 },
    })
    await hub.start()
    const bridgeHttp = makeMuseBridgeHttpHandler({ hub, store, pollHoldMs: 2000 })
    const internal = makeMuseInternalHandler({ identityRepo, hub })
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!
      if (path.startsWith('/api/muse-bridge/'))
        return void bridgeHttp(req, res, { clientIp: '127.0.0.1' })
      if (path.startsWith(MUSE_INTERNAL_PREFIX)) {
        // The test client picks its "container IP" with a header (the real one comes from egress).
        return void internal(req, res, {
          hostUuid: HOST,
          boundIp: String(req.headers['x-test-ip'] ?? '10.0.0.42'),
        })
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const bridgeHome = join(work, 'bridge')
    await run('mkdir', ['-p', '-m', '700', bridgeHome], process.env)
    writeFileSync(join(bridgeHome, 'token'), BRIDGE_TOKEN, { mode: 0o600 })
    bridge = spawn(
      'python3',
      ['-I', BRIDGE, '--state-dir', bridgeHome, '--cli', FAKE_CLI, 'run', '--server', base],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, TMPDIR: work, FAKE_ARGV_LOG: join(work, 'argv.log') },
      },
    )
    for (let i = 0; i < 100 && !hub.bridgeOnline(); i++)
      await new Promise((r) => setTimeout(r, 100))
    assert.ok(hub.bridgeOnline(), 'bridge did not connect')
  })

  after(async () => {
    bridge?.kill('SIGTERM')
    hub?.stop()
    server?.closeAllConnections()
    await new Promise((r) => server?.close(r))
    rmSync(work, { recursive: true, force: true })
  })

  const ocMuse = (args: string[], cid = 42) =>
    run('python3', ['-I', OC_MUSE, ...args], {
      PATH: process.env.PATH,
      HOME: work,
      OPENCLAUDE_V3_MASTER_BASE_URL: base,
      OPENCLAUDE_V3_CONTAINER_TOKEN: `oc-v3.${cid}.${SECRET}`,
      OC_MUSE_OUT_DIR: join(work, 'generated'),
    })

  it('text to image: prints the saved path and a snapshot id', async () => {
    const r = await ocMuse(['image', '雪地里的红狐', '--format', 'png'])
    assert.equal(r.code, 0, r.stderr)
    const [path, snap] = r.stdout.trim().split('\n')
    assert.ok(path!.startsWith(join(work, 'generated')))
    assert.equal(statSync(path!).size, 4000)
    assert.match(snap!, /^snapshot_id: \S+/)
  })

  it('image to video with --image, then resume from its snapshot', async () => {
    const src = join(work, 'fox.png')
    writeFileSync(src, PNG)
    const first = await ocMuse(['video', 'the fox starts running', '--image', src, '--json'])
    assert.equal(first.code, 0, first.stderr)
    const out = JSON.parse(first.stdout)
    assert.equal(statSync(out.files[0]).size, 6_700_000)
    const second = await ocMuse([
      'video',
      'the fox leaps a log',
      '--resume',
      out.snapshot_id,
      '--json',
    ])
    assert.equal(second.code, 0, second.stderr)
    const next = JSON.parse(second.stdout)
    assert.equal(statSync(next.files[0]).size, 10_700_000)
    assert.equal(next.snapshot_id.split(':')[0], out.snapshot_id.split(':')[0])
    const calls = readFileSync(join(work, 'argv.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[])
    const legacy = ['--image-file', '--image-id', '--reference-image-file', '--reference-image-id']
    const subagent = [
      '--media-subagent-output-type',
      '--conversation-json',
      '--resume-from-snapshot-id',
    ]
    for (const c of calls) {
      assert.ok(
        !(legacy.some((x) => c.includes(x)) && subagent.some((x) => c.includes(x))),
        JSON.stringify(c),
      )
    }
  })

  it('3 MiB source travels through the real master refs route; chat rejects larger files', async () => {
    const src = join(work, 'large.png')
    const data = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 - PNG.length)])
    writeFileSync(src, data)
    const r = await ocMuse(['image', 'large source edit', '--image', src, '--json'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(statSync(JSON.parse(r.stdout).files[0]).size, 4000)
    const callsBefore = readFileSync(join(work, 'argv.log'), 'utf8')
    writeFileSync(src, Buffer.concat([data, Buffer.from([0])]))
    const rejected = await ocMuse(['image', 'too large', '--image', src])
    assert.equal(rejected.code, 1)
    const error = JSON.parse(rejected.stderr.trim().split('\n').pop()!)
    assert.equal(error.code, 'MUSE_INVALID_INPUT')
    assert.match(error.message, /3 MiB/)
    assert.equal(readFileSync(join(work, 'argv.log'), 'utf8'), callsBefore)
  })

  it('video region error is reported as is, without retry', async () => {
    const r = await ocMuse(['video', 'region blocked please'])
    assert.equal(r.code, 1)
    const err = JSON.parse(r.stderr.trim().split('\n').pop()!)
    assert.equal(err.code, 'MUSE_VIDEO_REGION_BLOCKED')
    assert.equal(err.retryable, false)
    assert.equal(err.upstream_error_code, 'video_not_available')
  })

  it('a user outside the allowlist gets MUSE_NOT_ENABLED', async () => {
    const r = await run('python3', ['-I', OC_MUSE, 'image', 'x'], {
      PATH: process.env.PATH,
      HOME: work,
      OPENCLAUDE_V3_MASTER_BASE_URL: base,
      OPENCLAUDE_V3_CONTAINER_TOKEN: `oc-v3.43.${SECRET}`,
    })
    // The CLI cannot set the test-only container-IP header, so drive the endpoint directly too.
    assert.equal(r.code, 1)
    const res = await fetch(`${base}${MUSE_INTERNAL_PREFIX}/status`, {
      headers: { authorization: `Bearer oc-v3.43.${SECRET}`, 'x-test-ip': '10.0.0.43' },
    })
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error.code, 'MUSE_NOT_ENABLED')
  })
})
