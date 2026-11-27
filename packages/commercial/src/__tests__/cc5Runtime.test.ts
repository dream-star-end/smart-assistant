import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { RemoteFinanceFactory } from '@openclaude/gateway/remote-finance'
import type { RemoteLaneRuntimePort, createRemoteLaneRuntime } from '@openclaude/gateway/cc5-container-runtime'
import {
  RemoteReleaseDrainCoordinator,
  startRemoteReleaseDrainSocketServer,
} from '../account-pool/remotePool/index.js'
import {
  createMasterCc5Runtime,
  probeMasterCc5RemoteRelayReadiness,
  readMigratedRemoteRelayState,
  selectMasterCc5Backend,
} from '../agent-sandbox/cc5Runtime.js'
import type {
  ExternalRemoteLaneRuntimePort,
  RemoteRelayHealthStatus,
} from '../agent-sandbox/remoteRelayClient.js'

const execFileAsync = promisify(execFile)

const env = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '912' }
const financeFactory: RemoteFinanceFactory = () => { throw new Error('must not create finance before a lane') }

test('master OFF/nonselfhost/missing authority/invalid UID/missing finance never creates the lane runtime', () => {
  let creates = 0
  for (const input of [
    { selfhost: true, authorityReady: true, env: {}, financeFactory },
    { selfhost: false, authorityReady: true, env, financeFactory },
    { selfhost: true, authorityReady: false, env, financeFactory },
    { selfhost: true, authorityReady: true, env },
    { selfhost: true, authorityReady: true, env: { ...env, OC_SELFHOST_CC5_T1555U_TEST_UID: 'all' }, financeFactory },
  ]) {
    assert.equal(createMasterCc5Runtime(input, { create: () => { creates++; throw new Error('never') } }), undefined)
  }
  assert.equal(creates, 0)
})

test('the master runtime places lanes through the pool scheduler under the fixed base root', () => {
  let seen: Parameters<typeof createRemoteLaneRuntime>[0] | undefined
  const runtime = {} as RemoteLaneRuntimePort
  assert.equal(createMasterCc5Runtime({ selfhost: true, authorityReady: true, env, financeFactory },
    { create: (input) => { seen = input; return runtime } }), runtime)
  const config = seen!.configuration()
  assert.equal(config.baseRoot, '/run/oc-cc5-t1555u')
  assert.ok(config.controllerPath.endsWith('/scripts/agent-remote/cc5-host-controller.py'))
  assert.equal(typeof seen!.hooks.place, 'function')
  assert.equal(seen!.financeFactory, financeFactory)
})

test('a failing runtime setup only disables remote lanes and reports once', () => {
  let rejected = 0
  assert.equal(createMasterCc5Runtime({ selfhost: true, authorityReady: true, env, financeFactory }, {
    create: () => { throw new Error('sensitive path must not escape') },
    rejected: () => { rejected++ },
  }), undefined)
  assert.equal(rejected, 1)
})

test('a remote-pool turn always gets its lane or fails; a local model never gets one', async () => {
  const calls: unknown[] = []
  const runtime = { async ensureLane(request: unknown) {
    calls.push(request)
    return { kind: 'cc5-interactive-v1' as const, sessionKey: 'agent:main:webchat:dm:new_chat_123',
      operationId: '00000000-0000-4000-8000-000000000001' }
  } } as unknown as RemoteLaneRuntimePort
  const input = { uid: 912, containerId: 91, sessionKey: 'agent:main:webchat:dm:new_chat_123',
    canonicalModel: 'claude-opus-5-5-remote', engine: 'ccb', placement: 'remote_pool' as const }
  assert.deepEqual(await selectMasterCc5Backend(runtime, input, true, env), {
    kind: 'cc5-interactive-v1', sessionKey: input.sessionKey, operationId: '00000000-0000-4000-8000-000000000001' })
  assert.deepEqual(calls, [{ uid: 912, containerDbId: '91', sessionKey: input.sessionKey,
    canonicalModel: 'claude-opus-5-5-remote' }])
  assert.equal(await selectMasterCc5Backend(runtime, { ...input, placement: 'local', canonicalModel: 'box-claude-opus-5-5' }, true, env), undefined)
  for (const [rt, patch, selfhost, policy] of [
    [undefined, {}, true, env],
    [runtime, {}, false, env],
    [runtime, { uid: 913 }, true, env],
    [runtime, {}, true, {}],
    [runtime, { engine: 'codex' }, true, env],
  ] as const) {
    await assert.rejects(selectMasterCc5Backend(rt, { ...input, ...patch }, selfhost, policy), /REMOTE_LANE_UNAVAILABLE/)
  }
  assert.equal(calls.length, 2) // mismatched Codex backend is refused after the selector returns.
})

test('Codex selector signs its own versioned backend, never CCB', async () => {
  const sessionKey='agent:main:webchat:dm:codex_chat_123'
  const backend={kind:'codex-app-server-v1' as const,version:1 as const,sessionKey,operationId:'00000000-0000-4000-8000-000000000001',generation:'2',profileId:'default',authEpoch:'1'}
  const runtime={async ensureLane(input:any){assert.equal(input.engine,'codex');return backend}} as RemoteLaneRuntimePort
  assert.deepEqual(await selectMasterCc5Backend(runtime,{uid:912,containerId:91,sessionKey,canonicalModel:'gpt-6-luna-remote',engine:'codex',placement:'remote_pool'},true,env),backend)
})

test('selectMasterCc5Backend accepts remote-driver-v4 backends for matching authorityEngine and rejects cross-engine mismatch', async () => {
  const ccbSession = 'agent:main:webchat:dm:v4_ccb_1'
  const ccbV4 = {
    kind: 'remote-driver-v4' as const,
    version: 4 as const,
    driverId: 'cc',
    driverVersion: '4.0.0',
    engineId: 'cc',
    authorityEngine: 'ccb' as const,
    sessionKey: ccbSession,
    operationId: '00000000-0000-4000-8000-000000000011',
    generation: '1',
    profileId: 'default',
    authEpoch: 'epoch-1',
  }
  const rtCcb = { async ensureLane() { return ccbV4 } } as unknown as RemoteLaneRuntimePort
  assert.deepEqual(
    await selectMasterCc5Backend(
      rtCcb,
      {
        uid: 912,
        containerId: 91,
        sessionKey: ccbSession,
        canonicalModel: 'claude-sonnet-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
      },
      true,
      env,
    ),
    ccbV4,
  )
  await assert.rejects(
    selectMasterCc5Backend(
      rtCcb,
      {
        uid: 912,
        containerId: 91,
        sessionKey: ccbSession,
        canonicalModel: 'gpt-6-luna-remote',
        engine: 'codex',
        placement: 'remote_pool',
      },
      true,
      env,
    ),
    /REMOTE_LANE_UNAVAILABLE/,
  )
})

test('createMasterCc5Runtime exposes AF_UNIX cutover drain socket driven by scripts/agent-remote/drain-remote-v4.sh', async () => {
  const sockDir = mkdtempSync('/tmp/oc-v4drain-u-')
  const sockPath = join(sockDir, 'drain.sock')
  const drainGate = new RemoteReleaseDrainCoordinator()
  let capturedPlace: ((req: any) => Promise<any>) | undefined
  let relayIdle = false
  drainGate.registerRelay('op-inflight', {
    get idle() {
      return relayIdle
    },
  })
  const fakePool = {
    query: async () => ({ rows: [{ cnt: '0' }] }),
  } as any

  let drainExec: Promise<{ stdout: string; stderr: string }> | undefined
  try {
    createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: { ...env, OC_REMOTE_V4_DRAIN_SOCKET: sockPath },
        financeFactory,
      },
      {
        drainGate,
        pool: () => fakePool,
        create: (cfg) => {
          capturedPlace = cfg.hooks.place
          return {} as RemoteLaneRuntimePort
        },
      },
    )
    const sockHandle = startRemoteReleaseDrainSocketServer(drainGate, {
      pool: () => fakePool,
      socketPath: sockPath,
    })
    const listenDeadline = Date.now() + 2_000
    while (!sockHandle.server.listening && Date.now() < listenDeadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    const drainScript = fileURLToPath(
      new URL('../../../../scripts/agent-remote/drain-remote-v4.sh', import.meta.url),
    )
    // 1. Short timeout fails closed while relay is non-idle without killing active relay!
    await assert.rejects(
      execFileAsync(drainScript, [
        '--drain',
        '--socket',
        sockPath,
        '--timeout-ms',
        '80',
        '--release-run-id',
        'rel-timeout-1',
      ]),
    )
    assert.equal(drainGate.isDraining, false)

    // 2. Start drain, verify new placement is rejected with REMOTE_POOL_DRAINING_RETRY_LATER, then mark idle!
    drainExec = execFileAsync(drainScript, [
      '--drain',
      '--socket',
      sockPath,
      '--timeout-ms',
      '5000',
      '--release-run-id',
      'rel-live-1',
    ])
    const drainStartDeadline = Date.now() + 2_500
    while (!drainGate.isDraining && Date.now() < drainStartDeadline) {
      await new Promise((r) => setTimeout(r, 15))
    }
    assert.equal(drainGate.isDraining, true)
    await assert.rejects(
      capturedPlace!({
        uid: 912,
        containerDbId: '91',
        dockerId: 'a'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:new_during_drain',
        canonicalModel: 'claude-sonnet-4-6-remote',
      }),
      /REMOTE_POOL_DRAINING_RETRY_LATER/,
    )
    relayIdle = true
    const { stdout } = await drainExec
    const parsed = JSON.parse(stdout.trim())
    assert.equal(parsed.drained, true)
    assert.equal(parsed.releaseRunId, 'rel-live-1')

    // 3. Reopen restores admission!
    await execFileAsync(drainScript, ['--reopen', '--socket', sockPath])
    assert.equal(drainGate.isDraining, false)
  } finally {
    relayIdle = true
    if (drainExec) {
      await drainExec.catch(() => {})
    }
    await startRemoteReleaseDrainSocketServer(drainGate, {
      pool: () => fakePool,
      socketPath: sockPath,
    }).close()
    rmSync(sockDir, { recursive: true, force: true })
  }
})

test('startRemoteReleaseDrainSocketServer degrades gracefully on AF_UNIX listen error without crashing process', async () => {
  const drainGate = new RemoteReleaseDrainCoordinator()
  const badPath = '/dev/null/impossible-drain.sock'
  const handle = startRemoteReleaseDrainSocketServer(drainGate, {
    pool: () => ({ query: async () => ({ rows: [{ cnt: '0' }] }) }) as any,
    socketPath: badPath,
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(handle.server.listening, false)
  await handle.close()
})

test('remote_v4_cutover_drain and cleanup_cutover_unit_snap cover rc=0/1/75, PG fallback, ALLOW_INFLIGHT, and pre-mutation reopen', async () => {
  const scriptsDir = fileURLToPath(new URL('../../../../scripts', import.meta.url))
  const releaseLib = fileURLToPath(
    new URL('../../../../scripts/v5-selfhost-master-release-lib.sh', import.meta.url),
  )
  const sockDir = mkdtempSync('/tmp/oc-v4drain-sh-')
  const sockPath = join(sockDir, 'drain.sock')
  const absentSock = join(sockDir, 'absent.sock')
  const drainGate = new RemoteReleaseDrainCoordinator()
  let relayIdle = false
  drainGate.registerRelay('op-cutover-sh', {
    get idle() {
      return relayIdle
    },
  })
  const fakePool = { query: async () => ({ rows: [{ cnt: '0' }] }) } as any
  const sockHandle = startRemoteReleaseDrainSocketServer(drainGate, {
    pool: () => fakePool,
    socketPath: sockPath,
  })
  const listenDeadline = Date.now() + 2_000
  while (!sockHandle.server.listening && Date.now() < listenDeadline) {
    await new Promise((r) => setTimeout(r, 10))
  }

  const runShell = async (body: string, extraEnv: Record<string, string> = {}) => {
    const wrapped = `
set -euo pipefail
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
PG_DB="test_db"
cutover_clog() { :; }
psql_as_postgres() {
  if [[ "$*" == *information_schema.columns* ]]; then echo "\${FAKE_PG_V4_SCHEMA:-true}";
  else echo "\${FAKE_PG_V4_ACTIVE:-0}"; fi
}
source ${JSON.stringify(releaseLib)}
${body}
`
    return execFileAsync('bash', ['-c', wrapped], {
      env: { ...process.env, ...extraEnv },
    })
  }

  try {
    // 1. ALLOW_INFLIGHT=1 skips drain without touching socket
    await runShell('remote_v4_cutover_drain', {
      OC_REMOTE_V4_DRAIN_SOCKET: sockPath,
      ALLOW_INFLIGHT: '1',
    })
    assert.equal(drainGate.isDraining, false)

    // 2. Absent socket (rc=75) + active_v4_bindings=0 -> proceeds (exit 0)
    await runShell('remote_v4_cutover_drain', {
      OC_REMOTE_V4_DRAIN_SOCKET: absentSock,
      FAKE_PG_V4_ACTIVE: '0',
    })

    // 3. Absent socket (rc=75) + active_v4_bindings=2 -> aborts cutover (exit 1)
    await assert.rejects(
      runShell('remote_v4_cutover_drain', {
        OC_REMOTE_V4_DRAIN_SOCKET: absentSock,
        FAKE_PG_V4_ACTIVE: '2',
      }),
    )

    // 4. Live socket timeout while relay busy (rc=1) -> aborts cutover and leaves gate open
    await assert.rejects(
      runShell('remote_v4_cutover_drain', {
        OC_REMOTE_V4_DRAIN_SOCKET: sockPath,
        OC_REMOTE_V4_DRAIN_TIMEOUT_MS: '80',
      }),
    )
    assert.equal(drainGate.isDraining, false)

    // 5. Live socket idle (rc=0) + pre-mutation abort (`CUTOVER_MUTATED=0`) -> `cleanup_cutover_unit_snap` reopens gate!
    relayIdle = true
    await runShell(
      `
remote_v4_cutover_drain
[[ "$REMOTE_V4_CUTOVER_DRAINED" == "1" ]]
CUTOVER_MUTATED=0
cleanup_cutover_unit_snap
[[ "$REMOTE_V4_CUTOVER_DRAINED" == "0" ]]
`,
      {
        OC_REMOTE_V4_DRAIN_SOCKET: sockPath,
        OC_REMOTE_V4_DRAIN_TIMEOUT_MS: '3000',
      },
    )
    assert.equal(drainGate.isDraining, false)

    // 6. Live socket idle (rc=0) + post-mutation (`CUTOVER_MUTATED=1`) -> `cleanup_cutover_unit_snap` keeps gate closed for restart!
    await runShell(
      `
remote_v4_cutover_drain
CUTOVER_MUTATED=1
cleanup_cutover_unit_snap
`,
      {
        OC_REMOTE_V4_DRAIN_SOCKET: sockPath,
        OC_REMOTE_V4_DRAIN_TIMEOUT_MS: '3000',
      },
    )
    assert.equal(drainGate.isDraining, true)
    drainGate.reopen()
  } finally {
    await sockHandle.close()
    rmSync(sockDir, { recursive: true, force: true })
  }
})

test('createMasterCc5Runtime external mode uses external client without financeFactory or in-process drain socket', () => {
  const sockDir = mkdtempSync('/tmp/oc-v4ext-nodrain-')
  const drainSockPath = join(sockDir, 'should-not-exist.sock')
  try {
    let seenOpts: { socketPath: string; secret: string } | undefined
    let inProcessCreates = 0
    const fakeExternal = {
      remoteRelayMode: 'external' as const,
      socketPath: '/tmp/custom-relay.sock',
      probeHealth: async () => null,
    } as unknown as ExternalRemoteLaneRuntimePort

    const rt = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'external',
          OC_REMOTE_RELAY_SOCKET: '/tmp/custom-relay.sock',
          OC_REMOTE_V4_DRAIN_SOCKET: drainSockPath,
        },
        egressSecret: 'external-secret-1',
      },
      {
        create: () => {
          inProcessCreates++
          throw new Error('must not create in-process runtime in external mode')
        },
        createExternalClient: (opts) => {
          seenOpts = opts
          return fakeExternal
        },
      },
    )

    assert.equal(rt, fakeExternal)
    assert.deepEqual(seenOpts, {
      socketPath: '/tmp/custom-relay.sock',
      secret: 'external-secret-1',
    })
    assert.equal(inProcessCreates, 0)
    assert.equal(existsSync(drainSockPath), false)
  } finally {
    rmSync(sockDir, { recursive: true, force: true })
  }
})

test('createMasterCc5Runtime external mode fails closed without secret and never falls back to in-process', () => {
  let inProcessCreates = 0
  let externalCreates = 0
  let rejected = 0

  const rt = createMasterCc5Runtime(
    {
      selfhost: true,
      authorityReady: true,
      env: { ...env, OC_REMOTE_RELAY_MODE: 'external' },
      financeFactory,
    },
    {
      create: () => {
        inProcessCreates++
        throw new Error('must not fall back to in-process')
      },
      createExternalClient: () => {
        externalCreates++
        throw new Error('must not construct client without secret')
      },
      rejected: () => {
        rejected++
      },
    },
  )

  assert.equal(rt, undefined)
  assert.equal(rejected, 1)
  assert.equal(inProcessCreates, 0)
  assert.equal(externalCreates, 0)

  // selfhost/authority gate still applies in external mode
  for (const gated of [
    { selfhost: false, authorityReady: true, env: { ...env, OC_REMOTE_RELAY_MODE: 'external' }, egressSecret: 's' },
    { selfhost: true, authorityReady: false, env: { ...env, OC_REMOTE_RELAY_MODE: 'external' }, egressSecret: 's' },
  ]) {
    assert.equal(
      createMasterCc5Runtime(gated, {
        createExternalClient: () => {
          externalCreates++
          throw new Error('must not create when gated off')
        },
      }),
      undefined,
    )
  }
  assert.equal(externalCreates, 0)
})

test('createMasterCc5Runtime auto mode selects external when available and falls back to in-process otherwise', () => {
  const sockDir = mkdtempSync('/tmp/oc-v4auto-mode-')
  const absentRelaySock = join(sockDir, 'absent-relay.sock')
  const absentStateFile = join(sockDir, 'absent-state.json')
  const drainSockPath = join(sockDir, 'no-drain-in-auto-ext.sock')
  try {
    const fakeExternal = {
      remoteRelayMode: 'external' as const,
      socketPath: '/run/openclaude-v5-selfhost/remote-relay-active.sock',
      probeHealth: async () => null,
    } as unknown as ExternalRemoteLaneRuntimePort
    const fakeInProcess = {} as RemoteLaneRuntimePort

    // 1. auto + secret + external client available -> external (no financeFactory needed, no drain socket)
    let inProcessCalls = 0
    let externalCalls = 0
    const extRt = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'auto',
          OC_REMOTE_RELAY_STATE_FILE: absentStateFile,
          OC_EGRESS_SECRET: 'auto-secret',
          OC_REMOTE_V4_DRAIN_SOCKET: drainSockPath,
        },
      },
      {
        create: () => {
          inProcessCalls++
          return fakeInProcess
        },
        createExternalClient: () => {
          externalCalls++
          return fakeExternal
        },
      },
    )
    assert.equal(extRt, fakeExternal)
    assert.equal(externalCalls, 1)
    assert.equal(inProcessCalls, 0)
    assert.equal(existsSync(drainSockPath), false)

    // 2. auto + secret + absent socket & absent state file (unmigrated legacy host) -> falls back to in-process
    const fallbackNoSock = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'auto',
          OC_REMOTE_RELAY_SOCKET: absentRelaySock,
          OC_REMOTE_RELAY_STATE_FILE: absentStateFile,
          OC_EGRESS_SECRET: 'auto-secret',
          OC_REMOTE_V4_DRAIN_SOCKET: 'none',
        },
        financeFactory,
      },
      {
        create: () => {
          inProcessCalls++
          return fakeInProcess
        },
      },
    )
    assert.equal(fallbackNoSock, fakeInProcess)
    assert.equal(inProcessCalls, 1)

    // 3. auto + missing secret + absent state file -> falls back to in-process
    const fallbackNoSecret = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'auto',
          OC_REMOTE_RELAY_SOCKET: absentRelaySock,
          OC_REMOTE_RELAY_STATE_FILE: absentStateFile,
          OC_REMOTE_V4_DRAIN_SOCKET: 'none',
        },
        financeFactory,
      },
      {
        create: () => {
          inProcessCalls++
          return fakeInProcess
        },
        createExternalClient: () => {
          externalCalls++
          return fakeExternal
        },
      },
    )
    assert.equal(fallbackNoSecret, fakeInProcess)
    assert.equal(inProcessCalls, 2)
    assert.equal(externalCalls, 1)

    // 4. explicit inprocess mode ignores external client even with secret
    const explicitInProcess = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'inprocess',
          OC_REMOTE_RELAY_STATE_FILE: absentStateFile,
          OC_REMOTE_V4_DRAIN_SOCKET: 'none',
        },
        egressSecret: 'secret-ignored-inprocess',
        financeFactory,
      },
      {
        create: () => {
          inProcessCalls++
          return fakeInProcess
        },
        createExternalClient: () => {
          externalCalls++
          return fakeExternal
        },
      },
    )
    assert.equal(explicitInProcess, fakeInProcess)
    assert.equal(inProcessCalls, 3)
    assert.equal(externalCalls, 1)
  } finally {
    rmSync(sockDir, { recursive: true, force: true })
  }
})

test('B10: auto mode never falls back to in-process when remote-relay-state.json exists (valid or corrupted)', () => {
  const dir = mkdtempSync('/tmp/oc-v4auto-b10-')
  const absentSock = join(dir, 'cold-boot-missing-active.sock')
  const drainSock = join(dir, 'must-not-spawn-drain.sock')
  const validState = join(dir, 'valid-state.json')
  const slotOnlyState = join(dir, 'slot-only-state.json')
  const corruptState = join(dir, 'corrupt-state.json')
  const absentState = join(dir, 'does-not-exist.json')

  try {
    writeFileSync(validState, JSON.stringify({ migrated: true, activeSlot: 'A' }), 'utf8')
    writeFileSync(slotOnlyState, JSON.stringify({ activeSlot: 'B' }), 'utf8')
    writeFileSync(corruptState, '{not-valid-json', 'utf8')

    assert.deepEqual(readMigratedRemoteRelayState(absentState), {
      migrated: false,
      corrupted: false,
    })
    assert.deepEqual(readMigratedRemoteRelayState(validState), {
      migrated: true,
      corrupted: false,
      activeSlot: 'A',
    })
    assert.deepEqual(readMigratedRemoteRelayState(slotOnlyState), {
      migrated: true,
      corrupted: false,
      activeSlot: 'B',
    })
    assert.deepEqual(readMigratedRemoteRelayState(corruptState), {
      migrated: true,
      corrupted: true,
    })

    // 1. Valid migrated state + absent socket + secret -> returns real external client (no in-process fallback, no drain socket)
    let inProcessCalls = 0
    const rtValid = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'auto',
          OC_REMOTE_RELAY_SOCKET: absentSock,
          OC_REMOTE_RELAY_STATE_FILE: validState,
          OC_REMOTE_V4_DRAIN_SOCKET: drainSock,
        },
        egressSecret: 'b10-secret',
        financeFactory,
      },
      {
        create: () => {
          inProcessCalls++
          throw new Error('B10 violation: must never fall back to in-process')
        },
      },
    )
    assert.ok(rtValid)
    assert.equal((rtValid as ExternalRemoteLaneRuntimePort).remoteRelayMode, 'external')
    assert.equal((rtValid as ExternalRemoteLaneRuntimePort).socketPath, absentSock)
    assert.equal(inProcessCalls, 0)
    assert.equal(existsSync(drainSock), false)

    // 2. Corrupted state file + absent socket + secret -> STILL fail-closed to external client (never dual-brain in-process!)
    const rtCorrupt = createMasterCc5Runtime(
      {
        selfhost: true,
        authorityReady: true,
        env: {
          ...env,
          OC_REMOTE_RELAY_MODE: 'auto',
          OC_REMOTE_RELAY_SOCKET: absentSock,
          OC_REMOTE_RELAY_STATE_FILE: corruptState,
          OC_REMOTE_V4_DRAIN_SOCKET: drainSock,
        },
        egressSecret: 'b10-secret',
        financeFactory,
      },
      {
        create: () => {
          inProcessCalls++
          throw new Error('B10 violation: corrupted state must never fall back to in-process')
        },
      },
    )
    assert.ok(rtCorrupt)
    assert.equal((rtCorrupt as ExternalRemoteLaneRuntimePort).remoteRelayMode, 'external')
    assert.equal(inProcessCalls, 0)
    assert.equal(existsSync(drainSock), false)

    // 3. Valid or corrupted state + absent socket + MISSING secret -> fail-closed undefined + rejected(), never in-process!
    let rejectedCount = 0
    for (const sf of [validState, corruptState]) {
      const rtNoSecret = createMasterCc5Runtime(
        {
          selfhost: true,
          authorityReady: true,
          env: {
            ...env,
            OC_REMOTE_RELAY_MODE: 'auto',
            OC_REMOTE_RELAY_SOCKET: absentSock,
            OC_REMOTE_RELAY_STATE_FILE: sf,
            OC_REMOTE_V4_DRAIN_SOCKET: drainSock,
          },
          financeFactory,
        },
        {
          create: () => {
            inProcessCalls++
            throw new Error('B10 violation: missing secret on migrated host must fail closed')
          },
          rejected: () => {
            rejectedCount++
          },
        },
      )
      assert.equal(rtNoSecret, undefined)
    }
    assert.equal(rejectedCount, 2)
    assert.equal(inProcessCalls, 0)
    assert.equal(existsSync(drainSock), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeMasterCc5RemoteRelayReadiness handles in-process, healthy external, disabled, error, draining, and errors fail-closed', async () => {
  assert.deepEqual(await probeMasterCc5RemoteRelayReadiness(undefined), {
    external: false,
    healthy: false,
    disabled: false,
    slot: null,
    instanceId: null,
    activeCount: 0,
  })
  assert.deepEqual(await probeMasterCc5RemoteRelayReadiness({} as RemoteLaneRuntimePort), {
    external: false,
    healthy: false,
    disabled: false,
    slot: null,
    instanceId: null,
    activeCount: 0,
  })

  type HealthWithRuntimeState = RemoteRelayHealthStatus & {
    readonly runtimeState?: 'ready' | 'disabled' | 'error'
  }
  const makeExt = (
    probeHealth: (timeoutMs?: number) => Promise<HealthWithRuntimeState | null>,
  ): ExternalRemoteLaneRuntimePort =>
    ({
      remoteRelayMode: 'external' as const,
      socketPath: '/run/openclaude-v5-selfhost/remote-relay-active.sock',
      probeHealth,
    }) as unknown as ExternalRemoteLaneRuntimePort

  assert.deepEqual(
    await probeMasterCc5RemoteRelayReadiness(
      makeExt(async () => ({
        ok: true,
        role: 'remote-relay',
        slot: 'B',
        instanceId: 'rr-b-42',
        pid: 12345,
        accepting: true,
        draining: false,
        activeRelayCount: 3,
        registeredRelayCount: 4,
        unsettledJournals: 0,
        remoteRuntimeReady: true,
        runtimeState: 'ready',
      })),
    ),
    {
      external: true,
      healthy: true,
      disabled: false,
      slot: 'B',
      instanceId: 'rr-b-42',
      activeCount: 3,
    },
  )

  // B6: intentionally disabled remote-relay must report healthy=false, disabled=true
  assert.deepEqual(
    await probeMasterCc5RemoteRelayReadiness(
      makeExt(async () => ({
        ok: true,
        role: 'remote-relay',
        slot: 'A',
        instanceId: 'rr-a-disabled',
        pid: 12345,
        accepting: false,
        draining: false,
        activeRelayCount: 0,
        registeredRelayCount: 0,
        unsettledJournals: 0,
        remoteRuntimeReady: false,
        runtimeState: 'disabled',
      })),
    ),
    {
      external: true,
      healthy: false,
      disabled: true,
      slot: 'A',
      instanceId: 'rr-a-disabled',
      activeCount: 0,
    },
  )

  // B6: runtimeState='error' fails closed even if flags look ready
  assert.deepEqual(
    await probeMasterCc5RemoteRelayReadiness(
      makeExt(async () => ({
        ok: true,
        role: 'remote-relay',
        slot: 'A',
        instanceId: 'rr-a-err',
        pid: 12345,
        accepting: true,
        draining: false,
        activeRelayCount: 0,
        registeredRelayCount: 0,
        unsettledJournals: 0,
        remoteRuntimeReady: true,
        runtimeState: 'error',
      })),
    ),
    {
      external: true,
      healthy: false,
      disabled: false,
      slot: 'A',
      instanceId: 'rr-a-err',
      activeCount: 0,
    },
  )

  assert.deepEqual(
    await probeMasterCc5RemoteRelayReadiness(
      makeExt(async () => ({
        ok: true,
        role: 'remote-relay',
        slot: 'A',
        instanceId: 'rr-a-9',
        pid: 12345,
        accepting: false,
        draining: true,
        activeRelayCount: 1,
        registeredRelayCount: 1,
        unsettledJournals: 0,
        remoteRuntimeReady: true,
        runtimeState: 'ready',
      })),
    ),
    {
      external: true,
      healthy: false,
      disabled: false,
      slot: 'A',
      instanceId: 'rr-a-9',
      activeCount: 1,
    },
  )

  assert.deepEqual(await probeMasterCc5RemoteRelayReadiness(makeExt(async () => null)), {
    external: true,
    healthy: false,
    disabled: false,
    slot: null,
    instanceId: null,
    activeCount: 0,
  })

  assert.deepEqual(
    await probeMasterCc5RemoteRelayReadiness(
      makeExt(async () => {
        throw new Error('connect ECONNREFUSED')
      }),
    ),
    {
      external: true,
      healthy: false,
      disabled: false,
      slot: null,
      instanceId: null,
      activeCount: 0,
    },
  )
})
