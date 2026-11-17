/**
 * Antigravity launch HOME projection contract (OCV5-530).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityPlatform.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
