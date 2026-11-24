/**
 * End-to-end regression proof for `OCV5-780` / `INC-20261117-REMOTE-V4-DRAIN-CC-AUTH`:
 *
 * 1. Replays the verbatim `cc5-att-us` (`1e03c7fa`) Claude Code `<synthetic>` `is_api_error_message`
 *    (`verification_required` / Anthropic Verification Portal) wire sequence through real
 *    `scripts/agent-remote/drivers/cc.py` -> `DriverWorkerClient` -> `RemotePoolRelay` ->
 *    `RemoteContainerLane` -> `RemoteEngineAdapter` -> `SessionManager.submit` -> `makeV3MasterSink`:
 *    - Preserves actionable error detail instead of swallowing `<synthetic>` API error text,
 *    - Classifies as non-recoverable `AUTH_ERROR` / `auth_error` (`supportsAutomaticTurnRecovery === false`),
 *    - Clears the per-turn lease expiry timer and resets `localStopped = true` in `settleTerminal()` so
 *      waiting past the turn lease TTL never self-fences (`REMOTE_LEASE_EXPIRED`) or blocks cutover drain,
 *    - Ignores in-flight `/renew` arriving after settlement without fencing or re-arming `expiry`,
 *    - Completes `stop()` immediately (`remoteStopped: true`) if a settled warm lane later fences while idle.
 * 2. Proves `/abandon` resets `localStopped = true` and late `/tool/stopped` re-drives `stop()` to completion.
 * 3. Proves duplicate `result` frames with identical `uuid` replay deterministically in `cc.py` without
 *    `REMOTE_TERMINAL_CONFLICT`.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  parseRemoteDriverExecutionBackend,
  remoteCanonicalSha256,
  supportsAutomaticTurnRecovery,
  turnLeaseSigningInput,
  verifyAuthority,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'

const testHome = mkdtempSync(join(tmpdir(), 'oc-rpool-780-home-'))
process.env.OPENCLAUDE_HOME = testHome
process.env.OC_USER_ID = '3'
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')

const {
  closeSessionsDb,
  getTurnDispatchByDispatchId,
  insertQueuedTurnDispatch,
} = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { registerRemoteDriverAdapter } = await import('../engine/registry.js')
const {
  __resetIntelligentUiDesiredCacheForTests,
  __setIntelligentUiDesiredFetchForTests,
} = await import('../intelligentUiDesired.js')
const { makeV3MasterRetryQueue } = await import('../v3MasterRetryQueue.js')
const {
  makeV3MasterSink,
  setV3MasterSinkSingleton,
} = await import('../v3MasterSink.js')
import type { V3MasterSinkWirePayload } from '../v3MasterSink.js'
const {
  inboxSinkStageFailedByDispatch,
  inboxSinkStagedByDispatch,
  resolveInboxTerminalAck,
} = await import('../turnDispatchInbox.js')
const {
  DriverWorkerClient,
  RemoteEngineAdapter,
  RemotePoolRelay,
  RemotePoolSshHost,
  remotePoolBackendOf,
  remotePoolControlRequest,
} = await import('../remotePool/index.js')
await import('../remotePool/registerRemoteDriver.js')

import type {
  LaneToolHost,
  RemoteContainerLaneOptions,
  RemotePoolBinding,
  RemotePoolFinancePort,
  RemotePoolLaneSpec,
} from '../remotePool/index.js'

const CONTROLLER_PATH = fileURLToPath(
  new URL('../../../../scripts/agent-remote/core/controller.py', import.meta.url),
)
const CONTROLLER_SHA256 = createHash('sha256').update(readFileSync(CONTROLLER_PATH)).digest('hex')

const VERIFICATION_PORTAL_TEXT =
  "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://portal.anthropic.com/verify?org=6d4224c6-68b1-48ee-964d-0268130d4f10"

const laneOverridesByOpId = new Map<string, RemoteContainerLaneOptions>()
registerRemoteDriverAdapter((opts) => {
  const backend = parseRemoteDriverExecutionBackend(opts.executionBackend)
  return new RemoteEngineAdapter(opts, laneOverridesByOpId.get(backend.operationId) ?? {})
})

beforeEach(() => {
  __resetIntelligentUiDesiredCacheForTests()
  __setIntelligentUiDesiredFetchForTests(async () => false)
})

after(async () => {
  laneOverridesByOpId.clear()
  registerRemoteDriverAdapter((opts) => new RemoteEngineAdapter(opts))
  __resetIntelligentUiDesiredCacheForTests()
  setV3MasterSinkSingleton(null)
  await closeSessionsDb()
  rmSync(testHome, { recursive: true, force: true })
})

function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function makeSyntheticErrorCcFixture(dir: string, options: { duplicateResult?: boolean; exitSignalFile?: string } = {}): string {
  const exitFile = options.exitSignalFile ?? ''
  return writeExecutable(
    join(dir, 'fake-claude-synthetic-err'),
    `#!/usr/bin/env python3
import json, os, pathlib, re, sys, time

args = sys.argv[1:]
if "-p" in args:
    for raw in sys.stdin:
        msg = json.loads(raw)
        if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
            out = {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": msg["request_id"],
                    "response": {
                        "claude_code_version": "2.1.316",
                        "account": {"email": "alice@example.com", "subscriptionType": "max"},
                        "models": [{
                            "value": "claude-opus-4-6",
                            "displayName": "Opus 4.6",
                            "supportedEffortLevels": ["low", "medium", "high"],
                            "supportsAdaptiveThinking": True,
                        }],
                    },
                },
            }
            sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            sys.exit(0)
    sys.exit(1)

def arg_val(flag, default=""):
    return args[args.index(flag) + 1] if flag in args else default

model = arg_val("--model", "claude-opus-4-6")
session_id = arg_val("--session-id") or arg_val("--resume")
home_dir = pathlib.Path(os.environ.get("HOME", "/tmp"))
sanitized_cwd = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
transcript_path = home_dir / ".claude/projects" / sanitized_cwd / f"{session_id}.jsonl"
if "--session-id" in args:
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.write_text(json.dumps({"sessionId": session_id}) + "\\n", encoding="utf-8")

sys.stdout.write(json.dumps({
    "type": "system",
    "subtype": "init",
    "session_id": session_id,
    "model": model,
    "tools": ["mcp__ocbridge__NoopTool"],
}, separators=(",", ":")) + "\\n")
sys.stdout.flush()

turn_seq = 0
for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    if msg.get("type") != "user":
        continue
    turn_seq += 1
    res_uuid = f"ocb-1e03c7fa-mwk0k3pu-{turn_seq}"
    frames = [
        {
            "type": "stream_event",
            "event": {
                "type": "message_start",
                "message": {
                    "id": f"msg_ocb_{turn_seq}",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
                },
            },
            "session_id": session_id,
        },
        {
            "type": "assistant",
            "message": {
                "id": f"msg_ocb_{turn_seq}",
                "type": "message",
                "role": "assistant",
                "model": "<synthetic>",
                "content": [{"type": "text", "text": ${JSON.stringify(VERIFICATION_PORTAL_TEXT)}}],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            },
            "parent_tool_use_id": None,
            "session_id": session_id,
            "uuid": f"18ccc264-484c-4756-8cf3-eb2c4e7a0c0{turn_seq}",
            "is_api_error_message": True,
        },
        {
            "type": "stream_event",
            "event": {
                "type": "message_delta",
                "delta": {"stop_reason": None, "stop_sequence": None},
                "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            },
            "session_id": session_id,
        },
        {
            "type": "stream_event",
            "event": {"type": "message_stop"},
            "session_id": session_id,
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "allowed", "rateLimitType": "five_hour", "utilization": 0.03},
            "session_id": session_id,
        },
        {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "duration_ms": 267,
            "duration_api_ms": 0,
            "num_turns": 1,
            "result": "",
            "stop_reason": None,
            "session_id": session_id,
            "total_cost_usd": 0,
            "usage": {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
            "permission_denials": [],
            "errors": ["turn ended on an API error"],
            "uuid": res_uuid,
        },
    ]
    if ${options.duplicateResult ? 'True' : 'False'}:
        frames.append(dict(frames[-1]))
    for f in frames:
        sys.stdout.write(json.dumps(f, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
    if ${JSON.stringify(exitFile)}:
        exit_marker = pathlib.Path(${JSON.stringify(exitFile)})
        while not exit_marker.exists():
            time.sleep(0.02)
        sys.exit(1)
`,
  )
}

function makeSignedTickets(params: {
  kp: ReturnType<typeof generateKeyPairSync>
  keyId: string
  binding: RemotePoolBinding
  canonicalModel: string
  authorityTurnId: string
  issuedAt: number
  leaseTtlMs: number
}) {
  const payload: ModelAuthorityPayload = {
    v: 1,
    keyId: params.keyId,
    uid: 3,
    containerId: 7,
    authorityTurnId: params.authorityTurnId,
    connectionChallenge: 'challenge-780',
    canonicalModel: params.canonicalModel,
    engine: 'ccb',
    executionBackend: remotePoolBackendOf(params.binding),
    securityEpoch: 1,
    executionRevision: 'rev-1',
    issuedAt: params.issuedAt,
    expiresAt: params.issuedAt + 120_000,
    executionDescriptor: {
      capabilityProfile: {
        ccb: { capabilityZero: true, supportsThinking: true, contextOwner: 'box-native-v1' },
      },
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
      supportsVision: true,
      supportedEfforts: ['low', 'medium', 'high'],
    },
  }
  const leasePayload: TurnLease = {
    v: 1,
    keyId: params.keyId,
    uid: 3,
    containerId: 7,
    authorityTurnId: params.authorityTurnId,
    connectionChallenge: 'challenge-780',
    canonicalModel: params.canonicalModel,
    securityEpoch: 1,
    issuedAt: params.issuedAt,
    expiresAt: params.issuedAt + params.leaseTtlMs,
  }
  const authorityEnvelope = encodeAuthorityEnvelope(
    payload,
    sign(null, authoritySigningInput(payload), params.kp.privateKey),
  )
  const leaseEnvelope = encodeTurnLeaseEnvelope(
    leasePayload,
    sign(null, turnLeaseSigningInput(leasePayload), params.kp.privateKey),
  )
  return { payload, leasePayload, authorityEnvelope, leaseEnvelope }
}

test(
  'synthetic CC verification_required API error classifies as non-recoverable AUTH_ERROR and settled turn clears lease timer + localStopped for clean cutover drain (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
  async () => {
    const sandbox = mkdtempSync('/tmp/oc-drvtest-780-e2e-')
    const resRoot = join(sandbox, 'resources')
    const fakeSys = join(sandbox, 'fake-systemd')
    const containerExecRoot = join(sandbox, 'container-exec')
    const workspaceDir = join(sandbox, 'workspace')
    const exitSignalFile = join(sandbox, 'trigger-idle-exit')
    mkdirSync(containerExecRoot, { recursive: true, mode: 0o700 })
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })

    const cliPath = makeSyntheticErrorCcFixture(sandbox, { duplicateResult: true, exitSignalFile })
    const envExtra: Record<string, string> = {
      OC_REMOTE_RESOURCE_ROOT: resRoot,
      OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
      OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
      OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
    }

    const worker = new DriverWorkerClient()
    const workerInfo = await worker.info('cc')

    const operationId = randomUUID()
    const runId = randomUUID()
    const peerId = `web780${operationId.replace(/-/g, '').slice(0, 10)}`
    const sessionKey = `agent:main:webchat:dm:${peerId}`
    const profileId = 'ebc80fa6-0348-49a3-b1c1-8a08017114d6'
    const upstreamModel = 'claude-opus-4-6'
    const canonicalModel = 'claude-opus-5-5-remote'
    const laneRoot = join(sandbox, `run-lane-${operationId}`)
    const probeRoot = join(sandbox, `run-probe-${operationId}`)
    const journalDir = join(sandbox, 'journal')

    const probeCtx = { cliPath, accountHome: sandbox }
    const driverCtx = {
      cliPath,
      accountHome: sandbox,
      bridgeMode: 'stdio-fixture',
      initialSessionUuid: '1e03c7fa-494b-575a-aee7-1bd63071ce59',
    }

    const bootstrapSpec: RemotePoolLaneSpec = {
      controllerPath: CONTROLLER_PATH,
      controllerSha256: CONTROLLER_SHA256,
      manifest: {
        version: 4,
        root: laneRoot,
        driverId: 'cc',
        engineId: 'cc',
        operationId,
        runId,
        generation: '1',
        profileId,
        authEpoch: 'epoch-1',
        model: upstreamModel,
        driverDigest: workerInfo.driverDigest,
        coreDigest: workerInfo.coreDigest,
      },
      driverContext: driverCtx,
      verifiedProbe: {
        schemaVersion: 4,
        engineId: 'cc',
        driverId: 'cc',
        driverVersion: workerInfo.driverVersion,
        source: 'bootstrap:init',
        freshness: 'cli-observed',
        authPresent: true,
        accountObserved: true,
        cliVersion: '2.1.316',
        cliSha256: 'a'.repeat(64),
        models: [
          {
            upstreamModelId: upstreamModel,
            displayName: 'Opus 4.6',
            supportedEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            supportsAdaptiveThinking: true,
            supportsVision: true,
          },
        ],
        rawResponseSha256: 'b'.repeat(64),
        observedAt: '2026-11-17T00:00:00Z',
      },
    }

    const probed = await RemotePoolSshHost.forLocalSandbox(bootstrapSpec, envExtra).probe(probeCtx, probeRoot)
    const spec: RemotePoolLaneSpec = { ...bootstrapSpec, verifiedProbe: probed.snapshot }
    const host = RemotePoolSshHost.forLocalSandbox(spec, envExtra)

    const binding: RemotePoolBinding = {
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId,
      runId,
      uid: '3',
      containerDbId: '7',
      dockerId: 'd'.repeat(64),
      sessionKey,
      canonicalModel,
      upstreamModel,
      driverId: 'cc',
      engineId: 'cc',
      authorityEngine: 'ccb',
      driverVersion: workerInfo.driverVersion,
      driverDigest: workerInfo.driverDigest,
      coreDigest: workerInfo.coreDigest,
      probeFingerprint: probed.probeFingerprint,
      manifestSha256: remoteCanonicalSha256(spec.manifest),
      generation: '1',
      profileId,
      authEpoch: 'epoch-1',
      capability: 'c'.repeat(64),
      expiresAt: Date.now() + 600_000,
    }

    const kp = generateKeyPairSync('ed25519')
    const keyId = 'v4-780-key'
    const keys: AuthorityKeyring = new Map([
      [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
    ])

    const settledReceipts: RemoteReceiptV4[] = []
    const finance: RemotePoolFinancePort = {
      admit: async (input) => {
        const a = verifyAuthority(input.authorityEnvelope, keys, Date.now())
        const requestId = a.billingRequestId ?? `req-${a.authorityTurnId}`
        return {
          requestId,
          beforeHostStart: async () => {},
          beforeDispatch: async () => {},
          bindNativeThread: async () => null,
          abandonUndispatched: async () => ({ state: 'proven', requestId, disposition: 'waived_zero' }),
          terminal: async (receipt) => {
            settledReceipts.push(receipt)
            return { state: 'proven', requestId: receipt.requestId, disposition: 'settled' }
          },
          stop: async () => {},
        }
      },
    }

    const relay = new RemotePoolRelay({
      binding,
      keys,
      host,
      spec,
      journalDir,
      finance,
      worker,
      observationOptions: { authorizeTimeoutMs: 3_000 },
    })

    const socketPath = join(sandbox, 'relay.sock')
    relay.controlServer.listen(socketPath)
    await once(relay.controlServer, 'listening')

    const hostFactory = (): LaneToolHost => ({
      tools: async () => [
        {
          name: 'NoopTool',
          description: 'No-op fixture tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      close: async () => {},
    })

    laneOverridesByOpId.set(operationId, {
      binding,
      socketPath,
      keyring: keys,
      executionRoot: containerExecRoot,
      hostFactory,
      call: (path, body) => remotePoolControlRequest(path, body, socketPath),
      toolAuthorizeTimeoutMs: 3_000,
    })

    const masterPayloads: V3MasterSinkWirePayload[] = []
    const masterServer = createServer((req, res) => {
      res.setHeader('connection', 'close')
      const url = req.url ?? '/'
      if (url.startsWith('/internal/v3/marketplace/sync')) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ identityCompat: { schema: 1, userId: '3', profiles: [] } }))
        return
      }
      if (url.startsWith('/internal/v3/platform-prompt-slots')) {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ slots: [], promptPolicy: { schemaVersion: 1, profile: null } }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => masterServer.listen(0, '127.0.0.1', resolve))
    const masterPort = (masterServer.address() as { port: number }).port
    const prevMasterUrl = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    const prevToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${masterPort}`
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-780-token'

    const retryQueue = makeV3MasterRetryQueue({
      dir: join(sandbox, 'sink-queue'),
      attemptSend: async (payload) => {
        masterPayloads.push(structuredClone(payload))
      },
      onDispatchAck: (dispatchId, attemptNo, status) => resolveInboxTerminalAck(dispatchId, attemptNo, status),
    })
    const sink = makeV3MasterSink({
      config: { baseUrl: `http://127.0.0.1:${masterPort}`, bearer: 'oc-v3.7.synthetic' },
      retryQueue,
      attemptSendImpl: async (payload) => {
        masterPayloads.push(structuredClone(payload))
        return {}
      },
      inboxHooks: {
        onStaged: async (dispatchId, attemptNo) => {
          await inboxSinkStagedByDispatch(dispatchId, attemptNo)
        },
        onAck: (dispatchId, attemptNo, status) => resolveInboxTerminalAck(dispatchId, attemptNo, status),
        onStageFailed: async (dispatchId, attemptNo) => {
          await inboxSinkStageFailedByDispatch(dispatchId, attemptNo)
        },
      },
    })
    setV3MasterSinkSingleton(sink)

    const config = {
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
      defaults: { model: canonicalModel },
      mcpServers: [],
    } as unknown as OpenClaudeConfig
    const sm = new SessionManager(config)

    try {
      const session = await sm.getOrCreate({
        sessionKey,
        peerId,
        channel: 'webchat',
        userId: '3',
        agent: { id: 'main', model: canonicalModel, cwd: workspaceDir },
        model: canonicalModel,
        executionAuthority: {
          source: 'bridge_signed',
          engine: 'ccb',
          canonicalModel,
          executionBackend: remotePoolBackendOf(binding),
        },
        workspaceCwd: workspaceDir,
      })

      const prompt = 'test synthetic verification error'
      const dispatchId = randomUUID()
      const clientMessageId = `m-${randomUUID().slice(0, 12)}`
      const issuedAt = Date.now()
      const authorityTurnId = createHash('md5').update(`auth:${dispatchId}`).digest('hex')
      const requestId = createHash('md5').update(`req:${dispatchId}`).digest('hex')

      await insertQueuedTurnDispatch({
        userId: '3',
        sessionId: peerId,
        clientMessageId,
        dispatchId,
        attemptNo: 1,
        payloadHash: createHash('sha256').update(prompt).digest('hex'),
        now: issuedAt,
      })

      // Use a bounded 20s turn lease TTL (covering ~7-12s cold tsx MCP startup under parallel gate load)
      // while still waiting past `expiresAt` to directly observe that `this.expiry` was cleared on settlement!
      const tickets = makeSignedTickets({
        kp,
        keyId,
        binding,
        canonicalModel,
        authorityTurnId,
        issuedAt,
        leaseTtlMs: 20_000,
      })

      const liveEvents: Array<Record<string, unknown>> = []
      await sm.submit(
        session,
        prompt,
        (ev) => liveEvents.push(ev as unknown as Record<string, unknown>),
        'medium',
        canonicalModel,
        requestId,
        `trace-${dispatchId.slice(0, 8)}`,
        undefined,
        {
          modelAuthority: {
            authorityEnvelope: tickets.authorityEnvelope,
            leaseEnvelope: tickets.leaseEnvelope,
            executionDescriptor: {
              executionBackend: remotePoolBackendOf(binding),
              canonicalModel,
              contextWindow: 200_000,
              capabilityZero: true,
              supportsThinking: true,
              supportsVision: true,
              supportedEfforts: ['low', 'medium', 'high'],
            },
          },
          replayLifecycle: {
            clientMessageId,
            onStart: () => {},
            onBeforeRelease: () => {},
            onEnd: () => {},
          },
          dispatchContext: {
            userId: '3',
            sessionId: peerId,
            clientMessageId,
            dispatchId,
            attemptNo: 1,
          },
        },
      )

      // 1. Assert turn settled before lease expired, then wait past the 4500ms turn lease TTL — settled relay MUST stay idle and NOT self-fence!
      assert.equal(settledReceipts.length, 1, `turn must settle before short test lease expires (fence=${relay.fenceReason})`)
      const waitMs = Math.max(250, tickets.leasePayload.expiresAt - Date.now() + 300)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      assert.equal(
        relay.stopped,
        false,
        `settled relay must NOT fence with ${relay.fenceReason ?? 'unknown'} after turn lease TTL`,
      )
      assert.equal(relay.fenceReason, undefined)
      assert.equal(relay.idle, true, 'settled relay must remain idle for cutover drain')

      // 2. Receipt + duplicate result idempotency proven
      assert.equal(settledReceipts.length, 1)
      assert.equal(settledReceipts[0]!.nativeStatus, 'error')
      const journalFilesAfterSettle = readdirSync(journalDir)
      assert.equal(
        journalFilesAfterSettle.some((f) => f.endsWith('-duplicate-terminal.json')),
        true,
        'duplicate result frame with same uuid must replay deterministically without REMOTE_TERMINAL_CONFLICT',
      )

      // 3. Error detail & non-auto-recoverable AUTH_ERROR classification proven
      assert.equal(masterPayloads.length, 1)
      const persisted = masterPayloads[0]!
      assert.equal(persisted.errorCode, 'AUTH_ERROR', `expected AUTH_ERROR on durable tape, got ${persisted.errorCode}`)
      assert.equal(
        supportsAutomaticTurnRecovery(persisted.errorCode ?? ''),
        false,
        'verification_required / auth block must NEVER trigger blind 10x automatic turn recovery',
      )
      assert.match(
        String(persisted.errorDetail ?? ''),
        /Anthropic Verification Portal/,
        'durable errorDetail must preserve the <synthetic> API error message',
      )
      const liveErrorEvent = liveEvents.find((e) => e.kind === 'error')
      assert.ok(liveErrorEvent, 'live stream must receive error event')
      assert.equal(liveErrorEvent.errorCode, 'auth_error')
      assert.match(String(liveErrorEvent.error ?? ''), /Anthropic Verification Portal/)

      await sm.awaitPendingPersistence()
      const inboxRow = await getTurnDispatchByDispatchId(dispatchId, 1)
      assert.equal(inboxRow?.state, 'terminal')

      // 4. Late in-flight `/renew` arriving after settlement must NOT fence or re-arm expiry
      const lateLeasePayload: TurnLease = {
        ...tickets.leasePayload,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 200,
      }
      const lateRenewReply = await remotePoolControlRequest(
        '/renew',
        {
          capability: binding.capability,
          operationId: binding.operationId,
          sessionKey: binding.sessionKey,
          uid: binding.uid,
          containerDbId: binding.containerDbId,
          dockerId: binding.dockerId,
          generation: binding.generation,
          driverId: binding.driverId,
          engineId: binding.engineId,
          lease: encodeTurnLeaseEnvelope(
            lateLeasePayload,
            sign(null, turnLeaseSigningInput(lateLeasePayload), kp.privateKey),
          ),
        },
        socketPath,
      )
      assert.equal(lateRenewReply.ok, true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(relay.stopped, false, 'late /renew after settlement must not re-arm lease expiry')
      assert.equal(relay.idle, true)

      // 5. Trigger an unexpected idle app exit — `stop()` must complete immediately (`localStopped === true`)!
      writeFileSync(exitSignalFile, 'exit\n', 'utf8')
      const fenceDeadline = Date.now() + 3_000
      while (!relay.stopped && Date.now() < fenceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(relay.stopped, true)
      const stopResult = await relay.stop()
      assert.equal(stopResult.remoteStopped, true, 'idle fence after settled turn must complete stop() without REMOTE_LOCAL_STOP_TIMEOUT')
      assert.equal(
        readdirSync(journalDir).some((f) => f.endsWith('-stopped.json')),
        true,
        'stopped.json must be recorded immediately after idle fence',
      )
    } finally {
      laneOverridesByOpId.delete(operationId)
      retryQueue.stopPeriodic()
      await sm.shutdownAll().catch(() => {})
      await relay.stop().catch(() => {})
      if (relay.controlServer.listening) {
        await new Promise<void>((resolve) => {
          relay.controlServer.closeAllConnections()
          relay.controlServer.close(() => resolve())
        })
      }
      await worker.close()
      await new Promise<void>((resolve) => {
        masterServer.closeAllConnections()
        masterServer.close(() => resolve())
      })
      if (prevMasterUrl === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
      else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = prevMasterUrl
      if (prevToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
      else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = prevToken
      if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    }
  },
)

test(
  'undispatched /abandon resets localStopped for clean idle teardown and late /tool/stopped re-drives stop() closure (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
  async () => {
    const sandbox = mkdtempSync('/tmp/oc-drvtest-780-abandon-')
    const resRoot = join(sandbox, 'resources')
    const fakeSys = join(sandbox, 'fake-systemd')
    mkdirSync(sandbox, { recursive: true, mode: 0o700 })

    const cliPath = makeSyntheticErrorCcFixture(sandbox)
    const envExtra: Record<string, string> = {
      OC_REMOTE_RESOURCE_ROOT: resRoot,
      OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
      OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
      OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
    }

    const worker = new DriverWorkerClient()
    const workerInfo = await worker.info('cc')

    const makeLane = async (label: string) => {
      const operationId = randomUUID()
      const runId = randomUUID()
      const sessionKey = `agent:main:webchat:dm:web780${label}${operationId.replace(/-/g, '').slice(0, 10)}`
      const laneRoot = join(sandbox, `run-lane-${operationId}`)
      const probeRoot = join(sandbox, `run-probe-${operationId}`)
      const journalDir = join(sandbox, `journal-${label}`)
      const upstreamModel = 'claude-opus-4-6'
      const canonicalModel = 'claude-opus-5-5-remote'

      const bootstrapSpec: RemotePoolLaneSpec = {
        controllerPath: CONTROLLER_PATH,
        controllerSha256: CONTROLLER_SHA256,
        manifest: {
          version: 4,
          root: laneRoot,
          driverId: 'cc',
          engineId: 'cc',
          operationId,
          runId,
          generation: '1',
          profileId: 'ebc80fa6-0348-49a3-b1c1-8a08017114d6',
          authEpoch: 'epoch-1',
          model: upstreamModel,
          driverDigest: workerInfo.driverDigest,
          coreDigest: workerInfo.coreDigest,
        },
        driverContext: {
          cliPath,
          accountHome: sandbox,
          bridgeMode: 'stdio-fixture',
          initialSessionUuid: randomUUID(),
        },
        verifiedProbe: {
          schemaVersion: 4,
          engineId: 'cc',
          driverId: 'cc',
          driverVersion: workerInfo.driverVersion,
          source: 'bootstrap:init',
          freshness: 'cli-observed',
          authPresent: true,
          accountObserved: true,
          cliVersion: '2.1.316',
          cliSha256: 'a'.repeat(64),
          models: [
            {
              upstreamModelId: upstreamModel,
              displayName: 'Opus 4.6',
              supportedEfforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
              supportsAdaptiveThinking: true,
              supportsVision: true,
            },
          ],
          rawResponseSha256: 'b'.repeat(64),
          observedAt: '2026-11-17T00:00:00Z',
        },
      }
      const probed = await RemotePoolSshHost.forLocalSandbox(bootstrapSpec, envExtra).probe(
        { cliPath, accountHome: sandbox },
        probeRoot,
      )
      const spec: RemotePoolLaneSpec = { ...bootstrapSpec, verifiedProbe: probed.snapshot }
      const host = RemotePoolSshHost.forLocalSandbox(spec, envExtra)
      const binding: RemotePoolBinding = {
        version: REMOTE_DRIVER_PROTOCOL_VERSION,
        backendKind: REMOTE_DRIVER_BACKEND,
        operationId,
        runId,
        uid: '3',
        containerDbId: '7',
        dockerId: 'd'.repeat(64),
        sessionKey,
        canonicalModel,
        upstreamModel,
        driverId: 'cc',
        engineId: 'cc',
        authorityEngine: 'ccb',
        driverVersion: workerInfo.driverVersion,
        driverDigest: workerInfo.driverDigest,
        coreDigest: workerInfo.coreDigest,
        probeFingerprint: probed.probeFingerprint,
        manifestSha256: remoteCanonicalSha256(spec.manifest),
        generation: '1',
        profileId: 'ebc80fa6-0348-49a3-b1c1-8a08017114d6',
        authEpoch: 'epoch-1',
        capability: 'c'.repeat(64),
        expiresAt: Date.now() + 600_000,
      }
      const kp = generateKeyPairSync('ed25519')
      const keyId = `key-${label}`
      const keys: AuthorityKeyring = new Map([
        [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
      ])
      const finance: RemotePoolFinancePort = {
        admit: async (input) => {
          const a = verifyAuthority(input.authorityEnvelope, keys, Date.now())
          const requestId = a.billingRequestId ?? `req-${a.authorityTurnId}`
          return {
            requestId,
            beforeHostStart: async () => {},
            beforeDispatch: async () => {},
            bindNativeThread: async () => null,
            abandonUndispatched: async () => ({ state: 'proven', requestId, disposition: 'waived_zero' }),
            terminal: async (receipt) => ({ state: 'proven', requestId: receipt.requestId, disposition: 'settled' }),
            stop: async () => {},
          }
        },
      }
      const relay = new RemotePoolRelay({
        binding,
        keys,
        host,
        spec,
        journalDir,
        finance,
        worker,
      })
      const scope = {
        capability: binding.capability,
        operationId: binding.operationId,
        sessionKey: binding.sessionKey,
        uid: binding.uid,
        containerDbId: binding.containerDbId,
        dockerId: binding.dockerId,
        generation: binding.generation,
        driverId: binding.driverId,
        engineId: binding.engineId,
      }
      const authorityTurnId = createHash('md5').update(`auth-${label}`).digest('hex')
      const turnKey = createHash('sha256').update(`tk-${label}`).digest('hex')
      const tickets = makeSignedTickets({
        kp,
        keyId,
        binding,
        canonicalModel,
        authorityTurnId,
        issuedAt: Date.now(),
        leaseTtlMs: 60_000,
      })
      const socketPath = join(sandbox, `relay-${label}.sock`)
      relay.controlServer.listen(socketPath)
      await once(relay.controlServer, 'listening')
      await remotePoolControlRequest('/admit', {
        ...scope,
        authority: tickets.authorityEnvelope,
        lease: tickets.leaseEnvelope,
        turnKey,
        catalog: {
          tools: [{ name: 'NoopTool', description: 'noop', inputSchema: { type: 'object' } }],
        },
      }, socketPath)
      return { relay, scope, authorityTurnId, turnKey, journalDir, socketPath }
    }

    try {
      // Part A: `/admit` -> `/abandon` -> `stop()` must succeed immediately without REMOTE_LOCAL_STOP_TIMEOUT
      const laneA = await makeLane('a')
      await laneA.relay.handleControl('/abandon', { ...laneA.scope, turnKey: laneA.turnKey })
      assert.equal(laneA.relay.idle, true)
      const stopA = await laneA.relay.stop()
      assert.equal(stopA.remoteStopped, true)

      // Part B: Mid-turn fence where initial `stop()` times out before container sends `/tool/stopped`;
      // late `/tool/stopped` must re-drive `stop()` (including runtime stop hooks) to completion!
      const laneB = await makeLane('b')
      let stopHookResolved = false
      const origStop = laneB.relay.stop.bind(laneB.relay)
      ;(laneB.relay as { stop: typeof laneB.relay.stop }).stop = () =>
        origStop().then((res) => {
          if (res.remoteStopped === true) stopHookResolved = true
          return res
        })

      await assert.rejects(() => laneB.relay.stop(), /REMOTE_LOCAL_STOP_TIMEOUT/)
      assert.equal(stopHookResolved, false)
      assert.equal(
        readdirSync(laneB.journalDir).some((f) => f.endsWith('-stopped.json')),
        false,
      )

      const lateStoppedReply = await remotePoolControlRequest('/tool/stopped', {
        ...laneB.scope,
        authorityTurnId: laneB.authorityTurnId,
        turnKey: laneB.turnKey,
      }, laneB.socketPath)
      assert.equal(lateStoppedReply.ok, true)
      assert.equal(stopHookResolved, true, 'late /tool/stopped over HTTP socket after 5s timeout must re-drive stop() and resolve stopProven')
      assert.equal(
        readdirSync(laneB.journalDir).some((f) => f.endsWith('-stopped.json')),
        true,
      )
      await new Promise<void>((r) => laneA.relay.controlServer.close(() => r()))
      await new Promise<void>((r) => laneB.relay.controlServer.close(() => r()))
    } finally {
      await worker.close()
      if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    }
  },
)

test(
  'cross-window 20-turn mixed replay preserves synthetic errorCode without conflict while tampered duplicate fences with REMOTE_TERMINAL_CONFLICT (INC-20261117-REMOTE-V4-DRAIN-CC-AUTH)',
  async () => {
    const sandbox = mkdtempSync('/tmp/oc-drvtest-780-win-')
    const resRoot = join(sandbox, 'resources')
    const fakeSys = join(sandbox, 'fake-systemd')
    const envExtra: Record<string, string> = {
      OC_REMOTE_RESOURCE_ROOT: resRoot,
      OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
      OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
      OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
    }

    const cliPath = writeExecutable(
      join(sandbox, 'fake-claude-20turn-window'),
      `#!/usr/bin/env python3
import json, os, pathlib, re, sys, time

args = sys.argv[1:]
if "-p" in args:
    for raw in sys.stdin:
        msg = json.loads(raw)
        if msg.get("type") == "control_request" and msg.get("request", {}).get("subtype") == "initialize":
            out = {"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {
                "claude_code_version": "2.1.316",
                "account": {"email": "alice@example.com", "subscriptionType": "max"},
                "models": [{"value": "claude-opus-4-6", "displayName": "Opus 4.6", "supportedEffortLevels": ["low", "medium", "high"], "supportsAdaptiveThinking": True}],
            }}}
            sys.stdout.write(json.dumps(out, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            sys.exit(0)
    sys.exit(1)

def arg_val(flag, default=""):
    return args[args.index(flag) + 1] if flag in args else default

model = arg_val("--model", "claude-opus-4-6")
session_id = arg_val("--session-id") or arg_val("--resume")
home_dir = pathlib.Path(os.environ.get("HOME", "/tmp"))
sanitized_cwd = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
tp = home_dir / ".claude/projects" / sanitized_cwd / f"{session_id}.jsonl"
if "--session-id" in args:
    tp.parent.mkdir(parents=True, exist_ok=True)
    tp.write_text(json.dumps({"sessionId": session_id}) + "\\n", encoding="utf-8")

sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": session_id, "model": model, "tools": ["mcp__ocbridge__NoopTool"]}, separators=(",", ":")) + "\\n")
sys.stdout.flush()

turn_seq = 0
turn1_result = None
conflict_trigger = pathlib.Path(${JSON.stringify(join(sandbox, 'emit-conflict'))})

for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    if msg.get("type") != "user":
        continue
    turn_seq += 1
    res_uuid = f"win780-turn-{turn_seq:03d}"
    is_synth_err = (turn_seq == 1) or (turn_seq % 2 == 0)
    if turn_seq == 18:
        res_frame = {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "",
            "errors": (["x"] * 16) + ["rate_limit"],
            "session_id": session_id,
            "uuid": res_uuid,
            "usage": {"input_tokens": turn_seq, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }
    elif is_synth_err:
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "is_api_error_message": True,
            "message": {"model": "<synthetic>", "content": [{"type": "text", "text": ${JSON.stringify(VERIFICATION_PORTAL_TEXT)}}]},
        }, separators=(",", ":")) + "\\n")
        res_frame = {
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": True,
            "result": "",
            "errors": ["turn ended on an API error"],
            "session_id": session_id,
            "uuid": res_uuid,
            "usage": {"input_tokens": turn_seq, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }
    else:
        sys.stdout.write(json.dumps({
            "type": "stream_event",
            "session_id": session_id,
            "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": f"ok-{turn_seq}"}},
        }, separators=(",", ":")) + "\\n")
        res_frame = {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": f"ok-{turn_seq}",
            "session_id": session_id,
            "uuid": res_uuid,
            "usage": {"input_tokens": turn_seq, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
        }
    if turn_seq == 1:
        turn1_result = dict(res_frame)
    if turn_seq == 18:
        turn18_result = dict(res_frame)
    sys.stdout.write(json.dumps(res_frame, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

    if turn_seq == 20:
        # 1) After 20 mixed turns (> old 16-entry cache), replay Turn 1 result verbatim while idle
        time.sleep(0.05)
        sys.stdout.write(json.dumps(turn1_result, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        # 2) Wait for test to assert clean duplicate-terminal before emitting a 17th-element errors[] conflict on Turn 18
        while not conflict_trigger.exists():
            time.sleep(0.02)
        tampered = dict(turn18_result)
        tampered["errors"] = (["x"] * 16) + ["authentication_failed"]
        sys.stdout.write(json.dumps(tampered, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        time.sleep(0.2)
        break
`,
    )

    const worker = new DriverWorkerClient()
    let relay: InstanceType<typeof RemotePoolRelay> | undefined
    try {
      const workerInfo = await worker.info('cc')
      const operationId = randomUUID()
      const runId = randomUUID()
      const profileId = 'ebc80fa6-0348-49a3-b1c1-8a08017114d6'
      const upstreamModel = 'claude-opus-4-6'
      const canonicalModel = 'claude-opus-5-5-remote'
      const laneRoot = join(sandbox, `run-lane-${operationId}`)
      const probeRoot = join(sandbox, `run-probe-${operationId}`)
      const journalDir = join(sandbox, 'journal')

      const bootstrapSpec: RemotePoolLaneSpec = {
        controllerPath: CONTROLLER_PATH,
        controllerSha256: CONTROLLER_SHA256,
        manifest: {
          version: 4,
          root: laneRoot,
          driverId: 'cc',
          engineId: 'cc',
          operationId,
          runId,
          generation: '1',
          profileId,
          authEpoch: 'epoch-1',
          model: upstreamModel,
          driverDigest: workerInfo.driverDigest,
          coreDigest: workerInfo.coreDigest,
        },
        driverContext: {
          cliPath,
          accountHome: sandbox,
          bridgeMode: 'stdio-fixture',
          initialSessionUuid: randomUUID(),
        },
        verifiedProbe: {
          schemaVersion: 4,
          engineId: 'cc',
          driverId: 'cc',
          driverVersion: workerInfo.driverVersion,
          source: 'bootstrap:init',
          freshness: 'cli-observed',
          authPresent: true,
          accountObserved: true,
          cliVersion: '2.1.316',
          cliSha256: 'a'.repeat(64),
          models: [{
            upstreamModelId: upstreamModel,
            displayName: 'Opus 4.6',
            supportedEfforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
            supportsAdaptiveThinking: true,
            supportsVision: true,
          }],
          rawResponseSha256: 'b'.repeat(64),
          observedAt: '2026-11-17T00:00:00Z',
        },
      }
      const probed = await RemotePoolSshHost.forLocalSandbox(bootstrapSpec, envExtra).probe(
        { cliPath, accountHome: sandbox },
        probeRoot,
      )
      const spec: RemotePoolLaneSpec = { ...bootstrapSpec, verifiedProbe: probed.snapshot }
      const host = RemotePoolSshHost.forLocalSandbox(spec, envExtra)
      const binding: RemotePoolBinding = {
        version: REMOTE_DRIVER_PROTOCOL_VERSION,
        backendKind: REMOTE_DRIVER_BACKEND,
        operationId,
        runId,
        uid: '3',
        containerDbId: '7',
        dockerId: 'd'.repeat(64),
        sessionKey: 'agent:main:webchat:dm:web780win',
        canonicalModel,
        upstreamModel,
        driverId: 'cc',
        engineId: 'cc',
        authorityEngine: 'ccb',
        driverVersion: workerInfo.driverVersion,
        driverDigest: workerInfo.driverDigest,
        coreDigest: workerInfo.coreDigest,
        probeFingerprint: probed.probeFingerprint,
        manifestSha256: remoteCanonicalSha256(spec.manifest),
        generation: '1',
        profileId,
        authEpoch: 'epoch-1',
        capability: 'c'.repeat(64),
        expiresAt: Date.now() + 600_000,
      }

      const kp = generateKeyPairSync('ed25519')
      const keyId = 'win780-key'
      const pubBytes = new Uint8Array(
        Buffer.from((kp.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url'),
      )
      const keys: AuthorityKeyring = new Map([[keyId, pubBytes]])
      const finance: RemotePoolFinancePort = {
        admit: async (inp) => {
          const a = verifyAuthority(inp.authorityEnvelope, keys, Date.now())
          const requestId = a.billingRequestId ?? `req-${a.authorityTurnId}`
          return {
            requestId,
            beforeHostStart: async () => {},
            beforeDispatch: async () => {},
            bindNativeThread: async () => null,
            abandonUndispatched: async () => ({ state: 'proven', requestId, disposition: 'waived_zero' }),
            terminal: async (rcpt) => ({ state: 'proven', requestId: rcpt.requestId, disposition: 'settled' }),
            stop: async () => {},
          }
        },
      }

      relay = new RemotePoolRelay({
        binding,
        keys,
        host,
        spec,
        journalDir,
        finance,
        worker,
      })
      const socketPath = join(sandbox, 'relay-win.sock')
      relay.controlServer.listen(socketPath)
      await once(relay.controlServer, 'listening')

      const scope = {
        capability: binding.capability,
        operationId: binding.operationId,
        sessionKey: binding.sessionKey,
        uid: binding.uid,
        containerDbId: binding.containerDbId,
        dockerId: binding.dockerId,
        generation: binding.generation,
        driverId: binding.driverId,
        engineId: binding.engineId,
      }

      for (let t = 1; t <= 20; t++) {
        const authorityTurnId = createHash('md5').update(`win-auth-${t}`).digest('hex')
        const turnKey = createHash('sha256').update(`win-tk-${t}`).digest('hex')
        const tickets = makeSignedTickets({
          kp,
          keyId,
          binding,
          canonicalModel,
          authorityTurnId,
          issuedAt: Date.now(),
          leaseTtlMs: 30_000,
        })
        const admitRes = await remotePoolControlRequest(
          '/admit',
          {
            ...scope,
            authority: tickets.authorityEnvelope,
            lease: tickets.leaseEnvelope,
            turnKey,
            catalog: { tools: [{ name: 'NoopTool', description: 'noop', inputSchema: { type: 'object' } }] },
          },
          socketPath,
        )
        let afterSeq = Number(admitRes.seq)
        const nativeSessionId = String(admitRes.nativeSessionId)
        await remotePoolControlRequest(
          '/command',
          {
            ...scope,
            command: { kind: 'newTurn', commandId: `cmd-win-${t}`, model: upstreamModel, prompt: `p-${t}`, nativeSessionId },
          },
          socketPath,
        )
        let settled = false
        const deadline = Date.now() + 5_000
        while (!settled && Date.now() < deadline) {
          const polled = await remotePoolControlRequest('/poll', { ...scope, afterSeq }, socketPath)
          const frames = (polled.frames as Array<{ seq: number; frame: { kind: string } }>) ?? []
          for (const f of frames) {
            afterSeq = f.seq
            if (f.frame.kind === 'turn_settled') settled = true
          }
          if (!settled) await new Promise((r) => setTimeout(r, 15))
        }
        assert.equal(settled, true, `turn ${t} must settle`)
      }

      // Wait for the verbatim Turn 1 duplicate replay emitted right after Turn 20
      const dupDeadline = Date.now() + 3_000
      while (
        !readdirSync(journalDir).some((f) => f.endsWith('-duplicate-terminal.json')) &&
        Date.now() < dupDeadline
      ) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.equal(
        readdirSync(journalDir).some((f) => f.endsWith('-duplicate-terminal.json')),
        true,
        'Turn 1 exact duplicate replayed after 20 mixed turns must record duplicate-terminal',
      )
      assert.equal(relay.stopped, false, `must not fence on cross-window exact duplicate (fence=${relay.fenceReason})`)
      assert.equal(relay.fenceReason, undefined)

      // Now trigger a tampered duplicate result with Turn 1 UUID -> must fence with REMOTE_TERMINAL_CONFLICT!
      writeFileSync(join(sandbox, 'emit-conflict'), '1\n')
      const conflictDeadline = Date.now() + 3_000
      while (!relay.fenceReason && Date.now() < conflictDeadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.equal(relay.fenceReason, 'REMOTE_TERMINAL_CONFLICT')
      await relay.stop()
      await new Promise<void>((r) => relay!.controlServer.close(() => r()))
    } finally {
      await relay?.stop().catch(() => {})
      await worker.close()
      if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true })
    }
  },
)
