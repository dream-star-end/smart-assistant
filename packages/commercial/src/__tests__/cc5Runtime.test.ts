import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { createMasterCc5Runtime, selectMasterCc5Backend } from '../agent-sandbox/cc5Runtime.js'

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
psql_as_postgres() { echo "\${FAKE_PG_V4_ACTIVE:-0}"; }
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
