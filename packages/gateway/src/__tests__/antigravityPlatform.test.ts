/**
 * Antigravity launch HOME projection contract (OCV5-530).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravityPlatform.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { cleanupAntigravityLaunch, projectAntigravityPlatform } from '../engine/antigravityPlatform.js'

test('launch HOME profile gives a login shell the selfhost host wrapper', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-agy-platform-'))
  const previousHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = root
  try {
    const hostDir = path.join(root, '.local', 'bin')
    await mkdir(hostDir, { recursive: true })
    const hostBin = path.join(hostDir, 'host')
    await writeFile(hostBin, '#!/bin/sh\nexit 0\n')
    await chmod(hostBin, 0o755)

    const projection = projectAntigravityPlatform({
      credential: { accessToken: 'limited-token', accessTokenExpiresAt: '2026-10-20T00:00:00Z' },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:agy-platform-test',
      gatewayPort: 18789,
      gatewayToken: '',
      delegationDepth: 0,
      hostBin,
    })
    try {
      // oc_bash runs /bin/bash -lc with the MCP process env. The launch HOME
      // profile must survive Debian /etc/profile resetting PATH on login.
      const shell = spawnSync('/bin/bash', ['-lc', 'command -v host'], {
        encoding: 'utf8',
        env: { HOME: projection.launchHome, PATH: '/usr/local/bin:/usr/bin:/bin' },
      })
      assert.equal(shell.status, 0, shell.stderr)
      assert.equal(shell.stdout.trim(), hostBin)
    } finally {
      cleanupAntigravityLaunch(projection)
    }
  } finally {
    if (previousHome === undefined) process.env.OPENCLAUDE_HOME = undefined
    else process.env.OPENCLAUDE_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
