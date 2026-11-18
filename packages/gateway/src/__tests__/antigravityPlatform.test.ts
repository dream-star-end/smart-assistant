/**
 * Antigravity launch HOME projection contract (OCV5-530).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityPlatform.test.ts
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'

import {
  ANTIGRAVITY_CLI_TOKEN_FILE_TTL_MS,
  type AntigravityPlatformInput,
  antigravityCliTokenFileExpiry,
  antigravityStableCliDir,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
} from '../engine/antigravityPlatform.js'

function input(hostBin: string | null): AntigravityPlatformInput {
  return {
    credential: { accessToken: 'limited-token', accessTokenExpiresAt: '2026-10-20T00:00:00Z' },
    agentId: 'main',
    sessionKey: 'agent:main:webchat:dm:agy-platform-test',
    gatewayPort: 18789,
    gatewayToken: '',
    delegationDepth: 0,
    hostBin,
  }
}

async function withHome(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-agy-platform-'))
  const previousHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = root
  try {
    await fn(root)
  } finally {
    if (previousHome === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stores the string "undefined"
      delete process.env.OPENCLAUDE_HOME
    } else {
      process.env.OPENCLAUDE_HOME = previousHome
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function fakeBin(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const bin = path.join(dir, name)
  await writeFile(bin, '#!/bin/sh\nexit 0\n')
  await chmod(bin, 0o755)
  return bin
}

test('launch HOME profile gives a login shell the selfhost host wrapper', async () => {
  await withHome(async (root) => {
    const hostDir = path.join(root, '.local', 'bin')
    const hostBin = await fakeBin(hostDir, 'host')
    // Neighbouring user-writable shims must not shadow system tools.
    await fakeBin(hostDir, 'sh')

    const projection = projectAntigravityPlatform(input(hostBin))
    try {
      assert.equal(projection.hostPathDir, path.join(projection.launchHome, '.oc-host-bin'))
      assert.deepEqual(readdirSync(projection.hostPathDir), ['host'])
      assert.equal(statSync(path.join(projection.launchHome, '.profile')).mode & 0o777, 0o600)
      // oc_bash runs /bin/bash -lc with the MCP process env. The launch HOME
      // profile must survive Debian /etc/profile resetting PATH on login.
      const shell = spawnSync('/bin/bash', ['-lc', 'command -v host; command -v sh'], {
        encoding: 'utf8',
        env: { HOME: projection.launchHome, PATH: '/usr/local/bin:/usr/bin:/bin' },
      })
      assert.equal(shell.status, 0, shell.stderr)
      const [hostPath, shPath] = shell.stdout.trim().split('\n')
      assert.equal(realpathSync(hostPath), realpathSync(hostBin))
      assert.ok(!shPath.startsWith(hostDir), `user shim shadowed sh: ${shPath}`)
    } finally {
      cleanupAntigravityLaunch(projection)
    }
    assert.equal(existsSync(projection.launchHome), false, 'cleanup removes the launch HOME and its host link')
  })
})

test('launch HOME stays unchanged without a host wrapper (commercial)', async () => {
  await withHome(async () => {
    const projection = projectAntigravityPlatform(input(null))
    try {
      assert.equal(projection.hostPathDir, null)
      assert.equal(existsSync(path.join(projection.launchHome, '.profile')), false)
      assert.equal(existsSync(path.join(projection.launchHome, '.oc-host-bin')), false)
    } finally {
      cleanupAntigravityLaunch(projection)
    }
  })
})

// OCV5-556: Go oauth2 in the CLI refuses locally once the file expiry passes
// (no refresh_token), so the file must outlive the 12 h turn hard limit.
test('CLI token file expiry outlives any turn and never shortens a later real expiry', () => {
  const now = Date.parse('2026-10-21T08:02:45Z')
  const floor = new Date(now + ANTIGRAVITY_CLI_TOKEN_FILE_TTL_MS).toISOString()
  assert.ok(ANTIGRAVITY_CLI_TOKEN_FILE_TTL_MS > 12 * 60 * 60 * 1000)
  assert.equal(antigravityCliTokenFileExpiry('2026-10-21T08:25:00Z', now), floor)
  assert.equal(antigravityCliTokenFileExpiry('not-a-date', now), floor)
  assert.equal(antigravityCliTokenFileExpiry('2026-10-30T00:00:00.000Z', now), '2026-10-30T00:00:00.000Z')
})

test('projection reports the expiry it wrote and never the token', async () => {
  await withHome(async () => {
    const projection = projectAntigravityPlatform(input(null))
    try {
      assert.ok(Date.parse(projection.cliTokenFileExpiry) >= Date.now() + 23 * 60 * 60 * 1000)
      assert.ok(!JSON.stringify(projection).includes('limited-token'))
    } finally {
      cleanupAntigravityLaunch(projection)
    }
  })
})

test('the Antigravity MCP shell configures 3600s timeout, matching delegate budget, and eager core tools', async () => {
  await withHome(async () => {
    const projection = projectAntigravityPlatform({ ...input(null), gatewayToken: 'synthetic-gateway-token', systemHelpContextFile: '/synthetic/system-help-context.json' })
    const raw = readFileSync(path.join(projection.launchHome, '.gemini', 'config', 'mcp_config.json'), 'utf8')
    const config = JSON.parse(raw) as {
      mcpServers: Record<string, {
        env: Record<string, string>
        timeoutSeconds?: number
        tools?: Record<string, { eager?: boolean }>
      }>
    }
    const server = Object.values(config.mcpServers)[0]
    assert.ok(server)
    assert.equal(server.env.OPENCLAUDE_SYSTEM_HELP_CONTEXT_FILE, '/synthetic/system-help-context.json')
    assert.equal(server.env.OPENCLAUDE_GATEWAY_PORT, '18789')
    assert.equal(server.timeoutSeconds, 3600)
    assert.equal(server.env.OPENCLAUDE_DELEGATE_MCP_BUDGET_MS, '3585000')
    assert.deepEqual(server.tools, {
      oc_bash: { eager: true },
      oc_grep: { eager: true },
      oc_glob: { eager: true },
      delegate_task: { eager: true },
      skill_search: { eager: true },
      skill_view: { eager: true },
    })
    assert.equal(raw.includes('synthetic-gateway-token'), false)
    cleanupAntigravityLaunch(projection)
  })
})

test('summary cache seeding skips symlinks and corrupt SQLite headers while copying valid caches', async () => {
  await withHome(async (root) => {
    const stable = antigravityStableCliDir(path.join(root, 'antigravity-cli'))
    await mkdir(stable, { recursive: true })
    // 1. Corrupt non-SQLite file + symlinked .pb must both be rejected on seed.
    const corruptDb = path.join(stable, 'conversation_summaries.db')
    const outsideTarget = path.join(root, 'outside-secret.pb')
    writeFileSync(corruptDb, 'NOT_A_VALID_SQLITE_HEADER_AT_ALL')
    writeFileSync(outsideTarget, 'secret')
    symlinkSync(outsideTarget, path.join(stable, 'jetbox_summaries_proto.pb'))

    const p1 = projectAntigravityPlatform(input(null))
    try {
      const cliDir1 = path.join(p1.launchHome, '.gemini', 'antigravity-cli')
      assert.equal(existsSync(path.join(cliDir1, 'conversation_summaries.db')), false, 'corrupt SQLite header skipped')
      assert.equal(existsSync(path.join(cliDir1, 'jetbox_summaries_proto.pb')), false, 'symlinked cache file skipped')
    } finally {
      cleanupAntigravityLaunch(p1)
    }

    // 2. Valid SQLite DB + regular .pb file are copied as private 0600 files.
    await rm(path.join(stable, 'jetbox_summaries_proto.pb'), { force: true })
    await rm(corruptDb, { force: true })
    const db = new Database(corruptDb)
    db.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);')
    db.close()
    writeFileSync(path.join(stable, 'jetbox_summaries_proto.pb'), 'valid-pb')

    const p2 = projectAntigravityPlatform(input(null))
    try {
      const cliDir2 = path.join(p2.launchHome, '.gemini', 'antigravity-cli')
      const seededDb = path.join(cliDir2, 'conversation_summaries.db')
      const seededPb = path.join(cliDir2, 'jetbox_summaries_proto.pb')
      assert.equal(lstatSync(seededDb).isFile(), true)
      assert.equal(lstatSync(seededDb).mode & 0o777, 0o600)
      assert.notEqual(lstatSync(seededDb).ino, lstatSync(corruptDb).ino)
      assert.equal(readFileSync(seededPb, 'utf8'), 'valid-pb')
    } finally {
      cleanupAntigravityLaunch(p2)
    }
  })
})

test('non-regular FIFO cache entries never block gateway event loop on seed or persist', async () => {
  await withHome(async (root) => {
    const stable = antigravityStableCliDir(path.join(root, 'antigravity-cli'))
    await mkdir(stable, { recursive: true })
    const fifoPath = path.join(stable, 'conversation_summaries.db')
    const mk = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' })
    assert.equal(mk.status, 0, mk.stderr)

    const moduleUrl = new URL('../engine/antigravityPlatform.ts', import.meta.url).href
    const tsxBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx')
    const probe = spawnSync(
      tsxBin,
      [
        '-e',
        `import { spawnSync } from 'node:child_process';
         import { existsSync, rmSync } from 'node:fs';
         import path from 'node:path';
         import { projectAntigravityPlatform, cleanupAntigravityLaunch } from ${JSON.stringify(moduleUrl)};
         const t0 = Date.now();
         const p = projectAntigravityPlatform({
           credential: { accessToken: 'tok', accessTokenExpiresAt: '2026-12-01T00:00:00Z' },
           agentId: 'main', sessionKey: 's', gatewayPort: 18789, gatewayToken: '', delegationDepth: 0, hostBin: null,
         });
         const cliDir = path.join(p.launchHome, '.gemini', 'antigravity-cli');
         const seeded = existsSync(path.join(cliDir, 'conversation_summaries.db'));
         rmSync(${JSON.stringify(fifoPath)}, { force: true });
         spawnSync('mkfifo', [path.join(cliDir, 'conversation_summaries.db')]);
         spawnSync('mkfifo', [path.join(cliDir, 'jetbox_summaries_proto.pb')]);
         cleanupAntigravityLaunch(p, { persistSummaryCache: true });
         const persistedFifo = existsSync(${JSON.stringify(fifoPath)});
         const elapsedMs = Date.now() - t0;
         if (seeded || persistedFifo || elapsedMs > 1000) {
           console.error({ seeded, persistedFifo, elapsedMs });
           process.exit(2);
         }
         console.log('FIFO_SKIPPED_OK elapsedMs=' + elapsedMs);`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, OPENCLAUDE_HOME: root },
        timeout: 15_000,
      },
    )
    assert.equal(probe.error, undefined, `FIFO seed/persist blocked and timed out: ${String(probe.error)}`)
    assert.equal(probe.status, 0, probe.stderr)
    assert.match(probe.stdout, /FIFO_SKIPPED_OK/)
  })
})

test('persistSummaryCache refuses partial/busy WAL checkpoints and preserves prior stable cache', async () => {
  await withHome(async (root) => {
    const stable = antigravityStableCliDir(path.join(root, 'antigravity-cli'))
    await mkdir(stable, { recursive: true })
    const stableDbPath = path.join(stable, 'conversation_summaries.db')
    const baseDb = new Database(stableDbPath)
    baseDb.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY); INSERT INTO summaries VALUES (\'baseline-clean\');')
    baseDb.close()

    const projection = projectAntigravityPlatform(input(null))
    const launchDbPath = path.join(projection.launchHome, '.gemini', 'antigravity-cli', 'conversation_summaries.db')
    // Frame 1 is visible to reader's snapshot; Frame 2 is written after reader's snapshot.
    // PRAGMA wal_checkpoint(TRUNCATE) will checkpoint Frame 1 into the main DB file and return
    // { busy: 1, log: 2, checkpointed: 1 } without truncating WAL. Persistence MUST reject this partial state.
    const writer = new Database(launchDbPath)
    writer.pragma('journal_mode = WAL')
    writer.exec('CREATE TABLE extra_page (x TEXT PRIMARY KEY)')
    writer.prepare('INSERT INTO summaries VALUES (?)').run('partial-frame-1')
    const reader = new Database(launchDbPath, { readonly: true })
    const iter = reader.prepare('SELECT id FROM summaries').iterate()
    iter.next()
    writer.prepare('INSERT INTO extra_page VALUES (?)').run('uncheckpointed-frame-2')
    writer.close()

    try {
      cleanupAntigravityLaunch(projection, { persistSummaryCache: true })
    } finally {
      try { iter.return?.() } catch { /* ignore */ }
      try { reader.close() } catch { /* launch dir removed */ }
    }

    const verify = new Database(stableDbPath, { readonly: true })
    const rows = verify.prepare('SELECT id FROM summaries ORDER BY id').all() as Array<{ id: string }>
    verify.close()
    assert.deepEqual(rows.map((r) => r.id), ['baseline-clean'])
  })
})

test('sequential turns reuse deterministic session launchHome while concurrent/late cleanups stay isolated', async () => {
  await withHome(async () => {
    const p1 = projectAntigravityPlatform(input(null))
    assert.match(path.basename(p1.launchHome), /^s-[0-9a-f]{16}$/)

    // Concurrent turn of the same session spills to an isolated `r-*` launchHome.
    const concurrentSame = projectAntigravityPlatform(input(null))
    assert.match(path.basename(concurrentSame.launchHome), /^r-[0-9a-f]{16}$/)
    assert.notEqual(concurrentSame.launchHome, p1.launchHome)

    // Different session gets its own distinct deterministic `s-*` launchHome.
    const otherSession = projectAntigravityPlatform({
      ...input(null),
      sessionKey: 'agent:main:webchat:dm:other-session',
    })
    assert.match(path.basename(otherSession.launchHome), /^s-[0-9a-f]{16}$/)
    assert.notEqual(otherSession.launchHome, p1.launchHome)

    cleanupAntigravityLaunch(concurrentSame)
    cleanupAntigravityLaunch(otherSession)
    cleanupAntigravityLaunch(p1)
    assert.equal(existsSync(p1.launchHome), false)

    // Next sequential turn of the original session gets the exact same launchHome path.
    const p2 = projectAntigravityPlatform({
      ...input(null),
      credential: { accessToken: 'fresh-turn-2-token', accessTokenExpiresAt: '2026-10-20T00:00:00Z' },
    })
    try {
      assert.equal(p2.launchHome, p1.launchHome, 'sequential turns preserve byte-identical $HOME for prompt cache')
      const tokenRaw = readFileSync(path.join(p2.launchHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')
      assert.equal(tokenRaw.includes('fresh-turn-2-token'), true)

      // Late/duplicate cleanup of p1 must NOT delete or clobber p2's active launchHome!
      cleanupAntigravityLaunch(p1)
      assert.equal(existsSync(p2.launchHome), true, 'stale lease cleanup must not remove active re-acquired launchHome')
      cleanupAntigravityLaunch({ root: p1.root, launchHome: p1.launchHome })
      assert.equal(existsSync(p2.launchHome), true, 'unleased manual cleanup must not clobber active leased launchHome')
    } finally {
      cleanupAntigravityLaunch(p2)
    }
    assert.equal(existsSync(p2.launchHome), false)
  })
})

test('sticky launchHome reclaims dead crash residue without following symlinks and yields to live cross-process owners', async () => {
  await withHome(async (root) => {
    const probe = projectAntigravityPlatform(input(null))
    const stickyPath = probe.launchHome
    cleanupAntigravityLaunch(probe)

    // 1. Symlink residue at stickyPath must be unlinked without touching outside target.
    const outsideDir = path.join(root, 'outside-keep')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(path.join(outsideDir, 'keep.txt'), 'safe')
    symlinkSync(outsideDir, stickyPath)

    const afterSymlink = projectAntigravityPlatform(input(null))
    try {
      assert.equal(afterSymlink.launchHome, stickyPath)
      assert.equal(lstatSync(stickyPath).isDirectory(), true)
      assert.equal(readFileSync(path.join(outsideDir, 'keep.txt'), 'utf8'), 'safe')
    } finally {
      cleanupAntigravityLaunch(afterSymlink)
    }

    // 2. Dead PID residue in `.oc-launch-owner.json` is reclaimed cleanly.
    mkdirSync(stickyPath, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(stickyPath, '.oc-launch-owner.json'), JSON.stringify({ pid: 2_147_483_640, startTicks: '999999999' }))
    writeFileSync(path.join(stickyPath, 'stale-marker'), 'old')

    const afterDeadPid = projectAntigravityPlatform(input(null))
    try {
      assert.equal(afterDeadPid.launchHome, stickyPath)
      assert.equal(existsSync(path.join(stickyPath, 'stale-marker')), false)
    } finally {
      cleanupAntigravityLaunch(afterDeadPid)
    }

    // 3. Live cross-process owner on stickyPath is respected (spills to `r-*` without clobbering).
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    try {
      assert.ok(sleeper.pid && sleeper.pid > 0)
      mkdirSync(stickyPath, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(stickyPath, '.oc-launch-owner.json'), JSON.stringify({ pid: sleeper.pid, startTicks: null }))
      writeFileSync(path.join(stickyPath, 'live-owner-marker'), 'intact')

      const spilled = projectAntigravityPlatform(input(null))
      try {
        assert.match(path.basename(spilled.launchHome), /^r-[0-9a-f]{16}$/)
        assert.equal(readFileSync(path.join(stickyPath, 'live-owner-marker'), 'utf8'), 'intact')
      } finally {
        cleanupAntigravityLaunch(spilled)
      }
    } finally {
      sleeper.kill('SIGKILL')
    }
  })
})

test('sticky launchHome respects runtime-flags/antigravity-sticky-launch-home and env override', async () => {
  await withHome(async (root) => {
    const flagsDir = path.join(root, 'runtime-flags')
    mkdirSync(flagsDir, { recursive: true })
    const flagFile = path.join(flagsDir, 'antigravity-sticky-launch-home')
    writeFileSync(flagFile, 'off\n')

    const pOff = projectAntigravityPlatform(input(null))
    try {
      assert.match(path.basename(pOff.launchHome), /^r-[0-9a-f]{16}$/)
    } finally {
      cleanupAntigravityLaunch(pOff)
    }

    // Env override `on` wins over file `off`.
    process.env.OC_ANTIGRAVITY_STICKY_LAUNCH_HOME = 'on'
    try {
      const pEnvOn = projectAntigravityPlatform(input(null))
      try {
        assert.match(path.basename(pEnvOn.launchHome), /^s-[0-9a-f]{16}$/)
      } finally {
        cleanupAntigravityLaunch(pEnvOn)
      }
    } finally {
      Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_STICKY_LAUNCH_HOME')
    }

    writeFileSync(flagFile, 'on\n')
    const pOn = projectAntigravityPlatform(input(null))
    try {
      assert.match(path.basename(pOn.launchHome), /^s-[0-9a-f]{16}$/)
    } finally {
      cleanupAntigravityLaunch(pOn)
    }
  })
})

test('concurrent cross-process stale-reclaim race never double-assigns or deletes a peer active launchHome', async () => {
  await withHome(async (root) => {
    const initial = projectAntigravityPlatform(input(null))
    const stickyPath = initial.launchHome
    const slotName = path.basename(stickyPath)
    cleanupAntigravityLaunch(initial)

    // Seed dead crash residue on the sticky launchHome; also verify contended slot lock degrades safely without ABA lock-stealing.
    mkdirSync(stickyPath, { recursive: true, mode: 0o700 })
    writeFileSync(
      path.join(stickyPath, '.oc-launch-owner.json'),
      JSON.stringify({ pid: 2_147_483_641, startTicks: '888888888', leaseId: 'dead-lease' }),
    )
    const lockDir = path.join(root, 'antigravity-cli', 'launch-locks', `${slotName}.lock`)
    mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    const whileLocked = projectAntigravityPlatform(input(null))
    assert.match(path.basename(whileLocked.launchHome), /^r-[0-9a-f]{16}$/, 'held lock degrades to r-* without stealing')
    assert.equal(existsSync(lockDir), true, 'held lock must never be stolen or renamed')
    cleanupAntigravityLaunch(whileLocked)
    await rm(lockDir, { recursive: true, force: true })

    const coordDir = path.join(root, 'race-coord')
    mkdirSync(coordDir, { recursive: true })
    const startGate = path.join(coordDir, 'go')
    const cleanupGate = path.join(coordDir, 'cleanup')
    const moduleUrl = new URL('../engine/antigravityPlatform.ts', import.meta.url).href
    const tsxBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx')

    const workerScript = `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { projectAntigravityPlatform, cleanupAntigravityLaunch } from ${JSON.stringify(moduleUrl)};
      const id = process.env.WORKER_ID!;
      const coord = ${JSON.stringify(coordDir)};
      const goFile = ${JSON.stringify(startGate)};
      const cleanupFile = ${JSON.stringify(cleanupGate)};
      writeFileSync(path.join(coord, 'ready-' + id), '1');
      const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(goFile)) Atomics.wait(sleepBuf, 0, 0, 2);
      const p = projectAntigravityPlatform({
        credential: { accessToken: 'tok-' + id, accessTokenExpiresAt: '2026-12-01T00:00:00Z' },
        agentId: 'main',
        sessionKey: 'agent:main:webchat:dm:agy-platform-test',
        gatewayPort: 18789,
        gatewayToken: '',
        delegationDepth: 0,
        hostBin: null,
      });
      const markerPath = path.join(p.launchHome, 'worker-marker.txt');
      writeFileSync(markerPath, 'worker-' + id);
      writeFileSync(path.join(coord, 'acquired-' + id + '.json'), JSON.stringify({ id, launchHome: p.launchHome }));
      while (!existsSync(cleanupFile + '-' + id)) Atomics.wait(sleepBuf, 0, 0, 5);
      const markerOk = existsSync(markerPath) && readFileSync(markerPath, 'utf8') === 'worker-' + id;
      const tokenPath = path.join(p.launchHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      const tokenOk = existsSync(tokenPath) && readFileSync(tokenPath, 'utf8').includes('tok-' + id);
      cleanupAntigravityLaunch(p);
      writeFileSync(path.join(coord, 'done-' + id + '.json'), JSON.stringify({ id, launchHome: p.launchHome, markerOk, tokenOk }));
    `

    const workerIds = ['1', '2', '3', '4']
    const procs = workerIds.map((id) =>
      spawn(tsxBin, ['-e', workerScript], {
        env: { ...process.env, OPENCLAUDE_HOME: root, WORKER_ID: id },
        stdio: 'pipe',
      }),
    )

    try {
      const waitFiles = async (names: string[], timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (names.every((n) => existsSync(path.join(coordDir, n)))) return
          await new Promise((r) => setTimeout(r, 15))
        }
        throw new Error(`Timed out waiting for ${names.join(', ')}`)
      }

      await waitFiles(workerIds.map((id) => `ready-${id}`))
      writeFileSync(startGate, '1')
      await waitFiles(workerIds.map((id) => `acquired-${id}.json`))

      const acquired = workerIds.map((id) =>
        JSON.parse(readFileSync(path.join(coordDir, `acquired-${id}.json`), 'utf8')) as { id: string; launchHome: string },
      )
      const uniqueHomes = new Set(acquired.map((a) => a.launchHome))
      assert.equal(uniqueHomes.size, workerIds.length, `duplicate launchHome assigned: ${JSON.stringify(acquired)}`)
      const stickyWinners = acquired.filter((a) => a.launchHome === stickyPath)
      assert.ok(stickyWinners.length <= 1, `at most one process may claim sticky launchHome: ${JSON.stringify(acquired)}`)

      // Stagger cleanups: clean up non-sticky (or earlier) workers first, then verify remaining workers stay intact!
      const ordered = [...acquired].sort((a, b) => (a.launchHome === stickyPath ? 1 : 0) - (b.launchHome === stickyPath ? 1 : 0))
      for (const item of ordered) {
        writeFileSync(`${cleanupGate}-${item.id}`, '1')
        await waitFiles([`done-${item.id}.json`])
        const done = JSON.parse(readFileSync(path.join(coordDir, `done-${item.id}.json`), 'utf8')) as {
          markerOk: boolean
          tokenOk: boolean
        }
        assert.equal(done.markerOk, true, `worker ${item.id} marker was clobbered`)
        assert.equal(done.tokenOk, true, `worker ${item.id} token was clobbered`)
      }

      await Promise.all(
        procs.map(
          (proc) =>
            new Promise<void>((resolve, reject) => {
              if (proc.exitCode !== null) return proc.exitCode === 0 ? resolve() : reject(new Error(`exit ${proc.exitCode}`))
              proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
            }),
        ),
      )
      assert.deepEqual(readdirSync(path.join(root, 'antigravity-cli', 'launch')), [])
    } finally {
      for (const proc of procs) {
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
    }
  })
})
