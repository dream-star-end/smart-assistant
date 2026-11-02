import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Cc5FinanceFactory } from '@openclaude/gateway/cc5-finance'
import { createMasterCc5Runtime, parseCc5DeploymentMetadata, selectMasterCc5Backend } from '../agent-sandbox/cc5Runtime.js'

const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }
function data() {
  return {
    version: 2,
    task: 'AGENT-REMOTE-T1555U',
    testUid: '912',
    user: 'box',
    taskRoot: '/home/box/oc-agentremote-t1555u-20261102t1400z-fixture',
    profile: { operationId: randomUUID(), runId: randomUUID() },
    scope: { canonicalModel: 'box-claude-sonnet-5', sessionKey: 'agent:main:webchat:dm:new_chat_123' },
  }
}
const financeFactory: Cc5FinanceFactory = () => { throw new Error('must not create finance before binding') }
test('master OFF/nonselfhost/missing authority/invalid UID/missing finance never reads deployment metadata', () => {
  let reads = 0
  for (const input of [
    { selfhost: true, authorityReady: true, env: {}, financeFactory },
    { selfhost: false, authorityReady: true, env, financeFactory },
    { selfhost: true, authorityReady: false, env, financeFactory },
    { selfhost: true, authorityReady: true, env },
    {
      selfhost: true,
      authorityReady: true,
      env: { ...env, OC_SELFHOST_CC5_T1555U_TEST_UID: 'all' },
      financeFactory,
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
      { selfhost: true, authorityReady: true, env, financeFactory },
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
  assert.deepEqual(config.scope, valid.scope)
  assert.deepEqual(config.profile, valid.profile)
  assert.equal(Object.isFrozen(config.scope), true)
  assert.equal(Object.isFrozen(config.profile), true)
  assert.ok(config.ssh.privateKeyPath.endsWith('/.task-tmp/cc5-ssh/id_ed25519'))
  assert.equal(config.baseRoot, '/run/oc-cc5-t1555u')
  for (const patch of [
    { testUid: '913' },
    { user: 'root' },
    { taskRoot: '/home/other/oc-agentremote-t1555u-20261102t1400z-fixture' },
    { host: 'different-ssh-server' },
    { privateKeyPath: '/old/key' },
    { version: 1 },
    { profile: { ...valid.profile, operationId: 'invalid' } },
  ]) {
    assert.throws(() =>
      parseCc5DeploymentMetadata(Buffer.from(JSON.stringify({ ...valid, ...patch })), '912'),
    )
  }
})

test('v2 metadata rejects missing, legacy, auxiliary or expanded backend scopes before runtime IO', () => {
  const valid = data()
  for (const scope of [
    undefined, null, [], 'agent:main:webchat:dm:new_chat_123', {},
    { ...valid.scope, canonicalModel: 'cc5-remote-t1555u' },
    { ...valid.scope, canonicalModel: 'gpt-5.6-sol' },
    { ...valid.scope, sessionKey: 'fixture-session' },
    { ...valid.scope, sessionKey: 'agent:main:cron:dm:new_chat_123' },
    { ...valid.scope, sessionKey: `${valid.scope.sessionKey}\n` },
    { ...valid.scope, operationId: valid.profile.operationId },
  ]) {
    assert.throws(() => parseCc5DeploymentMetadata(Buffer.from(JSON.stringify({ ...valid, scope })), '912'))
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385), Buffer.from([0xff]), Buffer.from('[]')]) {
    assert.throws(() => parseCc5DeploymentMetadata(bytes, '912'))
  }
  let reads = 0
  let rejected = 0
  const runtime = createMasterCc5Runtime({ selfhost: true, authorityReady: true, env, financeFactory }, {
    read(uid) {
      reads++
      return parseCc5DeploymentMetadata(Buffer.from(JSON.stringify({ ...valid, version: 1 })), uid)
    },
    rejected() { rejected++ },
  })
  assert.equal(runtime, undefined)
  assert.equal(reads, 1)
  assert.equal(rejected, 1)
})


test('enabled incomplete setup rejects rather than silently selecting the ordinary same-model worker', () => {
  const input = { uid: 912, containerId: 91, sessionKey: 'agent:main:webchat:dm:new_chat_123',
    canonicalModel: 'box-claude-sonnet-5', engine: 'ccb' }
  assert.throws(() => selectMasterCc5Backend(undefined, input, true, env), /CC5_FRESH_CONTAINER_BINDING_REJECTED/)
  assert.equal(selectMasterCc5Backend(undefined, input, false, env), undefined)
  assert.equal(selectMasterCc5Backend(undefined, { ...input, uid: 913 }, true, env), undefined)
  assert.equal(selectMasterCc5Backend(undefined, input, true, {}), undefined)
})
