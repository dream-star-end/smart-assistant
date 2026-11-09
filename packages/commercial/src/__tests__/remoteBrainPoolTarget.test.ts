/** Pool target mapping and lane placement: a recording pool, no SSH, key material or remote process. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  buildProvisionPacket,
  placeRemoteLane,
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
  assert.equal(target.keyPath, `/etc/openclaude/remote-pool-keys/${node.key_id}-exec/id_ed25519`)
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
      '/fixture/pool-keys/key-7-exec/id_ed25519')
  } finally {
    if (before === undefined) delete process.env.OC_REMOTE_POOL_SSH_KEY_DIR
    else process.env.OC_REMOTE_POOL_SSH_KEY_DIR = before
  }
})

/** Recording pool: candidate rows, the chat's binding rows, and every statement issued. */
function placementPool(candidates: Array<Record<string, unknown>>, bindings: Array<Record<string, unknown>> = [], used = 0) {
  const statements: Array<{ sql: string; params: unknown[] }> = []
  return {
    statements,
    pool: { async connect(this: {query: (sql: string, params?: unknown[]) => Promise<unknown>}) { return { query: this.query.bind(this), release() {} } }, async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params })
      if (sql.includes('FROM remote_model_offers')) return { rows: candidates }
      if (sql.includes('COUNT(*)')) return { rows: [{ node_used: 0, profile_used: used }] }
      if (sql.includes("state<>'released' LIMIT 1")) return { rows: [] }
      if (sql.includes('FROM remote_agent_bindings')) return { rows: bindings }
      return { rows: [], rowCount: 1 }
    } } as unknown as NonNullable<Parameters<typeof placeRemoteLane>[1]>['pool'],
  }
}
const candidate = (over: Record<string, unknown> = {}) => ({
  profile_id: 'profile-2', node_id: 'node-7', engine: 'cc', profile_name: 'acct-2', runner_mode: 'interactive',
  max_concurrent_lanes: 5, weight: 100, health_score: 100, hot_slots: 0, active_slots: 0, max_hot_slots: 4, max_active_slots: 5,
  offer_id: 'offer-3', upstream_model_id: 'claude-opus-5-5', canonical_model_id: 'claude-opus-5-5-remote',
  label: 'pool node 7', ssh_host: 'node-7.pool.example', ssh_port: 22, ssh_user: 'box',
  host_key_fp: 'SHA256:fixture', key_id: 'key-7', rtt_ms_p50: 40, node_status: 'active', ...over,
})
const request = { uid: 3, containerDbId: '91', dockerId: 'd'.repeat(64),
  sessionKey: 'agent:main:webchat:dm:chat_a1b2c3d4', canonicalModel: 'claude-opus-5-5-remote' }

test('a first turn ranks the offering profile, packages its node root and records the binding as evidence', async () => {
  const { pool, statements } = placementPool([candidate()])
  const packets: unknown[] = []
  const placed = await placeRemoteLane(request, { pool, controllerPath: CONTROLLER,
    packet: async (input) => { packets.push(input); return Buffer.from('packet') } })
  assert.match(placed.operationId, /^[0-9a-f-]{36}$/)
  assert.equal(placed.taskRoot, `/home/box/oc-agentremote-c${placed.operationId.replace(/-/g, '').slice(0, 23)}`)
  assert.deepEqual([placed.nodeId, placed.profileId, placed.target.host, placed.target.upstreamModel, placed.target.profileDir],
    ['node-7', 'profile-2', 'node-7.pool.example', 'claude-opus-5-5', 'acct-2'])
  assert.equal(placed.target.knownHostsPath, '/etc/openclaude/remote-pool-keys/key-7-exec/known_hosts')
  assert.deepEqual(packets, [{ controllerPath: CONTROLLER, suffix: placed.taskRoot.split('oc-agentremote-')[1],
    home: '/home/box', operationId: placed.operationId, runId: placed.runId }])
  const insert = statements.find((s) => s.sql.includes('INSERT INTO remote_agent_bindings'))!
  assert.deepEqual(insert.params, [placed.operationId, placed.runId, 3, '91', 'd'.repeat(64), request.sessionKey,
    'node-7', 'profile-2', 'claude-opus-5-5-remote', 'cc', 'cc5-interactive-v1', '1', null, null,JSON.stringify({version:1,target:placed.target,taskRoot:placed.taskRoot,
      operationId:placed.operationId,runId:placed.runId,generation:'1',controllerPath:CONTROLLER}),true]) // CC must never claim Codex no-effect recovery
})

test('a placed chat keeps its profile and ids; an unavailable home profile fails instead of moving the chat', async () => {
  const sticky = { operation_id: '11111111-1111-4111-8111-111111111111',
    run_id: '22222222-2222-4222-8222-222222222222', profile_id: 'profile-2', generation: '1' }
  const both = [candidate({ profile_id: 'profile-9', weight: 1_000_000 }), candidate()]
  const { pool } = placementPool(both, [sticky])
  const placed = await placeRemoteLane(request, { pool, packet: async () => Buffer.from('packet') })
  assert.deepEqual([placed.operationId, placed.runId, placed.profileId],
    [sticky.operation_id, sticky.run_id, 'profile-2'])
  const gone = placementPool([candidate({ profile_id: 'profile-9' })], [sticky])
  await assert.rejects(placeRemoteLane(request, { pool: gone.pool, packet: async () => Buffer.from('x') }),
    /REMOTE_LANE_PROFILE_UNAVAILABLE/)
  assert.equal(gone.statements.some((s) => s.sql.includes('INSERT INTO remote_agent_bindings')), false)
  // A home profile that is only full is a capacity wait the caller can end by reclaiming a lane.
  const full = placementPool([candidate()], [sticky], 5)
  await assert.rejects(placeRemoteLane(request, { pool: full.pool, packet: async () => Buffer.from('x') }),
    /REMOTE_LANE_CAPACITY_EXHAUSTED/)
  assert.equal(full.statements.some((s) => s.sql.includes('INSERT INTO remote_agent_bindings')), false)
  await assert.rejects(placeRemoteLane(request, { pool: placementPool([]).pool, packet: async () => Buffer.from('x') }),
    /NO_ELIGIBLE_REMOTE_PROFILE/)
})

test('the provision packet is the real controller output for that root', async () => {
  const packet = JSON.parse((await buildProvisionPacket({ controllerPath: CONTROLLER,
    suffix: 'c0123456789abcdef0123456', home: '/home/box',
    operationId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222' })).toString())
  assert.deepEqual(Object.keys(packet).sort(), ['install', 'profile', 'version'])
  assert.equal(packet.install.root, '/home/box/oc-agentremote-c0123456789abcdef0123456')
  assert.equal(packet.install.session, 'oc-ar-c0123456789abcdef0123456')
  assert.deepEqual([packet.profile.operationId, packet.profile.runId],
    ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
})
