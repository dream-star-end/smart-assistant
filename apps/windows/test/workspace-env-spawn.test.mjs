import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyWorkspaceToGatewaySpawn } from '../src/host/workspace/applySpawn.mjs'
import { buildWorkspaceEnv } from '../src/host/workspace/workspaceEnv.mjs'
import { assertGatewayEnvSafe, buildGatewayEnv } from '../src/host/gatewayProcess.mjs'
import { createLahGwToken, createLahToken } from '../src/host/tokens.mjs'
import { snapshotWorkspace } from '../src/host/workspace/snapshot.mjs'

test('buildWorkspaceEnv extraEnv merges into gateway spawn and stays assertGatewayEnvSafe', () => {
  const roots = [path.join(os.tmpdir(), 'clarvy-ws-a'), path.join(os.tmpdir(), 'clarvy-ws-b')]
  const ws = buildWorkspaceEnv({ roots, platform: 'linux' })
  assert.equal(ws.engineCwd, roots[0])
  assert.deepEqual(ws.spawn.args, ['--add-dir', roots[0], '--add-dir', roots[1]])
  const applied = applyWorkspaceToGatewaySpawn(ws, { extraEnv: { FOO: '1' } })
  assert.equal(applied.cwd, roots[0])
  assert.equal(applied.extraEnv.FOO, '1')
  assert.equal(applied.extraEnv.OPENCLAUDE_ENGINE_CWD, roots[0])
  assert.equal(applied.extraEnv.OPENCLAUDE_ADD_DIRS, `${roots[0]}:${roots[1]}`)
  assert.deepEqual(applied.addDirArgs, ws.spawn.args)
  const env = buildGatewayEnv({
    localBridgeToken: 'aa'.repeat(32),
    lahGwToken: createLahGwToken(),
    lahToken: createLahToken(),
    masterProxyPort: 18792,
    extraEnv: applied.extraEnv,
  })
  assertGatewayEnvSafe(env)
  assert.equal(env.OPENCLAUDE_ENGINE_CWD, roots[0])
  assert.equal(env.OPENCLAUDE_ADD_DIRS, applied.extraEnv.OPENCLAUDE_ADD_DIRS)
})

test('session-start snapshot helper is safe on a non-git directory', async () => {
  const dir = path.join(os.tmpdir(), `clarvy-snap-${process.pid}`)
  const result = await snapshotWorkspace(dir)
  assert.equal(result.ok, false)
  assert.ok(result.warning)
})
