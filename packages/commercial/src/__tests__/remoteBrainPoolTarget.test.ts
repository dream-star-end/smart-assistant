/** Pure mapping only: no DB, SSH, key material or remote process is touched. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  remoteCcTargetFromPool,
  type RemoteAgentNodeView,
  type RemoteAgentProfileView,
  type RemoteModelOfferView,
} from '../account-pool/remoteBrainPool.js'

const CONTROLLER = fileURLToPath(
  new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
)
const KNOWN_HOSTS = '/run/pinned/node-7/known_hosts'
const node = {
  id: 'node-7',
  label: 'pool node 7',
  ssh_host: 'node-7.pool.example',
  ssh_port: 2222,
  ssh_user: 'acct_user',
  host_key_fp: 'SHA256:fixture',
  key_id: 'key-7',
} as RemoteAgentNodeView
const profile = {
  id: 'profile-2',
  node_id: 'node-7',
  engine: 'cc',
  profile_name: 'acct-2',
  runner_mode: 'interactive',
} as RemoteAgentProfileView
const offer = {
  id: 'offer-3',
  profile_id: 'profile-2',
  node_id: 'node-7',
  engine: 'cc',
  profile_name: 'acct-2',
  upstream_model_id: 'claude-opus-5',
  canonical_model_id: 'box-claude-opus-5',
} as RemoteModelOfferView

test('a pool node/profile/offer maps onto the gateway remote target without touching the network', () => {
  const target = remoteCcTargetFromPool(node, profile, offer, KNOWN_HOSTS)
  assert.equal(target.host, node.ssh_host)
  assert.equal(target.port, node.ssh_port)
  assert.equal(target.user, node.ssh_user)
  assert.equal(target.upstreamModel, offer.upstream_model_id)
  assert.equal(target.profileDir, profile.profile_name)
  assert.equal(target.taskRootPrefix, `/home/${node.ssh_user}/oc-agentremote-`)
  assert.equal(target.keyPath, `/etc/openclaude/remote-pool-keys/${node.key_id}/id_ed25519`)
  assert.equal(target.knownHostsPath, KNOWN_HOSTS)
  // The guard on that node is installed for the controller digest this deployment ships.
  assert.equal(
    target.controllerSha256,
    createHash('sha256').update(readFileSync(CONTROLLER)).digest('hex'),
  )
  assert.equal(Object.isFrozen(target), true)
})

test('the default login runs without an account directory, like host.py', () => {
  const target = remoteCcTargetFromPool(node, { ...profile, profile_name: 'default' }, offer, KNOWN_HOSTS)
  assert.equal('profileDir' in target, false)
})

test('mismatched placement rows and non-interactive Claude profiles are refused', () => {
  for (const [badNode, badProfile, badOffer] of [
    [node, { ...profile, node_id: 'node-8' }, offer],
    [node, profile, { ...offer, profile_id: 'profile-9' }],
    [node, profile, { ...offer, node_id: 'node-8' }],
    [node, { ...profile, engine: 'codex' }, offer],
    [node, { ...profile, runner_mode: 'p' }, offer],
  ] as const) {
    assert.throws(() => remoteCcTargetFromPool(
      badNode as unknown as RemoteAgentNodeView,
      badProfile as unknown as RemoteAgentProfileView,
      badOffer as unknown as RemoteModelOfferView,
      KNOWN_HOSTS,
    ), /REMOTE_POOL_TARGET_(MISMATCH|ENGINE_UNSUPPORTED)/)
  }
})

test('the key directory stays deployment-owned, not caller-supplied', () => {
  const before = process.env.OC_REMOTE_POOL_SSH_KEY_DIR
  process.env.OC_REMOTE_POOL_SSH_KEY_DIR = '/fixture/pool-keys'
  try {
    assert.equal(remoteCcTargetFromPool(node, profile, offer, KNOWN_HOSTS).keyPath,
      '/fixture/pool-keys/key-7/id_ed25519')
  } finally {
    if (before === undefined) delete process.env.OC_REMOTE_POOL_SSH_KEY_DIR
    else process.env.OC_REMOTE_POOL_SSH_KEY_DIR = before
  }
})
