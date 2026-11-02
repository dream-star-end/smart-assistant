/** Explicit post-build smoke only. No model, credentials, real binding or relay. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { CC5_BINDING_FILE, UnixCc5BridgePort } from '../../packages/gateway/dist/cc5BridgePort.js'

assert.equal(existsSync(CC5_BINDING_FILE), false, 'run only in a disposable host/container without the task binding')
const port = new UnixCc5BridgePort({ version: 1, uid: '912', containerDbId: '91',
  dockerId: 'a'.repeat(64), operationId: randomUUID(), capability: 'b'.repeat(64), expiresAt: Date.now() + 600000 },
  'synthetic-artifact-smoke')
const options = await port.prepare()
assert.equal(options.args[0], '--conditions=openclaude-precompiled')
const child = spawnSync(options.command, options.args, { cwd: options.subprocessCwd,
  env: options.env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })
assert.equal(child.error, undefined)
assert.equal(child.status, 1)
assert.equal(child.stdout, '')
assert.equal(child.stderr, 'CC5_INTERACTIVE_BRIDGE_FAILED\n')
console.log('PASS actual prepare command/args/allowlist-env load the precompiled child; absent binding fails with fixed stderr only')
