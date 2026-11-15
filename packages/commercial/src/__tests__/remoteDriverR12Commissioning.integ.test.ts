/**
 * Milestone R12 PostgreSQL + real gateway relay/finance integration suite (`OCV5-749`).
 * Covers all 6 required test groups (`modelResolution`, `verificationBudget`, `verificationCatalog`,
 * `sandboxRedProof`, full 8-item `RemoteDriverV4CommissioningService` cutover + rollback, and `driftScheduler`).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadBoxBridgeMod } from '@openclaude/gateway'
import {
  RemoteEngineAdapter,
  RemotePoolSshHost,
  remotePoolBackendOf,
} from '@openclaude/gateway/remote-pool'
import {
  REMOTE_DRIVER_PROTOCOL_VERSION,
  type RemoteProbeSnapshot,
  remoteCanonicalSha256,
} from '@openclaude/protocol'
import { Pool } from 'pg'
import { countEligibleEnabledRemoteOffers } from '../account-pool/remoteBrainPool.js'
import { resolveLegacyCcControllerPath } from '../account-pool/remoteLaneRecovery.js'
import {
  RemoteDriverV4CommissioningService,
  type VerificationWorkerController,
  admitVerificationTurnBudget,
  assertVerificationRunAuthorized,
  authorizeProfileInVerificationPolicy,
  buildDefaultDriverContextForNode,
  computeProbeFingerprintTs,
  createDriverVerificationCatalog,
  defaultAgentRemoteRoot,
  loadRemoteDriverRegistry,
  loadVerificationPolicy,
  placeRemoteDriverLane,
  resolveProbedUpstreamModel,
  startRemoteDriverDriftScheduler,
  upsertVerificationPolicy,
  verifySandboxRedProofForDriver,
} from '../account-pool/remotePool/index.js'
import { computeProductionConformanceSuiteDigest } from '../account-pool/remotePool/profileCutover.js'
import { buildProveRunLocalStoppedPy } from '../account-pool/remotePool/verificationRuntimeProof.js'
import { ModelCatalogSnapshot } from '../billing/modelCatalog.js'
import { InMemoryPreCheckRedis } from '../billing/preCheck.js'
import { closePool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { admitDispatch } from '../dispatch/turnDispatchStore.js'
import { createLogger } from '../logging/logger.js'
import { AuthoritySigner } from '../ws/authoritySigner.js'
import { resetAndMigrateBefore } from './helpers/db.js'

const url = process.env.TEST_DATABASE_URL
assert.ok(
  url && new URL(url).pathname.endsWith('_test'),
  'explicit isolated TEST_DATABASE_URL required',
)
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 2000 })
const tempDirs: string[] = []
const makeTmp = (prefix: string) => {
  const d = mkdtempSync(prefix)
  tempDirs.push(d)
  return d
}

function writeFakeCcCli(dir: string): string {
  const p = join(dir, 'fake-cc-cli.py')
  writeFileSync(
    p,
    `#!/usr/bin/env python3
import json, os, pathlib, re, subprocess, sys
args = sys.argv[1:]
av = lambda f, d='': args[args.index(f)+1] if f in args else d
if args == ['--version']: print('2.1.0 (Claude Code)'); sys.exit(0)
sid = av('--session-id') or av('--resume') or f'11111111-2222-4333-8444-{os.getpid():012d}'
oc = json.loads(pathlib.Path(av('--mcp-config')).read_text())['mcpServers']['ocbridge']
def mcp(reqs):
  return subprocess.Popen([oc['command'], *oc['args']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).communicate(''.join(json.dumps(r)+'\\n' for r in reqs), timeout=15)[0]
mcp([{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'cc','version':'2.1.0'}}}])
sys.stdout.write(json.dumps({'type':'system','subtype':'init','session_id':sid,'model':av('--model','haiku'),'tools':['mcp__ocbridge__Write']})+'\\n'); sys.stdout.flush()
seq = 0
for raw in sys.stdin:
  if not raw.strip(): continue
  msg = json.loads(raw)
  if msg.get('type') != 'user': continue
  seq += 1; txt = msg['message']['content'][0]['text']; cid = f'toolu_{seq}'; m = re.search(r'\{"file_path"[^}]+\}', txt); aborted = False
  if m and 'Do NOT call mcp__ocbridge__Write' not in txt:
    ta = json.loads(m.group(0))
    sys.stdout.write(json.dumps({'type':'assistant','session_id':sid,'message':{'model':'haiku','role':'assistant','content':[{'type':'tool_use','id':cid,'name':'mcp__ocbridge__Write','input':ta}]}})+'\\n'); sys.stdout.flush()
    out = mcp([{'jsonrpc':'2.0','id':10+seq,'method':'tools/call','params':{'name':'Write','arguments':ta,'_meta':{'claudecode/toolUseId':cid}}}])
    aborted = any(json.loads(l).get('result',{}).get('isError') for l in out.splitlines() if l.strip())
  sys.stdout.write(json.dumps({'type':'stream_event','session_id':sid,'event':{'type':'content_block_delta','delta':{'type':'text_delta','text':f'ok-{seq}'}}})+'\\n')
  sys.stdout.write(json.dumps({'type':'result','subtype':'error_during_execution' if aborted else 'success','is_error':aborted,'session_id':sid,'uuid':f'r-{os.getpid()}-{seq}','usage':{'input_tokens':1000*seq,'output_tokens':200*seq,'cache_read_input_tokens':100,'cache_creation_input_tokens':50}})+'\\n'); sys.stdout.flush()
`,
  )
  chmodSync(p, 0o755)
  return p
}

function makeCcProbe(cliPath: string, models: RemoteProbeSnapshot['models']): RemoteProbeSnapshot {
  const reg = loadRemoteDriverRegistry().get('cc')!
  const cliSha256 = createHash('sha256').update(readFileSync(cliPath)).digest('hex')
  return {
    schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: reg.engineId,
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    source: 'cc:live-probe',
    freshness: 'cli-observed',
    observedAt: new Date().toISOString(),
    authPresent: true,
    accountObserved: true,
    cliVersion: '2.1.0',
    cliSha256,
    bridgeSha256: loadBoxBridgeMod().sha256,
    models,
    rawResponseSha256: 'd'.repeat(64),
  }
}

function makeBarrier() {
  let resArr!: () => void
  let resRel!: (v: boolean) => void
  const arrived = new Promise<void>((r) => {
    resArr = r
  })
  const relP = new Promise<boolean>((r) => {
    resRel = r
  })
  return {
    arrived,
    markArrived: () => resArr(),
    waitRel: () => relP,
    release: (abort: boolean) => resRel(abort),
  }
}

async function seedUserNode(tag: string) {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role, credits)
     VALUES (3, 'operator3@test.local', 'hash', 'admin', 10000000)
     ON CONFLICT (id) DO UPDATE SET credits = 10000000`,
  )
  const existingContainer = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM agent_containers WHERE user_id = 3 AND state = 'active' AND runtime_channel = 'v5' LIMIT 1`,
  )
  const containerDbId =
    existingContainer.rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO agent_containers (user_id, secret_hash, state, runtime_channel)
     VALUES (3, decode(repeat('ab', 32), 'hex'), 'active', 'v5') RETURNING id::text AS id`,
      )
    ).rows[0]!.id
  const nodeId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_nodes (label, ssh_host, ssh_port, ssh_user, host_key_fp, key_id, controller_sha256, status, health_score, rtt_ms_p50)
     VALUES ($1, '127.0.0.1', 22, 'agent', 'SHA256:fp', $2, $3, 'active', 100, 5)
     RETURNING id::text AS id`,
      [`r12-node-${tag}-${randomUUID().slice(0, 8)}`, `k-${tag}`, 'e'.repeat(64)],
    )
  ).rows[0]!.id
  return {
    nodeId,
    containerDbId,
    dockerId: createHash('sha256').update(`r12-docker-${tag}`).digest('hex'),
  }
}

before(async () => {
  setPoolOverride(pool)
  await resetAndMigrateBefore('0338')
  await runMigrations()
  await pool.query(`DELETE FROM model_catalog WHERE model_id = 'claude-haiku-5-5-remote'`)
  await pool.query(
    `INSERT INTO model_catalog (model_id, engine, provider_id, placement, upstream_model_id, context_window, capability_profile, capability_schema_version, state, pool_auto_disabled)
     VALUES ('claude-haiku-5-5-remote', 'ccb', 'anthropic', 'remote_pool', 'haiku', 200000, $1::jsonb, 1, 'staged', FALSE)`,
    [
      JSON.stringify({
        supports_vision: false,
        reasoning: { supported: [], codex_model_default: null },
        ccb: { context_owner: 'box-native-v1', capability_zero: true, supports_thinking: false },
      }),
    ],
  )
  await pool.query(
    `UPDATE model_catalog SET state = 'active' WHERE model_id = 'claude-haiku-5-5-remote'`,
  )
  await pool.query(
    `INSERT INTO model_pricing (model_id, display_name, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, multiplier, enabled, visibility, sort_order)
     VALUES ('claude-haiku-5-5-remote', 'Claude Haiku 5.5 Remote', 100, 500, 10, 125, 1.0, TRUE, 'public', 10)
     ON CONFLICT (model_id) DO UPDATE SET enabled = TRUE, visibility = 'public'`,
  )
})
after(async () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
  await closePool()
})

test('Group 1: resolveProbedUpstreamModel maps codex direct & cc aliases, filters eligible offers, and places cc alias', async () => {
  const sandbox = makeTmp('/tmp/oc-drvtest-r12g1-')
  const cliPath = writeFakeCcCli(sandbox)
  const ccProbe = makeCcProbe(cliPath, [
    {
      upstreamModelId: 'haiku',
      displayName: 'Haiku',
      supportedEfforts: ['low', 'medium'],
      defaultEffort: 'low',
      supportsAdaptiveThinking: true,
      supportsVision: false,
    },
    {
      upstreamModelId: 'sonnet',
      displayName: 'Sonnet',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsAdaptiveThinking: true,
      supportsVision: true,
    },
    {
      upstreamModelId: 'opus',
      displayName: 'Opus',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsAdaptiveThinking: true,
      supportsVision: true,
    },
  ])
  const codexReg = loadRemoteDriverRegistry().get('codex')!
  const codexProbe: RemoteProbeSnapshot = {
    ...ccProbe,
    driverId: 'codex',
    engineId: codexReg.engineId,
    driverVersion: codexReg.driverVersion,
    nativeSha256: 'b'.repeat(64),
    bridgeSha256: undefined,
    models: [
      {
        upstreamModelId: 'gpt-6-luna',
        displayName: 'GPT 6 Luna',
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportsAdaptiveThinking: true,
        supportsVision: true,
      },
    ],
  }

  assert.equal(resolveProbedUpstreamModel('codex', 'gpt-6-luna', codexProbe), 'gpt-6-luna')
  assert.equal(resolveProbedUpstreamModel('cc', 'claude-haiku-5-5', ccProbe), 'haiku')
  assert.equal(resolveProbedUpstreamModel('cc', 'claude-sonnet-5-5', ccProbe), 'sonnet')
  assert.equal(resolveProbedUpstreamModel('cc', 'claude-opus-5-5', ccProbe), 'opus')
  assert.equal(resolveProbedUpstreamModel('codex', 'nonexistent-model', codexProbe), null)
  assert.equal(
    buildDefaultDriverContextForNode({
      driverId: 'cc',
      sshUser: 'agent',
      profileName: 'p1',
      controllerSha256: 'e'.repeat(64),
      cliVersion: '2.1.0',
    }).cliPath,
    '/home/agent/.oc-remote-cc/claude-2.1.0',
  )

  const fx = await seedUserNode('g1')
  const reg = loadRemoteDriverRegistry().get('cc')!
  const fp = computeProbeFingerprintTs(ccProbe, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: '1'.repeat(64),
  })
  const suiteDigest = computeProductionConformanceSuiteDigest()
  const manifest = {
    driverId: 'cc',
    engineId: reg.engineId,
    driverVersion: reg.driverVersion,
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    suiteDigest,
    policySha256: '1'.repeat(64),
    driverContext: { cliPath },
  }
  const profId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, status, execution_ready, ready_generation, verified_fingerprint, last_probe_ok_at, auth_epoch, probe_snapshot, execution_manifest, max_concurrent_lanes)
     VALUES ($1, 'cc', 'cc', $2, 'cc-alias', $3, 'active', FALSE, 1, $4, NOW(), 'ae-1', $5::jsonb, $6::jsonb, 4) RETURNING id::text AS id`,
      [
        fx.nodeId,
        reg.engineId,
        'f'.repeat(64),
        fp,
        JSON.stringify(ccProbe),
        JSON.stringify(manifest),
      ],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, canonical_model_id, upstream_model_id, base_display_name, enabled) VALUES ($1, 'claude-haiku-5-5-remote', 'haiku', 'Haiku 5.5', TRUE)`,
    [profId],
  )
  assert.equal(await countEligibleEnabledRemoteOffers('claude-haiku-5-5-remote', pool), 0)
  await pool.query('UPDATE remote_agent_profiles SET execution_ready = TRUE WHERE id = $1', [
    profId,
  ])
  assert.equal(await countEligibleEnabledRemoteOffers('claude-haiku-5-5-remote', pool), 1)

  const placed = await placeRemoteDriverLane(
    {
      uid: 3,
      containerDbId: fx.containerDbId,
      dockerId: fx.dockerId,
      sessionKey: 'sess-r12-g1',
      canonicalModel: 'claude-haiku-5-5-remote',
      driverId: 'cc',
    },
    { pool, localSandboxDir: sandbox },
  )
  assert.equal(placed.profileUuid, profId)
  assert.equal(placed.binding.upstreamModel, 'haiku')
  await pool.query(`UPDATE remote_agent_bindings SET state = 'released' WHERE operation_id = $1`, [
    placed.binding.operationId,
  ])
})

test('Group 2: verificationBudget enforces policy auth epoch/sha, turn cap, run cap, and daily cap', async () => {
  const fx = await seedUserNode('g2')
  const profId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles (node_id, engine, driver_id, profile_name, account_fingerprint, status, auth_epoch, execution_manifest)
     VALUES ($1, 'codex', 'codex', 'budget-prof', 'acct-b', 'active', 'epoch-1', $2::jsonb) RETURNING id::text AS id`,
      [fx.nodeId, JSON.stringify({ policySha256: '1'.repeat(64) })],
    )
  ).rows[0]!.id

  const saved = await upsertVerificationPolicy(
    pool,
    {
      maxPaidTurnsPerRun: 2,
      maxCreditsPerRun: 100,
      maxCreditsPerDay: 150,
      autoVerifyEnabled: false,
    },
    3,
  )
  assert.equal(saved.maxPaidTurnsPerRun, 2)
  assert.equal((await loadVerificationPolicy(pool)).maxCreditsPerDay, 150)

  await authorizeProfileInVerificationPolicy(pool, {
    profileId: profId,
    driverId: 'codex',
    accountFingerprint: 'acct-b',
    authEpoch: 'epoch-1',
    policySha256: '1'.repeat(64),
    authorizedByUid: 3,
    authorizedAt: new Date().toISOString(),
  })
  const runId = randomUUID()
  await pool.query(
    `INSERT INTO remote_driver_verification_runs (id, profile_id, node_id, driver_id, engine_id, target_fingerprint, driver_digest, core_digest, suite_digest, ready_generation, auth_epoch, state, attempt_count, lease_owner, lease_until)
     VALUES ($1, $2, $3, 'codex', 'codex-app-server', $4, $5, $6, $7, 1, 'epoch-1', 'running', 1, 'owner-1', NOW() + INTERVAL '5 minutes')`,
    [runId, profId, fx.nodeId, '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64)],
  )
  await assertVerificationRunAuthorized(pool, runId, { allowManualUnbound: true })

  const b1 = await admitVerificationTurnBudget(pool, {
    runId,
    requestId: `rdv-${runId}-g1-1`,
    reserveCredits: 40,
  })
  assert.equal(b1.paidTurnsSoFar, 0)
  for (const idx of [1, 2]) {
    await admitDispatch(pool, {
      dispatchId: randomUUID(),
      userId: 3n,
      sessionId: `agent:main:v4v:${runId}`,
      clientMessageId: `rdv-${runId}-g1-${idx}`,
      agentId: 'main',
      model: 'gpt-6-luna-remote',
      requestHash: String(idx).repeat(64),
      billingRequestId: `rdv-${runId}-g1-${idx}`,
      ownerId: 'owner-1',
      anchorSeq: null,
      agentContainerId: Number(fx.containerDbId),
      runtimeKind: 'v5',
    })
  }
  await assert.rejects(
    () =>
      admitVerificationTurnBudget(pool, {
        runId,
        requestId: `rdv-${runId}-g1-3`,
        reserveCredits: 10,
      }),
    /REMOTE_VERIFICATION_TURN_CAP_EXCEEDED/,
  )

  await pool.query(`UPDATE remote_agent_profiles SET auth_epoch = 'epoch-drifted' WHERE id = $1`, [
    profId,
  ])
  await assert.rejects(
    () => assertVerificationRunAuthorized(pool, runId, { allowManualUnbound: false }),
    /REMOTE_VERIFICATION_PROFILE_NOT_AUTHORIZED/,
  )
})

test('Group 3: verificationCatalog activates pool_auto_disabled models privately and rejects admin disables', async () => {
  const sandbox = makeTmp('/tmp/oc-drvtest-r12g3-')
  const ccProbe = makeCcProbe(writeFakeCcCli(sandbox), [
    {
      upstreamModelId: 'haiku',
      displayName: 'Haiku',
      supportedEfforts: ['low', 'medium'],
      defaultEffort: 'low',
      supportsAdaptiveThinking: true,
      supportsVision: false,
    },
  ])
  await pool.query(
    `UPDATE model_catalog SET state = 'disabled', pool_auto_disabled = TRUE WHERE model_id = 'claude-haiku-5-5-remote'`,
  )
  const stubLive = new ModelCatalogSnapshot({
    securityEpoch: 1n,
    entries: [],
    aliases: new Map(),
    pricing: new Map(),
  })
  const cat = createDriverVerificationCatalog({
    pool,
    source: { assertFresh: async () => stubLive },
    loadAuthz: async () => ({
      role: 'admin',
      grantedModelIds: new Set(['claude-haiku-5-5-remote']),
    }),
    driverId: 'cc',
    canonicalModel: 'claude-haiku-5-5-remote',
    verifiedProbe: ccProbe,
    fence: async () => {},
  })
  const snap = await cat.assertFresh()
  const resolved = snap.resolve('claude-haiku-5-5-remote')
  assert.equal(resolved?.upstreamModelId, 'haiku')
  assert.equal(resolved?.placement, 'remote_pool')

  await pool.query(
    `UPDATE model_catalog SET pool_auto_disabled = FALSE WHERE model_id = 'claude-haiku-5-5-remote'`,
  )
  await assert.rejects(() => cat.assertFresh(), /REMOTE_VERIFICATION_MODEL_ADMIN_DISABLED/)
  await pool.query(
    `UPDATE model_catalog SET state = 'active', pool_auto_disabled = FALSE WHERE model_id = 'claude-haiku-5-5-remote'`,
  )
})

test('Group 4: sandboxRedProof validates real committed proof for codex & cc and rejects tampered proof', async () => {
  const reg = loadRemoteDriverRegistry()
  const suiteDigest = computeProductionConformanceSuiteDigest()
  for (const driverId of ['codex', 'cc'] as const) {
    const entry = reg.get(driverId)!
    const res = verifySandboxRedProofForDriver({
      driverId,
      expectedDriverDigest: entry.driverDigest,
      expectedCoreDigest: entry.coreDigest,
      expectedSuiteDigest: suiteDigest,
    })
    assert.equal(res.driverEntry.driverId, driverId)
    assert.equal(res.driverEntry.requirements.length, 8)
  }
  const tmpDir = makeTmp('/tmp/oc-drvtest-r12red-')
  const proofPath = join(tmpDir, 'tampered.json')
  const valid = verifySandboxRedProofForDriver({
    driverId: 'codex',
    expectedDriverDigest: reg.get('codex')!.driverDigest,
    expectedCoreDigest: reg.get('codex')!.coreDigest,
    expectedSuiteDigest: suiteDigest,
  })
  const orig = JSON.parse(readFileSync(valid.proofPath, 'utf8'))
  orig.drivers.codex.requirements[0].redControlCaught = false
  writeFileSync(proofPath, JSON.stringify(orig))
  assert.throws(
    () =>
      verifySandboxRedProofForDriver({
        driverId: 'codex',
        expectedDriverDigest: reg.get('codex')!.driverDigest,
        expectedCoreDigest: reg.get('codex')!.coreDigest,
        expectedSuiteDigest: suiteDigest,
        proofPath,
      }),
    /REMOTE_SANDBOX_RED_PROOF_INVALID/,
  )
})

test('Group 5: RemoteDriverV4CommissioningService drives full 8-item cutover pass and auto-reverts on failure', async () => {
  const sandbox = makeTmp('/tmp/oc-drvtest-r12e2e-')
  const evidenceRoot = makeTmp('/tmp/oc-drvtest-r12ev-')
  const cliPath = writeFakeCcCli(sandbox)
  const ccProbe = makeCcProbe(cliPath, [
    {
      upstreamModelId: 'haiku',
      displayName: 'Haiku',
      supportedEfforts: [],
      defaultEffort: null,
      supportsAdaptiveThinking: false,
      supportsVision: false,
    },
  ])
  const fx = await seedUserNode('g5')
  const reg = loadRemoteDriverRegistry().get('cc')!
  const g5PolicySha = remoteCanonicalSha256({
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    toolsFlag: '',
    strictMcp: true,
    settingSources: '',
    disableSlashCommands: true,
  })
  const g5ProbeFp = computeProbeFingerprintTs(ccProbe, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: g5PolicySha,
  })
  const profId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles (node_id, engine, profile_name, account_fingerprint, status, execution_ready, ready_generation, auth_epoch, probe_snapshot, execution_manifest, max_concurrent_lanes)
     VALUES ($1, 'cc', 'cc-e2e', $2, 'active', FALSE, 1, 'ae-e2e', $3::jsonb, $4::jsonb, 4) RETURNING id::text AS id`,
      [
        fx.nodeId,
        '9'.repeat(64),
        JSON.stringify(ccProbe),
        JSON.stringify({
          driverContext: {
            cliPath,
            mcpClientPath: join(defaultAgentRemoteRoot(), 'core', 'mcp_client.py'),
            accountHome: sandbox,
            profileName: 'cc-e2e',
            bridgeMode: 'stdio-fixture',
          },
        }),
      ],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, canonical_model_id, upstream_model_id, base_display_name, enabled) VALUES ($1, 'claude-haiku-5-5-remote', 'haiku', 'Haiku 5.5', TRUE)`,
    [profId],
  )

  const signer = AuthoritySigner.createEphemeral()
  const stubLive = new ModelCatalogSnapshot({
    securityEpoch: 1n,
    entries: [],
    aliases: new Map(),
    pricing: new Map(),
  })
  const makeSvc = (failMidCase = false) => {
    let settled!: (j: Record<string, unknown>) => void
    const done = new Promise<Record<string, unknown>>((r) => {
      settled = r
    })
    const svc = new RemoteDriverV4CommissioningService({
      executorDeps: {
        pool,
        preCheckRedis: new InMemoryPreCheckRedis(),
        catalog: { assertFresh: async () => stubLive },
        keyring: () => signer.publicKeyring(),
        signer,
        loadUserModelAuthz: async () => ({
          role: 'admin',
          grantedModelIds: new Set(['claude-haiku-5-5-remote']),
        }),
        log: createLogger({ level: 'error', out: () => {} }),
        containerSource: async () => ({
          containerDbId: fx.containerDbId,
          dockerId: fx.dockerId,
          containerName: `c-${fx.containerDbId}`,
        }),
        evidenceRoot,
        fixtures: {
          localSandboxDir: sandbox,
          skipCatalogSync: true,
          proveRuntime: async (dockerId) => ({
            dockerId,
            imageId: 'sha256:r12-test-image',
            manifestSha256: 'm'.repeat(64),
            verifiedFiles: { cc: reg.driverDigest },
          }),
          proveLocalStopped: async () => {},
          proveContainer: async (_d, a) => {
            for (const f of a.expectedFiles ?? [])
              assert.equal(
                readFileSync(join(sandbox, 'c-lanes', a.laneId, f.path.split('/').pop()!), 'utf8'),
                f.content,
              )
            for (const f of a.absentFiles ?? [])
              assert.ok(
                !readdirSync(join(sandbox, 'c-lanes', a.laneId)).includes(f.split('/').pop()!),
              )
            return {
              laneId: a.laneId,
              localStopped: true,
              checkedSupervisors: [12345],
              checkedSentinels: [],
            }
          },
          hostFactory: (_t, spec) => {
            const base = RemotePoolSshHost.forLocalSandbox(spec)
            const isLowMem =
              typeof spec.manifest.maxSliceMemoryBytes === 'number' &&
              spec.manifest.maxSliceMemoryBytes <= 64 * 1024 * 1024
            const stopObj = {
              remoteStopped: true,
              proof: { scopes: isLowMem ? [] : ['s1', 's2'], populated: 0 },
              fence: { scopes: isLowMem ? [] : ['s1', 's2'] },
            }
            Object.defineProperties(base, {
              verifiedStopEvidence: { get: () => stopObj, configurable: true },
              preflight: {
                value: async () =>
                  typeof spec.manifest.maxSliceMemoryBytes === 'number' &&
                  spec.manifest.maxSliceMemoryBytes <= 64 * 1024 * 1024
                    ? {
                        memoryOk: false as const,
                        code: 'REMOTE_NODE_MEMORY_EXHAUSTED' as const,
                        activeSessions: 1,
                      }
                    : { memoryOk: true as const, activeSessions: 0 },
                configurable: true,
              },
              stop: {
                value: async () => {
                  await RemotePoolSshHost.prototype.stop.call(base).catch(() => {})
                  return stopObj
                },
                configurable: true,
              },
            })
            return base
          },
          spawnWorker: async ({ keyring, relays }): Promise<VerificationWorkerController> => {
            const kMap = new Map(
              keyring.map(([id, b64]) => [id, new Uint8Array(Buffer.from(b64, 'base64'))]),
            )
            const lanes = new Map<
              string,
              {
                laneCwd: string
                server: Server
                adapter: RemoteEngineAdapter
                calls: Array<{ name: string; filePath: string; content: string; isError: boolean }>
                barrierMode: string
                barrier?: ReturnType<typeof makeBarrier>
                activeRun?: { end(): void }
                nativeSessionId: string | null
                closed: boolean
              }
            >()
            return {
              async openLane(opts) {
                assert.equal(opts.effort, undefined)
                const laneCwd = join(sandbox, 'c-lanes', opts.laneId)
                mkdirSync(laneCwd, { recursive: true })
                const sockPath = join(sandbox, `r-${opts.laneId}-${randomUUID().slice(0, 6)}.sock`)
                const server: Server = createServer(async (req, res) => {
                  const chunks: Buffer[] = []
                  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
                  try {
                    const reply = await relays
                      .get(opts.laneId)!
                      .handleControl(
                        req.url ?? '/',
                        JSON.parse(Buffer.concat(chunks).toString('utf8')),
                      )
                    res.writeHead(200, { 'content-type': 'application/json' })
                    res.end(JSON.stringify(reply))
                  } catch (e) {
                    res.writeHead(403, { 'content-type': 'application/json' })
                    res.end(
                      JSON.stringify({ ok: false, error: e instanceof Error ? e.message : 'ERR' }),
                    )
                  }
                })
                server.listen(sockPath)
                await once(server, 'listening')
                const calls: Array<{
                  name: string
                  filePath: string
                  content: string
                  isError: boolean
                }> = []
                const st: {
                  laneCwd: string
                  server: Server
                  adapter?: RemoteEngineAdapter
                  calls: typeof calls
                  barrierMode: string
                  barrier?: ReturnType<typeof makeBarrier>
                  activeRun?: { end(): void }
                  nativeSessionId: string | null
                  closed: boolean
                } = {
                  laneCwd,
                  server,
                  calls,
                  barrierMode: opts.barrierMode ?? 'none',
                  nativeSessionId: null,
                  closed: false,
                }
                const hostFactory = () => ({
                  tools: async () => [
                    {
                      name: 'Write',
                      description: 'Write',
                      inputSchema: {
                        type: 'object',
                        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
                        required: ['file_path', 'content'],
                      },
                    },
                  ],
                  execute: async (name: string, args: Record<string, unknown>) => {
                    assert.equal(name, 'Write')
                    if (st.barrierMode === 'hold_until_release') {
                      st.barrier = st.barrier ?? makeBarrier()
                      st.barrier.markArrived()
                      if (await st.barrier.waitRel())
                        return {
                          content: [{ type: 'text', text: 'BARRIER_ABORTED' }],
                          isError: true,
                        }
                    }
                    const fp = String(args.file_path)
                    writeFileSync(fp, String(args.content))
                    calls.push({
                      name,
                      filePath: fp,
                      content: String(args.content),
                      isError: false,
                    })
                    return { content: [{ type: 'text', text: 'WROTE' }], isError: false }
                  },
                  close: async () => {},
                })
                const b = opts.binding as never
                const adapter = new RemoteEngineAdapter(
                  {
                    peerId: 'u3',
                    sessionKey: (b as { sessionKey: string }).sessionKey,
                    executionBackend: remotePoolBackendOf(b),
                    agentId: 'main',
                    agentBaseDir: laneCwd,
                    model: 'claude-haiku-5-5-remote',
                    effortLevel: opts.effort,
                    config: {
                      version: 1,
                      defaults: {
                        model: 'claude-haiku-5-5-remote',
                        permissionMode: 'bypassPermissions',
                      },
                    } as never,
                  },
                  {
                    binding: b,
                    socketPath: sockPath,
                    keyring: kMap,
                    executionRoot: join(laneCwd, 'tools'),
                    renewLease: async () => {
                      throw new Error('NO')
                    },
                    hostFactory: hostFactory as never,
                    toolContextFactory: async () => ({
                      profile: {
                        cwd: laneCwd,
                        mcpConfigPath: null,
                        settingsPath: null,
                        disallowedTools: [],
                      },
                      env: process.env,
                      platformPrompt: '',
                      promptCwd: laneCwd,
                      cleanup: () => {},
                    }),
                  },
                )
                adapter.on('error', () => {})
                adapter.on('session_id', (id: string) => {
                  st.nativeSessionId = id.split(':').at(-1) ?? null
                })
                await adapter.start()
                st.adapter = adapter
                lanes.set(opts.laneId, st as never)
                return { laneCwd }
              },
              startTurn(opts) {
                if (failMidCase && opts.laneId === 'g1') {
                  throw new Error('INJECTED_MID_CASE_FAIL')
                }
                const l = lanes.get(opts.laneId)!
                if (opts.barrierMode) {
                  l.barrierMode = opts.barrierMode
                  l.barrier = makeBarrier()
                }
                if (opts.laneId === 'g4pre') {
                  let rej!: (e: Error) => void
                  const p = new Promise<never>((_, r) => {
                    rej = r
                  })
                  l.activeRun = { end: () => rej(new Error('INTERRUPTED')) } as never
                  return { waitSubmitted: async () => {}, waitDone: () => p }
                }
                const run = l.adapter.submitTurn({
                  input: opts.prompt,
                  requestId: opts.requestId,
                  turnKey: opts.turnKey,
                  modelAuthority: {
                    authorityEnvelope: opts.authority,
                    leaseEnvelope: opts.lease,
                    executionDescriptor: opts.executionDescriptor as never,
                  },
                  onEvent: () => {},
                  sessionTotals: { totalCostUSD: 0, turns: 0 },
                  toolUseIdToName: new Map(),
                })
                l.activeRun = run
                return {
                  waitSubmitted: () => run.submitted,
                  waitDone: async () => ({
                    summary: await run.summary,
                    nativeSessionId: l.nativeSessionId,
                    calls: [...l.calls],
                    files: readdirSync(l.laneCwd),
                    receipts: [],
                    requestId: opts.requestId,
                  }),
                }
              },
              async waitBarrierArrived(id) {
                await lanes.get(id)?.barrier?.arrived
              },
              async releaseBarrier(id, abort) {
                lanes.get(id)?.barrier?.release(abort)
              },
              async interruptLane(id) {
                const l = lanes.get(id)
                if (id === 'g4pre') l?.activeRun?.end()
                else l?.adapter?.interrupt('user')
              },
              async closeLane(id) {
                const l = lanes.get(id)!
                l.closed = true
                l.barrier?.release(true)
                await l.adapter.shutdown().catch(() => {})
                await new Promise<void>((r) => l.server.close(() => r()))
                return { calls: l.calls, nativeSessionId: l.nativeSessionId, proofs: [] }
              },
              async shutdown() {},
            }
          },
        },
      },
      probeHostFactory: () => ({
        probe: async () => ({
          snapshot: ccProbe,
          driverDigest: reg.driverDigest,
          coreDigest: reg.coreDigest,
          probeFingerprint: g5ProbeFp,
        }),
      }),
      recoveryFixtures: {
        proveLocal: async () => {},
        proveRemoteV4: async () => ({ remoteStopped: true }),
      },
      onJobSettled: (j) => settled(j as unknown as Record<string, unknown>),
    })
    return { svc, done }
  }

  await upsertVerificationPolicy(
    pool,
    {
      maxPaidTurnsPerRun: 50,
      maxCreditsPerRun: 100000,
      maxCreditsPerDay: 1000000,
      autoVerifyEnabled: false,
    },
    3,
  )
  const failRun = makeSvc(true)
  await failRun.svc.startCutover({ profileId: profId, driverId: 'cc' }, 3)
  const failJob = await failRun.done
  assert.equal(failJob.status, 'reverted', String(failJob.error ?? ''))
  assert.equal(failJob.reverted, true)
  assert.ok(failJob.verificationRunId)
  const failRunRow = (
    await pool.query('SELECT state FROM remote_driver_verification_runs WHERE id = $1', [
      failJob.verificationRunId,
    ])
  ).rows[0]!
  assert.equal(failRunRow.state, 'failed')
  const failBindings = (
    await pool.query<{ total: number; unreleased: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE state <> 'released')::int AS unreleased FROM remote_agent_bindings WHERE recovery_spec->>'verificationRunId' = $1`,
      [failJob.verificationRunId],
    )
  ).rows[0]!
  assert.ok(failBindings.total >= 1)
  assert.equal(failBindings.unreleased, 0)
  const afterFail = (
    await pool.query('SELECT driver_id, execution_ready FROM remote_agent_profiles WHERE id = $1', [
      profId,
    ])
  ).rows[0]!
  assert.equal(afterFail.driver_id, null)
  assert.equal(afterFail.execution_ready, false)

  const okRun = makeSvc(false)
  await okRun.svc.startCutover({ profileId: profId, driverId: 'cc' }, 3)
  const okJob = await okRun.done
  assert.equal(okJob.status, 'passed', String(okJob.error ?? ''))
  const afterOk = (
    await pool.query('SELECT driver_id, execution_ready FROM remote_agent_profiles WHERE id = $1', [
      profId,
    ])
  ).rows[0]!
  assert.equal(afterOk.driver_id, 'cc')
  assert.equal(afterOk.execution_ready, true)
  const runRow = (
    await pool.query(
      'SELECT state, evidence_digest FROM remote_driver_verification_runs WHERE id = $1',
      [okJob.verificationRunId],
    )
  ).rows[0]!
  assert.equal(runRow.state, 'passed')
  assert.equal(runRow.evidence_digest, okJob.evidenceDigest)
  assert.equal(lstatSync(String(okJob.evidenceUri)).mode & 0o077, 0)
  const unreleased = (
    await pool.query(
      `SELECT COUNT(*)::int AS c FROM remote_agent_bindings WHERE profile_id = $1 AND state <> 'released'`,
      [profId],
    )
  ).rows[0]!.c
  assert.equal(unreleased, 0)

  const ccStatus = await okRun.svc.getProfileStatus(profId)
  const ccProfile = ccStatus.profile as Record<string, unknown>
  assert.equal(ccProfile.verified_fingerprint, g5ProbeFp)
  assert.equal(ccProfile.target_fingerprint, g5ProbeFp)
  assert.ok(ccProfile.last_probe_ok_at)
  assert.ok(((ccStatus.eligibleOfferCounts as Record<string, number>)['claude-haiku-5-5-remote'] ?? 0) >= 1)
  assert.equal((ccStatus.latestVerificationRun as { state?: string } | null)?.state, 'passed')
})

test('Group 6: startRemoteDriverDriftScheduler runOnce & stop operate single-flight cleanly', async () => {
  const sandbox = makeTmp('/tmp/oc-drvtest-r12g6-')
  const cliPath = writeFakeCcCli(sandbox)
  const probe = makeCcProbe(cliPath, [
    {
      upstreamModelId: 'haiku',
      displayName: 'Haiku',
      supportedEfforts: ['low'],
      defaultEffort: 'low',
      supportsAdaptiveThinking: true,
      supportsVision: false,
    },
  ])
  const fx = await seedUserNode('g6')
  const reg = loadRemoteDriverRegistry().get('cc')!
  const g6PolicySha = remoteCanonicalSha256({
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    toolsFlag: '',
    strictMcp: true,
    settingSources: '',
    disableSlashCommands: true,
  })
  const fp = computeProbeFingerprintTs(probe, {
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: g6PolicySha,
  })
  const manifest = {
    driverId: 'cc',
    engineId: reg.engineId,
    driverVersion: reg.driverVersion,
    driverDigest: reg.driverDigest,
    coreDigest: reg.coreDigest,
    policySha256: g6PolicySha,
    latestFingerprint: fp,
    driverContext: { cliPath },
  }
  const schedProfId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, status, execution_ready, ready_generation, verified_fingerprint, execution_manifest, probe_snapshot)
       VALUES ($1, 'cc', 'cc', $2, 'sched-prof', 'acct-s', 'active', TRUE, 1, $3, $4::jsonb, $5::jsonb)
       RETURNING id::text AS id`,
      [fx.nodeId, reg.engineId, fp, JSON.stringify(manifest), JSON.stringify(probe)],
    )
  ).rows[0]!.id
  const beforeSched = (
    await pool.query<{ last_probe_ok_at: Date | null }>(
      'SELECT last_probe_ok_at FROM remote_agent_profiles WHERE id = $1',
      [schedProfId],
    )
  ).rows[0]!
  assert.equal(beforeSched.last_probe_ok_at, null)

  const schedulerLogErrors: string[] = []
  const baseLog = createLogger({ level: 'error', out: () => {} })
  const schedLog = {
    ...baseLog,
    warn(msg: string, meta?: Record<string, unknown>) {
      schedulerLogErrors.push(`warn:${msg}:${JSON.stringify(meta ?? {})}`)
    },
    error(msg: string, meta?: Record<string, unknown>) {
      schedulerLogErrors.push(`error:${msg}:${JSON.stringify(meta ?? {})}`)
    },
  }
  const paused = (
    await pool.query<{ id: string }>(
      `UPDATE remote_agent_profiles
          SET disabled_by = 'admin'
        WHERE id <> $1 AND driver_id IS NOT NULL AND disabled_by IS DISTINCT FROM 'admin'
       RETURNING id::text AS id`,
      [schedProfId],
    )
  ).rows.map((r) => r.id)
  try {
    const sched = startRemoteDriverDriftScheduler({
      pool,
      initialDelayMs: 600_000,
      skipCatalogSync: true,
      log: schedLog as never,
      probeHostFactory: () => ({
        probe: async () => ({
          snapshot: probe,
          driverDigest: reg.driverDigest,
          coreDigest: reg.coreDigest,
          probeFingerprint: fp,
        }),
      }),
    })
    await sched.runOnce()
    await sched.stop()
  } finally {
    if (paused.length > 0) {
      await pool.query(
        'UPDATE remote_agent_profiles SET disabled_by = NULL WHERE id = ANY($1::uuid[])',
        [paused],
      )
    }
  }
  assert.deepEqual(schedulerLogErrors, [])
  const afterSched = (
    await pool.query<{ last_probe_ok_at: Date | null }>(
      'SELECT last_probe_ok_at FROM remote_agent_profiles WHERE id = $1',
      [schedProfId],
    )
  ).rows[0]!
  assert.ok(afterSched.last_probe_ok_at instanceof Date)

  const pyOut = execFileSync(
    '/usr/bin/python3',
    ['-I', '-B', '-c', buildProveRunLocalStoppedPy(), randomUUID()],
    { encoding: 'utf8' },
  )
  assert.deepEqual(JSON.parse(pyOut), { ok: true, checked: 0 })
})


test('Group 7: getProfileStatus returns live codex columns and resolveLegacyCcControllerPath heals pruned release paths', async () => {
  const sandbox = makeTmp('/tmp/oc-drvtest-r12g7-')
  const fx = await seedUserNode('g7')
  const codexReg = loadRemoteDriverRegistry().get('codex')!
  const cliPath = writeFakeCcCli(sandbox)
  const { bridgeSha256: _dropBridge, ...codexBaseProbe } = makeCcProbe(cliPath, [
    {
      upstreamModelId: 'gpt-6-luna',
      displayName: 'GPT 6 Luna',
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportsAdaptiveThinking: true,
      supportsVision: true,
    },
  ])
  const codexProbe: RemoteProbeSnapshot = {
    ...codexBaseProbe,
    driverId: 'codex',
    engineId: codexReg.engineId,
    driverVersion: codexReg.driverVersion,
    nativeSha256: 'b'.repeat(64),
  }
  const policySha256 = '2'.repeat(64)
  const codexFp = computeProbeFingerprintTs(codexProbe, {
    driverDigest: codexReg.driverDigest,
    coreDigest: codexReg.coreDigest,
    policySha256,
  })
  const codexManifest = {
    driverId: 'codex',
    engineId: codexReg.engineId,
    driverVersion: codexReg.driverVersion,
    driverDigest: codexReg.driverDigest,
    coreDigest: codexReg.coreDigest,
    policySha256,
    latestFingerprint: codexFp,
  }
  const codexProfileId = (
    await pool.query<{ id: string }>(
      `INSERT INTO remote_agent_profiles
         (node_id, engine, driver_id, engine_id, profile_name, account_fingerprint, status,
          execution_ready, ready_generation, auth_epoch, verified_fingerprint,
          execution_manifest, probe_snapshot, last_probe_ok_at)
       VALUES ($1, 'codex', 'codex', $2, 'codex-r12-status', 'acct-codex-g7', 'active',
               TRUE, 1, 'ae-codex-g7', $3, $4::jsonb, $5::jsonb, NOW())
       RETURNING id::text AS id`,
      [
        fx.nodeId,
        codexReg.engineId,
        codexFp,
        JSON.stringify(codexManifest),
        JSON.stringify(codexProbe),
      ],
    )
  ).rows[0]!.id
  await pool.query(
    `INSERT INTO remote_model_offers (profile_id, canonical_model_id, upstream_model_id, base_display_name, enabled)
     VALUES ($1, 'gpt-6-luna-remote', 'gpt-6-luna', 'GPT 6 Luna Remote', TRUE)`,
    [codexProfileId],
  )
  await pool.query(
    `INSERT INTO remote_driver_verification_runs
       (id, profile_id, node_id, driver_id, engine_id, target_fingerprint, driver_digest, core_digest,
        suite_digest, ready_generation, auth_epoch, state, attempt_count, completed_at)
     VALUES ($1, $2, $3, 'codex', $4, $5, $6, $7, $8, 1, 'ae-codex-g7', 'passed', 1, NOW())`,
    [
      randomUUID(),
      codexProfileId,
      fx.nodeId,
      codexReg.engineId,
      codexFp,
      codexReg.driverDigest,
      codexReg.coreDigest,
      computeProductionConformanceSuiteDigest(),
    ],
  )

  const signer = AuthoritySigner.createEphemeral()
  const service = new RemoteDriverV4CommissioningService({
    executorDeps: {
      pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      catalog: {
        assertFresh: async () =>
          new ModelCatalogSnapshot({
            securityEpoch: 1n,
            entries: [],
            aliases: new Map(),
            pricing: new Map(),
          }),
      },
      keyring: () => signer.publicKeyring(),
      signer,
      loadUserModelAuthz: async () => ({
        role: 'admin',
        grantedModelIds: new Set(['gpt-6-luna-remote']),
      }),
      log: createLogger({ level: 'error', out: () => {} }),
      containerSource: async () => null,
    },
  })

  const status = await service.getProfileStatus(codexProfileId)
  const profile = status.profile as Record<string, unknown>
  assert.equal(profile.verified_fingerprint, codexFp)
  assert.equal(profile.target_fingerprint, codexFp)
  assert.ok(profile.last_probe_ok_at)
  assert.ok(((status.eligibleOfferCounts as Record<string, number>)['gpt-6-luna-remote'] ?? 0) >= 1)
  assert.equal((status.latestVerificationRun as { state?: string } | null)?.state, 'passed')

  const prunedPath =
    '/opt/openclaude/openclaude-v5-selfhost-releases/rel-pruned-123/scripts/agent-remote/cc5-host-controller.py'
  const resolvedPath = resolveLegacyCcControllerPath(prunedPath)
  assert.notEqual(resolvedPath, prunedPath)
  assert.ok(resolvedPath.endsWith('/scripts/agent-remote/cc5-host-controller.py'))
  assert.equal(existsSync(resolvedPath), true)
  assert.equal(resolveLegacyCcControllerPath('/tmp/nonexistent-other.py'), '/tmp/nonexistent-other.py')
})
