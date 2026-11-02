import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createMasterCc5Runtime, parseCc5DeploymentMetadata } from '../agent-sandbox/cc5Runtime.js'

const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }
function data() {
  return {
    version: 1,
    task: 'AGENT-REMOTE-T1555U',
    testUid: '912',
    user: 'dedicated_cc5',
    taskRoot: '/home/dedicated_cc5/oc-agentremote-t1555u-20261102t1400z-fixture',
    profile: { operationId: randomUUID(), runId: randomUUID() },
  }
}
test('master OFF/nonselfhost/missing authority/invalid UID never reads deployment metadata', () => {
  let reads = 0
  for (const input of [
    { selfhost: true, authorityReady: true, env: {} },
    { selfhost: false, authorityReady: true, env },
    { selfhost: true, authorityReady: false, env },
    {
      selfhost: true,
      authorityReady: true,
      env: { ...env, OC_SELFHOST_CC5_T1555U_TEST_UID: 'all' },
    },
  ]) {
    assert.equal(
      createMasterCc5Runtime(input, {
        read() {
          reads++
          throw new Error('must not read')
        },
      }),
      undefined,
    )
  }
  assert.equal(reads, 0)
})
test('invalid deployment fails only the dedicated lane and reports a fixed diagnostic', () => {
  let rejected = 0
  assert.equal(
    createMasterCc5Runtime(
      { selfhost: true, authorityReady: true, env },
      {
        read() {
          throw new Error('sensitive underlying path must not escape')
        },
        rejected() {
          rejected++
        },
      },
    ),
    undefined,
  )
  assert.equal(rejected, 1)
})
test('deployment can only select public task identities; key/source/network paths are fixed', () => {
  const valid = data()
  const config = parseCc5DeploymentMetadata(Buffer.from(JSON.stringify(valid)), '912')
  assert.equal(config.ssh.user, valid.user)
  assert.ok(config.ssh.privateKeyPath.endsWith('/.task-tmp/cc5-ssh/id_ed25519'))
  assert.equal(config.baseRoot, '/run/oc-cc5-t1555u')
  for (const patch of [
    { testUid: '913' },
    { user: 'root' },
    { taskRoot: '/home/box/oc-agentremote-t1555u-20261102t1400z-fixture' },
    { host: 'different-ssh-server' },
    { privateKeyPath: '/old/key' },
    { version: 2 },
    { profile: { ...valid.profile, operationId: 'invalid' } },
  ]) {
    assert.throws(() =>
      parseCc5DeploymentMetadata(Buffer.from(JSON.stringify({ ...valid, ...patch })), '912'),
    )
  }
})
