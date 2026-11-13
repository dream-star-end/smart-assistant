/**
 * End-to-end gateway integration tests for `remote-driver-v4` shared core:
 *   RemoteEngineAdapter <-> RemoteContainerLane <-> AF_UNIX relay.sock <->
 *   RemotePoolRelay <-> DriverWorkerClient <-> RemotePoolSshHost.forLocalSandbox <->
 *   controller.py <-> mcp_socket.py <-> mcp_client.py <-> cc / codex drivers.
 *
 * Verifies real outcomes across BOTH `cc` and `codex`:
 * 1. Real container tool execution (sentinel file written on container filesystem, never on node/master),
 *    warm multi-turn reuse on the same resident process, and accurate per-turn vs cumulative `RemoteReceiptV4`.
 * 2. Unobserved MCP tool call (`UNOBSERVED_TOOL`) -> zero container tool executions + fail-closed fence.
 * 3. Disallowed native item (`DISALLOWED_NATIVE_TOOL`) -> zero container tool executions + `REMOTE_DISALLOWED_ITEM` fence.
 * 4. Duplicate identical terminal deduplication vs conflicting terminal `REMOTE_TERMINAL_CONFLICT` fence.
 * 5. Pre-flight memory exhaustion (`REMOTE_NODE_MEMORY_EXHAUSTED`) propagation and R1 `relay.idle` drain gate.
 * 6. Gateway registry (`createEngine`), `cc5SessionBackend`, and `remotev4:` bound-resume enforcement.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  verifyAuthority,
  zeroCountersForUsagePolicy,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import { cc5SessionBackend, assertFreshCc5Session } from '../cc5SessionBackend.js'
import type { EngineBillingEvent, EngineEvent } from '../engine/engineEvents.js'
import { createEngine } from '../engine/registry.js'
import type { TurnParams } from '../engine/engineAdapter.js'
import {
  DriverWorkerClient,
  RemoteEngineAdapter,
  RemotePoolRelay,
  RemotePoolSshHost,
  parseRemoteV4ResumeId,
  remotePoolBackendOf,
  remoteV4ResumeId,
  type LaneToolHost,
  type RemotePoolBinding,
  type RemotePoolFinancePort,
  type RemotePoolLaneSpec,
} from '../remotePool/index.js'
import '../remotePool/registerRemoteDriver.js'

const CONTROLLER_PATH = fileURLToPath(
  new URL('../../../../scripts/agent-remote/core/controller.py', import.meta.url),
)
const CONTROLLER_SHA256 = createHash('sha256').update(readFileSync(CONTROLLER_PATH)).digest('hex')

function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function makeCcCliFixture(dir: string): string {
  return writeExecutable(
    join(dir, 'fake-claude'),
    `#!/usr/bin/env python3
import json, pathlib, subprocess, sys

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
                            "value": "claude-sonnet-4-6",
                            "displayName": "Sonnet 4.6",
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

model = arg_val("--model", "claude-sonnet-4-6")
session_id = arg_val("--session-id") or arg_val("--resume")
prompt_file = arg_val("--append-system-prompt-file")
if prompt_file:
    pathlib.Path(${JSON.stringify(join(dir, 'cli-observed-instructions.txt'))}).write_text(
        pathlib.Path(prompt_file).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
mcp_cfg = json.loads(pathlib.Path(arg_val("--mcp-config")).read_text())
oc_srv = mcp_cfg["mcpServers"]["ocbridge"]

sys.stdout.write(json.dumps({
    "type": "system",
    "subtype": "init",
    "session_id": session_id,
    "model": model,
    "tools": ["mcp__ocbridge__ContainerSentinelWrite"],
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
    text = msg["message"]["content"][0]["text"]
    call_id = f"toolu_cc_{turn_seq:04d}"
    res_id = f"res_cc_{turn_seq:04d}"

    if "DISALLOWED_NATIVE_TOOL" in text:
        sys.stdout.write(json.dumps({
            "type": "assistant",
            "session_id": session_id,
            "message": {
                "model": model,
                "role": "assistant",
                "content": [{"type": "tool_use", "id": call_id, "name": "Bash", "input": {"command": "id"}}],
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
        continue

    if "UNOBSERVED_TOOL" in text:
        mcp_proc = subprocess.Popen(
            [oc_srv["command"], *oc_srv["args"]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        mcp_req = {
            "jsonrpc": "2.0",
            "id": 900 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": "ContainerSentinelWrite",
                "arguments": {"token": text},
                "_meta": {"claudecode/toolUseId": call_id},
            },
        }
        try:
            mcp_proc.communicate(json.dumps(mcp_req) + "\\n", timeout=3)
        except Exception:
            mcp_proc.kill()
        continue

    tool_args = {"token": f"{text}:t{turn_seq}"}
    sys.stdout.write(json.dumps({
        "type": "assistant",
        "session_id": session_id,
        "message": {
            "model": model,
            "role": "assistant",
            "content": [{"type": "tool_use", "id": call_id, "name": "mcp__ocbridge__ContainerSentinelWrite", "input": tool_args}],
        },
    }, separators=(",", ":")) + "\\n")
    sys.stdout.flush()

    mcp_proc = subprocess.Popen(
        [oc_srv["command"], *oc_srv["args"]],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    mcp_req = {
        "jsonrpc": "2.0",
        "id": 100 + turn_seq,
        "method": "tools/call",
        "params": {
            "name": "ContainerSentinelWrite",
            "arguments": tool_args,
            "_meta": {"claudecode/toolUseId": call_id},
        },
    }
    mcp_out, _ = mcp_proc.communicate(json.dumps(mcp_req) + "\\n", timeout=10)
    mcp_reply = json.loads(mcp_out.splitlines()[0])
    tool_text = mcp_reply.get("result", {}).get("content", [{}])[0].get("text", "ERR")

    sys.stdout.write(json.dumps({
        "type": "stream_event",
        "session_id": session_id,
        "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": f"cc:{tool_text}"}},
    }, separators=(",", ":")) + "\\n")

    result_frame = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": session_id,
        "uuid": res_id,
        "usage": {
            "input_tokens": 100 + 10 * turn_seq,
            "output_tokens": 40 + 5 * turn_seq,
            "cache_read_input_tokens": 25,
            "cache_creation_input_tokens": 10,
        },
    }
    sys.stdout.write(json.dumps(result_frame, separators=(",", ":")) + "\\n")
    if "DUPLICATE_SAME_TERMINAL" in text:
        sys.stdout.write(json.dumps(result_frame, separators=(",", ":")) + "\\n")
    if "CONFLICTING_TERMINAL" in text:
        conflict = dict(result_frame)
        conflict["is_error"] = True
        conflict["subtype"] = "error_during_execution"
        sys.stdout.write(json.dumps(conflict, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
`,
  )
}

function makeCodexCliFixture(dir: string): string {
  return writeExecutable(
    join(dir, 'fake-codex'),
    `#!/usr/bin/env python3
import json, pathlib, subprocess, sys

args = sys.argv[1:]
mcp_args = []
for i, a in enumerate(args):
    if a == "-c" and i + 1 < len(args):
        val = args[i + 1]
        if val.startswith("mcp_servers.ocbridge.args="):
            mcp_args = json.loads(val.split("=", 1)[1])

thread_id = "thr_codex_0001"
turn_seq = 0
cum_in = 0
cum_cached = 0
cum_out = 0

for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    rid = msg.get("id")
    method = msg.get("method")
    params = msg.get("params") or {}

    if method == "initialize":
        sys.stdout.write(json.dumps({"id": rid, "result": {"userAgent": "codex-cli/0.167.0"}}, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "account/read":
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"account": {"email": "bob@example.com", "planType": "pro"}},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "model/list":
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {
                "data": [{
                    "id": "gpt-5.4",
                    "displayName": "GPT 5.4",
                    "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"reasoningEffort": "medium"}, {"reasoningEffort": "high"}],
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text", "image"],
                }],
                "nextCursor": None,
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method in ("thread/start", "thread/resume"):
        if isinstance(params.get("baseInstructions"), str):
            pathlib.Path(${JSON.stringify(join(dir, 'cli-observed-instructions.txt'))}).write_text(
                params["baseInstructions"],
                encoding="utf-8",
            )
        tid = params.get("threadId") or thread_id
        thread_id = tid
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"thread": {"id": tid}, "model": params.get("model", "gpt-5.4")},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "turn/start":
        turn_seq += 1
        turn_id = f"turn_codex_{turn_seq:04d}"
        call_id = f"call_codex_{turn_seq:04d}"
        prompt_items = params.get("input") or []
        text = prompt_items[0].get("text", "") if prompt_items else ""

        sys.stdout.write(json.dumps({"id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress"}}}, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({
            "method": "turn/started",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress"}},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

        if "DISALLOWED_NATIVE_TOOL" in text:
            sys.stdout.write(json.dumps({
                "method": "item/started",
                "params": {
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "item": {"type": "commandExecution", "id": call_id, "command": "id"},
                },
            }, separators=(",", ":")) + "\\n")
            sys.stdout.flush()
            continue

        if "UNOBSERVED_TOOL" in text:
            mcp_proc = subprocess.Popen(
                ["/usr/bin/python3", *mcp_args],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            mcp_req = {
                "jsonrpc": "2.0",
                "id": 900 + turn_seq,
                "method": "tools/call",
                "params": {
                    "name": "ContainerSentinelWrite",
                    "arguments": {"token": text},
                    "_meta": {
                        "callId": call_id,
                        "threadId": thread_id,
                        "x-codex-turn-metadata": {"turn_id": turn_id},
                    },
                },
            }
            try:
                mcp_proc.communicate(json.dumps(mcp_req) + "\\n", timeout=3)
            except Exception:
                mcp_proc.kill()
            continue

        tool_args = {"token": f"{text}:t{turn_seq}"}
        sys.stdout.write(json.dumps({
            "method": "item/started",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {
                    "type": "mcpToolCall",
                    "id": call_id,
                    "server": "ocbridge",
                    "tool": "ContainerSentinelWrite",
                    "arguments": tool_args,
                },
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

        mcp_proc = subprocess.Popen(
            ["/usr/bin/python3", *mcp_args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        mcp_req = {
            "jsonrpc": "2.0",
            "id": 200 + turn_seq,
            "method": "tools/call",
            "params": {
                "name": "ContainerSentinelWrite",
                "arguments": tool_args,
                "_meta": {
                    "callId": call_id,
                    "threadId": thread_id,
                    "x-codex-turn-metadata": {"turn_id": turn_id},
                },
            },
        }
        mcp_out, _ = mcp_proc.communicate(json.dumps(mcp_req) + "\\n", timeout=10)
        mcp_reply = json.loads(mcp_out.splitlines()[0])
        tool_text = mcp_reply.get("result", {}).get("content", [{}])[0].get("text", "ERR")

        sys.stdout.write(json.dumps({
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {
                    "type": "mcpToolCall",
                    "id": call_id,
                    "server": "ocbridge",
                    "tool": "ContainerSentinelWrite",
                    "arguments": tool_args,
                    "status": "completed",
                },
            },
        }, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "itemId": f"msg_{turn_seq}", "delta": f"codex:{tool_text}"},
        }, separators=(",", ":")) + "\\n")

        # Codex reports cumulative total where inputTokens includes cachedInputTokens.
        step_uncached_in = 110 + 10 * turn_seq
        step_cached_in = 30
        step_out = 50 + 5 * turn_seq
        cum_in += step_uncached_in + step_cached_in
        cum_cached += step_cached_in
        cum_out += step_out

        sys.stdout.write(json.dumps({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "tokenUsage": {
                    "total": {
                        "totalTokens": cum_in + cum_out,
                        "inputTokens": cum_in,
                        "cachedInputTokens": cum_cached,
                        "outputTokens": cum_out,
                        "reasoningOutputTokens": 10,
                    },
                    "last": {
                        "totalTokens": step_uncached_in + step_cached_in + step_out,
                        "inputTokens": step_uncached_in + step_cached_in,
                        "cachedInputTokens": step_cached_in,
                        "outputTokens": step_out,
                        "reasoningOutputTokens": 10,
                    },
                },
            },
        }, separators=(",", ":")) + "\\n")

        completed_frame = {
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}},
        }
        sys.stdout.write(json.dumps(completed_frame, separators=(",", ":")) + "\\n")
        if "DUPLICATE_SAME_TERMINAL" in text:
            sys.stdout.write(json.dumps(completed_frame, separators=(",", ":")) + "\\n")
        if "CONFLICTING_TERMINAL" in text:
            sys.stdout.write(json.dumps({
                "method": "turn/completed",
                "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "failed"}},
            }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
`,
  )
}

interface E2EHarness {
  readonly sandbox: string
  readonly sentinelFile: string
  readonly observedInstructionsFile: string
  readonly executedCalls: Array<{ name: string; args: Record<string, unknown>; meta: Record<string, unknown> }>
  readonly settledReceipts: RemoteReceiptV4[]
  readonly billingEvents: EngineBillingEvent[]
  readonly stopRecords: Array<Record<string, unknown>>
  readonly relay: RemotePoolRelay
  readonly adapter: RemoteEngineAdapter
  readonly binding: RemotePoolBinding
  readonly signTurn: () => {
    readonly turnKey: string
    readonly requestId: string
    readonly authority: string
    readonly lease: string
    readonly payload: ModelAuthorityPayload
  }
  readonly submitPrompt: (prompt: string) => {
    readonly events: EngineEvent[]
    readonly run: ReturnType<RemoteEngineAdapter['submitTurn']>
  }
  readonly cleanup: () => Promise<void>
}

async function createDriverHarness(
  t: TestContext,
  driverId: 'cc' | 'codex',
  opts: {
    memAvailableBytes?: number
    toolAuthorizeTimeoutMs?: number
    useRealPlatformContext?: boolean
    persona?: string
    afterRelayListen?: (sandbox: string) => void
  } = {},
): Promise<E2EHarness> {
  const sandbox = mkdtempSync(`/tmp/oc-drvtest-gw-${driverId}-`)
  const resRoot = join(sandbox, 'resources')
  const fakeSys = join(sandbox, 'fake-systemd')
  const containerExecRoot = join(sandbox, 'container-exec')
  const sentinelFile = join(sandbox, 'container-sentinel.log')
  const observedInstructionsFile = join(sandbox, 'cli-observed-instructions.txt')
  const personaFile = opts.persona ? join(sandbox, 'SOUL.md') : undefined
  if (personaFile && opts.persona) {
    writeFileSync(personaFile, `# Persona\n${opts.persona}\n`, { mode: 0o600 })
  }
  mkdirSync(containerExecRoot, { recursive: true, mode: 0o700 })

  const probeEnvExtra: Record<string, string> = {
    OC_REMOTE_RESOURCE_ROOT: resRoot,
    OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
    OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
    OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
  }
  const laneEnvExtra: Record<string, string> = {
    ...probeEnvExtra,
    OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(opts.memAvailableBytes ?? 4096 * 1024 * 1024),
  }

  let upstreamModel: string
  let canonicalModel: string
  let authorityEngine: 'ccb' | 'codex'
  let profileId: string
  let probeCtx: Record<string, unknown>
  let driverCtx: Record<string, unknown>

  if (driverId === 'cc') {
    const cliPath = makeCcCliFixture(sandbox)
    upstreamModel = 'claude-sonnet-4-6'
    canonicalModel = 'claude-sonnet-4-6-remote'
    authorityEngine = 'ccb'
    profileId = 'ebc80fa6-0348-49a3-b1c1-8a08017114d6'
    probeCtx = { cliPath, accountHome: sandbox }
    driverCtx = {
      cliPath,
      accountHome: sandbox,
      bridgeMode: 'stdio-fixture',
      initialSessionUuid: '11111111-2222-4333-8444-555555555555',
    }
  } else {
    const cliPath = makeCodexCliFixture(sandbox)
    const codexHome = join(sandbox, 'codex-home')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    writeFileSync(join(codexHome, 'auth.json'), '{"token":"redacted"}', { mode: 0o600 })
    upstreamModel = 'gpt-5.4'
    canonicalModel = 'gpt-5.4-remote'
    authorityEngine = 'codex'
    profileId = 'c240b4a0-4d0b-49e8-b5d4-77252377ad88'
    probeCtx = {
      cliPath,
      nativePath: cliPath,
      codexHome,
      systemCodexRoot: join(sandbox, 'empty-etc-codex'),
    }
    driverCtx = { ...probeCtx }
  }

  const worker = new DriverWorkerClient()
  let cleanupRelay: RemotePoolRelay | undefined
  let cleanupAdapter: RemoteEngineAdapter | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => (cleanupPromise ??= (async () => {
    const errors: unknown[] = []
    const release = async (fn: () => unknown | Promise<unknown>) => {
      try { await fn() } catch (error) { errors.push(error) }
    }
    // One owner, registered before setup can fail: stop writers before removing their journal.
    const adapter = cleanupAdapter
    const relay = cleanupRelay
    if (adapter) await release(() => adapter.shutdown())
    if (relay) {
      await release(async () => assert.deepEqual(await relay.stop(), { remoteStopped: true }))
      relay.controlServer.closeAllConnections()
      if (relay.controlServer.listening) {
        await release(() => new Promise<void>((resolve, reject) => {
          relay.controlServer.close((error) => error ? reject(error) : resolve())
        }))
      }
      assert.equal(relay.controlServer.listening, false)
    }
    await release(() => worker.close())
    await release(() => rmSync(sandbox, { recursive: true, force: true }))
    assert.equal(existsSync(sandbox), false)
    if (errors.length) throw new AggregateError(errors, 'remote driver fixture cleanup failed')
  })())
  t.after(cleanup)
  const workerInfo = await worker.info(driverId)

  const operationId = randomUUID()
  const runId = randomUUID()
  const laneRoot = join(sandbox, `run-lane-${operationId}`)
  const probeRoot = join(sandbox, `run-probe-${operationId}`)

  const bootstrapSpec: RemotePoolLaneSpec = {
    controllerPath: CONTROLLER_PATH,
    controllerSha256: CONTROLLER_SHA256,
    manifest: {
      version: 4,
      root: laneRoot,
      driverId,
      engineId: driverId,
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
      engineId: driverId,
      driverId,
      driverVersion: workerInfo.driverVersion,
      source: 'bootstrap:init',
      freshness: 'cli-observed',
      authPresent: true,
      accountObserved: true,
      cliVersion: '0.0.0',
      cliSha256: 'a'.repeat(64),
      models: [
        {
          upstreamModelId: upstreamModel,
          displayName: upstreamModel,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportsAdaptiveThinking: true,
          supportsVision: true,
        },
      ],
      rawResponseSha256: 'b'.repeat(64),
      observedAt: '2026-11-11T00:00:00Z',
    },
  }

  const probeHost = RemotePoolSshHost.forLocalSandbox(bootstrapSpec, probeEnvExtra)
  const probed = await probeHost.probe(probeCtx, probeRoot)

  const spec: RemotePoolLaneSpec = {
    ...bootstrapSpec,
    verifiedProbe: probed.snapshot,
  }
  const host = RemotePoolSshHost.forLocalSandbox(spec, laneEnvExtra)

  const sessionKey = `agent:main:webchat:dm:v4_${driverId}_${operationId.slice(0, 8)}`
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
    driverId,
    engineId: driverId,
    authorityEngine,
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
  const keyId = 'v4-e2e-key'
  const keys: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])

  const settledReceipts: RemoteReceiptV4[] = []
  const stopRecords: Array<Record<string, unknown>> = []
  let cumulativeBaseline: Readonly<Record<string, number>> = zeroCountersForUsagePolicy(workerInfo.usagePolicy)

  const finance: RemotePoolFinancePort = {
    admit: async (input) => {
      const a = verifyAuthority(input.authorityEnvelope, keys, Date.now())
      const requestId = a.billingRequestId ?? `req-${a.authorityTurnId}`
      return {
        requestId,
        beforeHostStart: async () => {},
        beforeDispatch: async () => {},
        bindNativeThread: async () =>
          input.usagePolicy.mode === 'cumulative' ? { ...cumulativeBaseline } : null,
        abandonUndispatched: async () => ({ state: 'proven', requestId, disposition: 'waived_zero' }),
        terminal: async (receipt) => {
          settledReceipts.push(receipt)
          if (receipt.usageMode === 'cumulative') {
            cumulativeBaseline = { ...receipt.countersFinal }
          }
          return { state: 'proven', requestId: receipt.requestId, disposition: 'settled' }
        },
        stop: async (stopInfo) => {
          stopRecords.push({ ...stopInfo })
        },
      }
    },
  }

  const relay = new RemotePoolRelay({
    binding,
    keys,
    host,
    spec,
    journalDir: join(sandbox, 'journal'),
    finance,
    worker,
    observationOptions: { authorizeTimeoutMs: opts.toolAuthorizeTimeoutMs ?? 400 },
  })

  cleanupRelay = relay
  const socketPath = join(sandbox, 'relay.sock')
  relay.controlServer.listen(socketPath)
  await once(relay.controlServer, 'listening')
  opts.afterRelayListen?.(sandbox)

  const executedCalls: Array<{
    name: string
    args: Record<string, unknown>
    meta: Record<string, unknown>
  }> = []

  const hostFactory = (): LaneToolHost => ({
    tools: async () => [
      {
        name: 'ContainerSentinelWrite',
        description: 'Writes sentinel token on container disk',
        inputSchema: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
        },
      },
    ],
    execute: async (name, rawArgs, meta) => {
      const args = rawArgs as Record<string, unknown>
      executedCalls.push({
        name,
        args: structuredClone(args),
        meta: structuredClone(meta as unknown as Record<string, unknown>),
      })
      const line = `${driverId}:${String(args.token)}\n`
      writeFileSync(sentinelFile, line, { flag: 'a', mode: 0o600 })
      return {
        content: [{ type: 'text', text: `SENTINEL_OK(${String(args.token)})` }],
        isError: false,
      }
    },
    close: async () => {},
  })

  const adapter = new RemoteEngineAdapter(
    {
      peerId: 'peer-1',
      sessionKey,
      executionBackend: remotePoolBackendOf(binding),
      agentId: 'main',
      agentBaseDir: sandbox,
      model: canonicalModel,
      ...(personaFile !== undefined ? { persona: personaFile } : {}),
      config: { auth: {}, gateway: { port: 18789, accessToken: 'test-token' }, mcpServers: [] } as any,
    },
    {
      binding,
      socketPath,
      keyring: keys,
      executionRoot: containerExecRoot,
      hostFactory,
      ...(opts.useRealPlatformContext
        ? {}
        : {
            toolContextFactory: async () => ({
              profile: {} as any,
              env: { PATH: '/usr/bin:/bin' },
              platformPrompt: '',
              cleanup: () => {},
            }),
          }),
      toolAuthorizeTimeoutMs: opts.toolAuthorizeTimeoutMs ?? 400,
    },
  )

  cleanupAdapter = adapter
  const billingEvents: EngineBillingEvent[] = []
  adapter.on('billing', (ev: EngineBillingEvent) => {
    billingEvents.push(ev)
  })
  adapter.on('error', () => {
    // Prevent unhandled EventEmitter 'error' throws during negative fault tests.
  })

  let turnCounter = 0
  const signTurn = () => {
    turnCounter += 1
    const issuedAt = Date.now()
    const authorityTurnId = createHash('md5')
      .update(`${driverId}:auth:${operationId}:${turnCounter}`)
      .digest('hex')
    const requestId = createHash('md5').update(`req:${authorityTurnId}`).digest('hex')
    const turnKey = createHash('sha256').update(`tk:${authorityTurnId}`).digest('hex')
    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      ...(authorityEngine === 'codex' ? { billingRequestId: requestId } : {}),
      connectionChallenge: 'challenge-1',
      canonicalModel,
      engine: authorityEngine,
      executionBackend: remotePoolBackendOf(binding),
      securityEpoch: 1,
      executionRevision: 'rev-1',
      issuedAt,
      expiresAt: issuedAt + 120_000,
      executionDescriptor: {
        capabilityProfile:
          authorityEngine === 'ccb'
            ? { ccb: { capabilityZero: true, supportsThinking: true, contextOwner: 'box-native-v1' } }
            : {},
        capabilitySchemaVersion: 1,
        contextWindow: 200_000,
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      },
    }
    const leasePayload: TurnLease = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      connectionChallenge: 'challenge-1',
      canonicalModel,
      securityEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + 600_000,
    }
    const authority = encodeAuthorityEnvelope(payload, sign(null, authoritySigningInput(payload), kp.privateKey))
    const lease = encodeTurnLeaseEnvelope(leasePayload, sign(null, turnLeaseSigningInput(leasePayload), kp.privateKey))
    return { turnKey, requestId, authority, lease, payload }
  }

  const sessionTotals = { totalCostUSD: 0, turns: 0 }
  const toolUseIdToName = new Map<string, string>()

  const submitPrompt = (prompt: string) => {
    const signed = signTurn()
    const events: EngineEvent[] = []
    const params: TurnParams = {
      input: prompt,
      requestId: signed.requestId,
      turnKey: signed.turnKey,
      modelAuthority: {
        authorityEnvelope: signed.authority,
        leaseEnvelope: signed.lease,
        executionDescriptor: {
          executionBackend: remotePoolBackendOf(binding),
          canonicalModel,
          contextWindow: 200_000,
          capabilityZero: authorityEngine === 'ccb',
          supportsThinking: true,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
        },
      },
      onEvent: (ev) => events.push(ev),
      sessionTotals,
      toolUseIdToName,
    }
    const run = adapter.submitTurn(params)
    return { events, run }
  }

  return {
    sandbox,
    sentinelFile,
    observedInstructionsFile,
    executedCalls,
    settledReceipts,
    billingEvents,
    stopRecords,
    relay,
    adapter,
    binding,
    signTurn,
    submitPrompt,
    cleanup,
  }
}

for (const driverId of ['cc', 'codex'] as const) {
  test(`[${driverId}] end-to-end multi-turn warm reuse, real container sentinel, and accurate ReceiptV4`, async (t) => {
    const h = await createDriverHarness(t, driverId)

    // Turn 1
    const t1 = h.submitPrompt('PING_SENTINEL')
    await t1.run.submitted
    const s1 = await t1.run.summary
    await h.adapter.waitForOutputDrain()

    assert.ok(s1, `Turn 1 must resolve non-null TurnSummary (fence=${h.relay.fenceReason})`)
    assert.equal(s1.isError, false)
    assert.match(s1.assistantText, /SENTINEL_OK\(PING_SENTINEL:t1\)/)
    assert.equal(s1.tools.length, 1)
    assert.equal(s1.tools[0]!.toolName, 'ContainerSentinelWrite')
    assert.equal(s1.tools[0]!.completed, true)
    assert.equal(h.executedCalls.length, 1)
    // Verify deterministic UUID conversion for Cc5ToolHost `_meta.nativeSessionId` even when Codex threadId is `thr_codex_0001`.
    assert.match(
      String(h.executedCalls[0]!.meta.nativeSessionId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )

    // Verify `remotev4:` bound resume ID emitted.
    assert.ok(h.adapter.nativeSessionId?.startsWith('remotev4:'))
    assert.equal(parseRemoteV4ResumeId(h.adapter.nativeSessionId)?.bindingId, h.binding.operationId)

    // Wait briefly for poll drain and verify R1 `relay.idle === true` between turns.
    assert.equal(h.relay.idle, true)

    // Turn 2 on warm resident CLI process!
    const t2 = h.submitPrompt('SECOND_ROUND')
    await t2.run.submitted
    const s2 = await t2.run.summary
    await h.adapter.waitForOutputDrain()

    assert.ok(s2, 'Turn 2 must resolve non-null TurnSummary')
    assert.equal(s2.isError, false)
    assert.match(s2.assistantText, /SENTINEL_OK\(SECOND_ROUND:t2\)/)
    assert.equal(h.executedCalls.length, 2)
    assert.equal(h.settledReceipts.length, 2)

    // Verify real container disk effect matches both turns in order.
    const sentinelLines = readFileSync(h.sentinelFile, 'utf8').trim().split('\n')
    assert.deepEqual(sentinelLines, [
      `${driverId}:PING_SENTINEL:t1`,
      `${driverId}:SECOND_ROUND:t2`,
    ])

    // Verify normalized `RemoteReceiptV4` usage deltas!
    if (driverId === 'cc') {
      // Turn 1 per_turn: input=110, output=45, cacheRead=25, cacheWrite=10
      assert.deepEqual(h.settledReceipts[0]!.usage, {
        inputTokens: 110,
        outputTokens: 45,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
      })
      // Turn 2 per_turn: input=120, output=50, cacheRead=25, cacheWrite=10
      assert.deepEqual(h.settledReceipts[1]!.usage, {
        inputTokens: 120,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
      })
      assert.equal(h.billingEvents.length, 0, 'cc uses proxy billingMode')
    } else {
      // Codex cumulative: Turn 1 uncached=120, cached=30, output=55; Turn 2 delta uncached=130, cached=30, output=60!
      assert.deepEqual(h.settledReceipts[0]!.usage, {
        inputTokens: 120,
        outputTokens: 55,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      })
      assert.deepEqual(h.settledReceipts[1]!.usage, {
        inputTokens: 130,
        outputTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      })
      assert.equal(h.billingEvents.length, 2, 'codex emits engine-reported billing sideband per turn')
      assert.equal(h.billingEvents[1]!.usage?.input_tokens, 130)
      assert.equal(h.billingEvents[1]!.usage?.cache_read_input_tokens, 30)
      assert.equal(h.billingEvents[1]!.usage?.output_tokens, 60)
    }

    // Clean dual-proof shutdown.
    await h.adapter.shutdown()
    assert.equal(h.relay.stopped, true)
    const closing = h.cleanup()
    assert.equal(h.cleanup(), closing, 'repeat cleanup must join the same teardown')
    await closing
    assert.equal(h.relay.controlServer.listening, false)
    assert.equal(existsSync(h.sandbox), false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(existsSync(h.sandbox), false, 'no writer may recreate the removed sandbox')
  })

  test(`[${driverId}] unobserved MCP tool call executes ZERO times and fences lane fail-closed`, async (t) => {
    const h = await createDriverHarness(t, driverId, { toolAuthorizeTimeoutMs: 250 })
    const turn = h.submitPrompt('UNOBSERVED_TOOL')
    const summary = await turn.run.summary
    await h.adapter.waitForOutputDrain()

    assert.equal(summary, null)
    assert.equal(h.executedCalls.length, 0, 'unobserved tool MUST NOT execute')
    assert.equal(existsSync(h.sentinelFile), false, 'sentinel file MUST NOT exist')
    assert.equal(h.settledReceipts.length, 0)
  })

  test(`[${driverId}] disallowed native item executes ZERO times and fences with REMOTE_DISALLOWED_ITEM`, async (t) => {
    const h = await createDriverHarness(t, driverId)
    const turn = h.submitPrompt('DISALLOWED_NATIVE_TOOL')
    const summary = await turn.run.summary
    await h.adapter.waitForOutputDrain()

    assert.equal(summary, null)
    assert.equal(h.executedCalls.length, 0)
    assert.equal(h.relay.stopped, true)
    assert.equal(h.relay.fenceReason, 'REMOTE_DISALLOWED_ITEM')
    assert.equal(h.adapter.fenceReason, 'REMOTE_DISALLOWED_ITEM')
  })

  test(`[${driverId}] duplicate identical terminal deduplicates; conflicting terminal fences REMOTE_TERMINAL_CONFLICT`, async (t) => {
    const hDup = await createDriverHarness(t, driverId)
    const dupTurn = hDup.submitPrompt('DUPLICATE_SAME_TERMINAL')
    const dupSummary = await dupTurn.run.summary
    await hDup.adapter.waitForOutputDrain()

    assert.ok(dupSummary)
    assert.equal(dupSummary.isError, false)
    assert.equal(hDup.settledReceipts.length, 1, 'identical duplicate terminal must settle once')

    const hConflict = await createDriverHarness(t, driverId)
    const conflictTurn = hConflict.submitPrompt('CONFLICTING_TERMINAL')
    await conflictTurn.run.summary
    await hConflict.adapter.waitForOutputDrain()
    // Give relay a brief tick to process the trailing conflicting line on stdout.
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(hConflict.relay.stopped, true)
    assert.equal(hConflict.relay.fenceReason, 'REMOTE_TERMINAL_CONFLICT')
  })

  test(`[${driverId}] production RemoteEngineAdapter injects real platform prompt + persona + <tool-naming> onto wire`, async (t) => {
    const personaSentinel = `PERSONA_SENTINEL_C1_R3_${driverId.toUpperCase()}_9912`
    const h = await createDriverHarness(t, driverId, {
      useRealPlatformContext: true,
      persona: personaSentinel,
    })
    const turn = h.submitPrompt('PING_SENTINEL')
    await turn.run.submitted
    const summary = await turn.run.summary
    await h.adapter.waitForOutputDrain()

    assert.ok(summary, 'Turn must resolve non-null TurnSummary with real platform context')
    assert.equal(summary.isError, false)
    assert.equal(existsSync(h.observedInstructionsFile), true, 'CLI must receive wire instructions')
    const observedInstructions = readFileSync(h.observedInstructionsFile, 'utf8')
    assert.ok(
      observedInstructions.includes(personaSentinel),
      `wire instructions must contain platform persona sentinel (${personaSentinel})`,
    )
    assert.ok(
      observedInstructions.includes('<tool-naming>'),
      'wire instructions must contain <tool-naming> catalog notice',
    )
    assert.ok(
      observedInstructions.includes('ContainerSentinelWrite'),
      'wire instructions must contain compiled container tool name',
    )
    assert.ok(
      Buffer.byteLength(observedInstructions, 'utf8') > 2048,
      `wire instructions must carry full platform prompt (>2 KiB, got ${Buffer.byteLength(observedInstructions, 'utf8')} B)`,
    )
    await h.adapter.shutdown()
  })
}

test('node memory exhaustion rejects admission cleanly with REMOTE_NODE_MEMORY_EXHAUSTED', async (t) => {
  const h = await createDriverHarness(t, 'cc', { memAvailableBytes: 16 * 1024 * 1024 })
  const turn = h.submitPrompt('PING_SENTINEL')
  await assert.rejects(
    turn.run.submitted,
    (err: any) => err?.code === 'REMOTE_NODE_MEMORY_EXHAUSTED' && /远端节点内存不足/.test(String(err?.message)),
  )
  const summary = await turn.run.summary
  assert.equal(summary, null)
  assert.equal(h.executedCalls.length, 0)
  await h.relay.stop()
  assert.equal(h.stopRecords[0]?.nodeAdmissionRejected, true)
  assert.equal(h.stopRecords[0]?.nodeAdmissionReason, 'REMOTE_NODE_MEMORY_EXHAUSTED')
})

test('cc5SessionBackend and createEngine enforce remote-driver-v4 authorityEngine and bound resume IDs', async () => {
  const opId = randomUUID()
  const sessionKey = 'agent:main:webchat:dm:v4_gate_test'
  const validBackend = {
    kind: REMOTE_DRIVER_BACKEND,
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    engineId: 'codex',
    authorityEngine: 'codex' as const,
    driverId: 'codex',
    driverVersion: '1.0.0',
    sessionKey,
    operationId: opId,
    generation: '1',
    profileId: 'c240b4a0-4d0b-49e8-b5d4-77252377ad88',
    authEpoch: 'epoch-1',
  }

  const admitted = cc5SessionBackend({
    executionAuthority: { source: 'bridge_signed', executionBackend: validBackend },
    engineId: 'codex',
    executionModel: 'gpt-5.4-remote',
    sessionKey,
  })
  assert.deepEqual(admitted, validBackend)

  // Engine mismatch MUST reject fail-closed!
  assert.throws(
    () =>
      cc5SessionBackend({
        executionAuthority: { source: 'bridge_signed', executionBackend: validBackend },
        engineId: 'ccb',
        executionModel: 'gpt-5.4-remote',
        sessionKey,
      }),
    /CC5_BACKEND_SCOPE_INVALID/,
  )

  // Missing signed scope when `remotev4:` resume ID is stored MUST require a new chat!
  assert.throws(
    () =>
      cc5SessionBackend({
        engineId: 'codex',
        executionModel: 'gpt-5.4-remote',
        sessionKey,
        storedResumeId: remoteV4ResumeId(opId, 'thr_codex_0001'),
      }),
    /CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED/,
  )

  // Matching `remotev4:` bound resume passes `assertFreshCc5Session`; mismatched operationId fails!
  await assertFreshCc5Session({
    storedResumeId: remoteV4ResumeId(opId, 'thr_codex_0001'),
    executionBackend: validBackend,
    sessionIds: ['s1'],
    hasPersistedTurnActivity: async () => true,
  })

  await assert.rejects(
    () =>
      assertFreshCc5Session({
        storedResumeId: remoteV4ResumeId(randomUUID(), 'thr_codex_0001'),
        executionBackend: validBackend,
        sessionIds: ['s1'],
        hasPersistedTurnActivity: async () => false,
      }),
    /CC5_BACKEND_REQUIRES_NEW_SESSION/,
  )

  // `createEngine` rejects authorityEngine != resolved engineId before touching filesystem!
  assert.throws(
    () =>
      createEngine('ccb', {
        peerId: 'p1',
        sessionKey,
        executionBackend: validBackend,
        agentId: 'main',
        agentBaseDir: '/tmp',
        model: 'gpt-5.4-remote',
        config: {} as any,
      }),
    /authorityEngine 'codex' != resolved engine 'ccb'/,
  )
})


test('driver fixture tears down a real listening relay when setup fails before adapter creation', async (t) => {
  let sandbox = ''
  await assert.rejects(createDriverHarness(t, 'codex', {
    afterRelayListen: (root) => { sandbox = root; throw new Error('fixture setup failure') },
  }), /fixture setup failure/)
  assert.ok(sandbox)
  // Registered after the harness's single cleanup: its real stop and close must finish first.
  t.after(async () => {
    assert.equal(existsSync(sandbox), false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(existsSync(sandbox), false)
  })
})
