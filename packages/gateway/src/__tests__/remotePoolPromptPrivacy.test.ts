/**
 * Production-entry end-to-end prompt privacy & warm app-recycle tests for `remote-driver-v4` (`C1-R4`).
 *
 * Exercises the FULL production gateway submission chain for BOTH `cc` (`authorityEngine: 'ccb'`)
 * and `codex` (`authorityEngine: 'codex'`):
 *   `SessionManager.getOrCreate` -> `createEngine` -> `RemoteEngineAdapter` ->
 *   `SessionManager.submit` (`prepareRunnerPromptPrivacy`, `restartRunnerForConfigChange`,
 *   `assertRunnerPromptPrivacyStopped`, `clearRunnerPromptPrivacy`) ->
 *   `RemoteContainerLane` (real `resolveEngineRemoteContextBuilder` + `fetchPlatformPromptBundle` +
 *   `buildPlatformSystemPrompt` + `cc5RemotePrompt`, NO `toolContextFactory` mock) ->
 *   `RemotePoolRelay` (`/recycle`, `/admit`, `reprovisionApp`, `openApp`, `resume_replay`) ->
 *   `RemotePoolSshHost.forLocalSandbox` -> `controller.py` -> `cc.py` / `codex.py` ->
 *   sandbox `fake-claude` (real `.jsonl` transcript check) & `fake-codex` (persistent rollout
 *   cumulative token replay on `thread/resume`).
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  parseRemoteDriverExecutionBackend,
  remoteCanonicalSha256,
  turnLeaseSigningInput,
  verifyAuthority,
  zeroCountersForUsagePolicy,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type PromptPrivacyPolicy,
  type RemoteReceiptV4,
  type TurnLease,
} from '@openclaude/protocol'
import type { OpenClaudeConfig } from '@openclaude/storage'

const testHome = mkdtempSync(join(tmpdir(), 'oc-rpool-privacy-home-'))
process.env.OPENCLAUDE_HOME = testHome
Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')

const { closeSessionsDb } = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { registerRemoteDriverAdapter } = await import('../engine/registry.js')
const {
  __resetIntelligentUiDesiredCacheForTests,
  __setIntelligentUiDesiredFetchForTests,
} = await import('../intelligentUiDesired.js')
const { setV3MasterSinkSingleton } = await import('../v3MasterSink.js')
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

function makeRealisticCcFixture(dir: string): { cliPath: string; launchesFile: string } {
  const launchesFile = join(dir, 'cc-launches.jsonl')
  const cliPath = writeExecutable(
    join(dir, 'fake-claude'),
    `#!/usr/bin/env python3
import hashlib, json, os, pathlib, re, subprocess, sys

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
prompt_text = pathlib.Path(prompt_file).read_text(encoding="utf-8") if prompt_file else ""

home_dir = pathlib.Path(os.environ.get("HOME", "/tmp"))
sanitized_cwd = re.sub(r"[^A-Za-z0-9]", "-", os.getcwd())
transcript_path = home_dir / ".claude/projects" / sanitized_cwd / f"{session_id}.jsonl"
if "--resume" in args:
    if not transcript_path.exists():
        sys.stderr.write("CC_RESUME_MISSING_TRANSCRIPT\\n")
        sys.exit(2)
elif "--session-id" in args:
    if transcript_path.exists():
        sys.stderr.write("CC_SESSION_ID_ALREADY_EXISTS\\n")
        sys.exit(2)
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.write_text(json.dumps({"sessionId": session_id}) + "\\n", encoding="utf-8")

with pathlib.Path(${JSON.stringify(launchesFile)}).open("a", encoding="utf-8") as lf:
    lf.write(json.dumps({
        "pid": os.getpid(),
        "args": args,
        "sessionId": session_id,
        "prompt": prompt_text,
    }) + "\\n")

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

local_seq = 0
for raw in sys.stdin:
    if not raw.strip():
        continue
    msg = json.loads(raw)
    if msg.get("type") != "user":
        continue
    local_seq += 1
    content = msg["message"]["content"]
    text = content if isinstance(content, str) else content[0]["text"]
    digest = hashlib.sha256(f"{os.getpid()}:{local_seq}:{text}".encode("utf-8")).hexdigest()[:14]
    call_id = f"toolu_cc_{digest}"
    res_id = f"res_cc_{digest}"
    tool_args = {"token": f"{text}:s{local_seq}"}

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
    # Intentionally start JSON-RPC id at local_seq (1 on every fresh CLI launch) to verify mcp_socket handles recycled MCP clients!
    mcp_req = {
        "jsonrpc": "2.0",
        "id": local_seq,
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
    sys.stdout.write(json.dumps({
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "session_id": session_id,
        "uuid": res_id,
        "usage": {
            "input_tokens": 110,
            "output_tokens": 40,
            "cache_read_input_tokens": 20,
            "cache_creation_input_tokens": 10,
        },
    }, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
`,
  )
  return { cliPath, launchesFile }
}

function makeRealisticCodexFixture(dir: string): { cliPath: string; rpcsFile: string } {
  const rpcsFile = join(dir, 'codex-rpcs.jsonl')
  const rolloutDir = join(dir, 'codex-rollouts')
  mkdirSync(rolloutDir, { recursive: true, mode: 0o700 })
  const cliPath = writeExecutable(
    join(dir, 'fake-codex'),
    `#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys

args = sys.argv[1:]
mcp_args = []
for i, a in enumerate(args):
    if a == "-c" and i + 1 < len(args):
        val = args[i + 1]
        if val.startswith("mcp_servers.ocbridge.args="):
            mcp_args = json.loads(val.split("=", 1)[1])

rollout_dir = pathlib.Path(${JSON.stringify(rolloutDir)})
rpcs_file = pathlib.Path(${JSON.stringify(rpcsFile)})
thread_id = "thr_codex_0001"
local_seq = 0
loaded_threads = set()
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
        tid = params.get("threadId") or thread_id
        thread_id = tid
        with rpcs_file.open("a", encoding="utf-8") as rf:
            rf.write(json.dumps({
                "pid": os.getpid(),
                "method": method,
                "threadId": tid,
                "baseInstructions": params.get("baseInstructions"),
            }) + "\\n")
        rollout_file = rollout_dir / f"{tid}.json"
        replayed = False
        if method == "thread/resume" and tid not in loaded_threads and rollout_file.exists():
            saved = json.loads(rollout_file.read_text(encoding="utf-8"))
            cum_in = int(saved["cum_in"])
            cum_cached = int(saved["cum_cached"])
            cum_out = int(saved["cum_out"])
            replayed = True
        loaded_threads.add(tid)
        sys.stdout.write(json.dumps({
            "id": rid,
            "result": {"thread": {"id": tid}, "model": params.get("model", "gpt-5.4")},
        }, separators=(",", ":")) + "\\n")
        # Real Codex 0.167 re-emits the rollout's cumulative tokenUsage on cold thread/resume without turnId!
        if replayed and (cum_in > 0 or cum_out > 0):
            sys.stdout.write(json.dumps({
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": tid,
                    "tokenUsage": {
                        "total": {
                            "totalTokens": cum_in + cum_out,
                            "inputTokens": cum_in,
                            "cachedInputTokens": cum_cached,
                            "outputTokens": cum_out,
                            "reasoningOutputTokens": 10,
                        }
                    },
                },
            }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
    elif method == "turn/start":
        local_seq += 1
        prompt_items = params.get("input") or []
        text = prompt_items[0].get("text", "") if prompt_items else ""
        digest = hashlib.sha256(f"{os.getpid()}:{local_seq}:{text}".encode("utf-8")).hexdigest()[:14]
        turn_id = f"turn_codex_{digest}"
        call_id = f"call_codex_{digest}"

        sys.stdout.write(json.dumps({"id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress"}}}, separators=(",", ":")) + "\\n")
        sys.stdout.write(json.dumps({
            "method": "turn/started",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "inProgress"}},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()

        tool_args = {"token": f"{text}:s{local_seq}"}
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
            "id": local_seq,
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
            "params": {"threadId": thread_id, "turnId": turn_id, "itemId": f"msg_{digest}", "delta": f"codex:{tool_text}"},
        }, separators=(",", ":")) + "\\n")

        step_uncached_in = 120
        step_cached_in = 30
        step_out = 55
        cum_in += step_uncached_in + step_cached_in
        cum_cached += step_cached_in
        cum_out += step_out
        (rollout_dir / f"{thread_id}.json").write_text(
            json.dumps({"cum_in": cum_in, "cum_cached": cum_cached, "cum_out": cum_out}),
            encoding="utf-8",
        )

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
        sys.stdout.write(json.dumps({
            "method": "turn/completed",
            "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}},
        }, separators=(",", ":")) + "\\n")
        sys.stdout.flush()
`,
  )
  return { cliPath, rpcsFile }
}

interface ProductionPrivacyHarness {
  readonly driverId: 'cc' | 'codex'
  readonly sm: InstanceType<typeof SessionManager>
  readonly session: Awaited<ReturnType<InstanceType<typeof SessionManager>['getOrCreate']>>
  readonly peerId: string
  readonly canonicalModel: string
  readonly relay: InstanceType<typeof RemotePoolRelay>
  readonly controlCalls: Array<{ path: string; body: Record<string, unknown> }>
  readonly executedTools: Array<{ name: string; token: string }>
  readonly settledReceipts: RemoteReceiptV4[]
  readonly ccLaunchesFile?: string
  readonly codexRpcsFile?: string
  setMasterPolicy: (policy: PromptPrivacyPolicy | 'http_503') => void
  setFailRecycle: (fail: boolean) => void
  setOnPrivacyFetch: (hook: (() => void) | undefined) => void
  submitUserTurn: (userText: string) => Promise<{ events: Array<Record<string, unknown>> }>
  readCcLaunches: () => Array<{ pid: number; args: string[]; sessionId: string; prompt: string }>
  readCodexRpcs: () => Array<{ pid: number; method: string; threadId: string; baseInstructions: string }>
}

async function createProductionPrivacyHarness(
  t: TestContext,
  driverId: 'cc' | 'codex',
): Promise<ProductionPrivacyHarness> {
  const sandbox = mkdtempSync(`/tmp/oc-drvtest-priv-${driverId}-`)
  const resRoot = join(sandbox, 'resources')
  const fakeSys = join(sandbox, 'fake-systemd')
  const containerExecRoot = join(sandbox, 'container-exec')
  const workspaceDir = join(sandbox, 'workspace')
  mkdirSync(containerExecRoot, { recursive: true, mode: 0o700 })
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })

  const envExtra: Record<string, string> = {
    OC_REMOTE_RESOURCE_ROOT: resRoot,
    OC_REMOTE_TEST_FAKE_SYSTEMD_DIR: fakeSys,
    OC_REMOTE_NODE_MEMORY_BUDGET: String(4096 * 1024 * 1024),
    OC_REMOTE_TEST_MEM_AVAILABLE_BYTES: String(4096 * 1024 * 1024),
  }

  let upstreamModel: string
  let canonicalModel: string
  let authorityEngine: 'ccb' | 'codex'
  let profileId: string
  let probeCtx: Record<string, unknown>
  let driverCtx: Record<string, unknown>
  let ccLaunchesFile: string | undefined
  let codexRpcsFile: string | undefined

  if (driverId === 'cc') {
    const fx = makeRealisticCcFixture(sandbox)
    ccLaunchesFile = fx.launchesFile
    upstreamModel = 'claude-sonnet-4-6'
    canonicalModel = 'claude-sonnet-4-6-remote'
    authorityEngine = 'ccb'
    profileId = 'ebc80fa6-0348-49a3-b1c1-8a08017114d6'
    probeCtx = { cliPath: fx.cliPath, accountHome: sandbox }
    driverCtx = {
      cliPath: fx.cliPath,
      accountHome: sandbox,
      bridgeMode: 'stdio-fixture',
      initialSessionUuid: '11111111-2222-4333-8444-555555555555',
    }
  } else {
    const fx = makeRealisticCodexFixture(sandbox)
    codexRpcsFile = fx.rpcsFile
    const codexHome = join(sandbox, 'codex-home')
    mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    writeFileSync(join(codexHome, 'auth.json'), '{"token":"redacted"}', { mode: 0o600 })
    upstreamModel = 'gpt-5.4'
    canonicalModel = 'gpt-5.4-remote'
    authorityEngine = 'codex'
    profileId = 'c240b4a0-4d0b-49e8-b5d4-77252377ad88'
    probeCtx = {
      cliPath: fx.cliPath,
      nativePath: fx.cliPath,
      codexHome,
      systemCodexRoot: join(sandbox, 'empty-etc-codex'),
    }
    driverCtx = { ...probeCtx }
  }

  const worker = new DriverWorkerClient()
  const workerInfo = await worker.info(driverId)

  const operationId = randomUUID()
  const runId = randomUUID()
  const peerId = `peer_${driverId}_${operationId.slice(0, 8)}`
  const sessionKey = `agent:main:webchat:dm:${peerId}`
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
      observedAt: '2026-11-12T00:00:00Z',
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
  const keyId = 'v4-privacy-key'
  const keys: AuthorityKeyring = new Map([
    [keyId, new Uint8Array(Buffer.from(kp.publicKey.export({ format: 'jwk' }).x!, 'base64url'))],
  ])

  const settledReceipts: RemoteReceiptV4[] = []
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
        stop: async () => {},
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
    observationOptions: { authorizeTimeoutMs: 600 },
  })

  const socketPath = join(sandbox, 'relay.sock')
  relay.controlServer.listen(socketPath)
  await once(relay.controlServer, 'listening')

  const controlCalls: Array<{ path: string; body: Record<string, unknown> }> = []
  let failRecycle = false

  const executedTools: Array<{ name: string; token: string }> = []
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
    execute: async (name, rawArgs) => {
      const token = String((rawArgs as Record<string, unknown>).token ?? '')
      executedTools.push({ name, token })
      return {
        content: [{ type: 'text', text: `SENTINEL_OK(${token})` }],
        isError: false,
      }
    },
    close: async () => {},
  })

  laneOverridesByOpId.set(operationId, {
    binding,
    socketPath,
    keyring: keys,
    executionRoot: containerExecRoot,
    hostFactory,
    call: async (path, body) => {
      controlCalls.push({ path, body: structuredClone(body) as Record<string, unknown> })
      if (path === '/recycle' && failRecycle) {
        throw new Error('SYNTHETIC_RECYCLE_TRANSPORT_FAILURE')
      }
      return remotePoolControlRequest(path, body, socketPath)
    },
    toolAuthorizeTimeoutMs: 600,
  })

  // Set up in-process master HTTP server serving `/internal/v3/marketplace/sync` and `/internal/v3/platform-prompt-slots`!
  let currentPolicy: PromptPrivacyPolicy | 'http_503' = { schemaVersion: 1, profile: null }
  let onPrivacyFetch: (() => void) | undefined
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
      onPrivacyFetch?.()
      if (currentPolicy === 'http_503') {
        res.statusCode = 503
        res.end('service unavailable')
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ slots: [], promptPolicy: currentPolicy }))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => masterServer.listen(0, '127.0.0.1', resolve))
  const masterPort = (masterServer.address() as { port: number }).port

  const prevEnv = {
    OPENCLAUDE_V3_MASTER_BASE_URL: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
    OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
    OC_USER_ID: process.env.OC_USER_ID,
  }
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${masterPort}`
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'synthetic-v4-privacy-token'
  process.env.OC_USER_ID = '3'
  setV3MasterSinkSingleton({
    persistOrQueue: async () => ({ ok: true }),
    attemptOnce: async () => {},
  })

  const config = {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.3-zai' },
    mcpServers: [],
  } as unknown as OpenClaudeConfig

  const sm = new SessionManager(config)
  const session = await sm.getOrCreate({
    sessionKey,
    peerId,
    userId: '3',
    agent: { id: 'main', model: canonicalModel, cwd: workspaceDir },
    model: canonicalModel,
    executionAuthority: {
      source: 'bridge_signed',
      engine: authorityEngine,
      canonicalModel,
      executionBackend: remotePoolBackendOf(binding),
    },
    workspaceCwd: workspaceDir,
  })
  assert.ok(session.runner instanceof RemoteEngineAdapter, 'SessionManager.getOrCreate must construct RemoteEngineAdapter')

  t.after(async () => {
    laneOverridesByOpId.delete(operationId)
    await sm.shutdownAll().catch(() => {})
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = v
    }
    setV3MasterSinkSingleton(null)
    await relay.stop().catch(() => {})
    await new Promise<void>((resolve) => {
      relay.controlServer.closeAllConnections()
      relay.controlServer.close(() => resolve())
    })
    await worker.close().catch(() => {})
    await new Promise<void>((resolve) => {
      masterServer.closeAllConnections()
      masterServer.close(() => resolve())
    })
    rmSync(sandbox, { recursive: true, force: true })
  })

  let turnSeq = 0
  const submitUserTurn = async (userText: string) => {
    turnSeq += 1
    const issuedAt = Date.now()
    const authorityTurnId = createHash('md5')
      .update(`${driverId}:priv:${operationId}:${turnSeq}`)
      .digest('hex')
    const requestId = createHash('md5').update(`req:${authorityTurnId}`).digest('hex')
    const payload: ModelAuthorityPayload = {
      v: 1,
      keyId,
      uid: 3,
      containerId: 7,
      authorityTurnId,
      ...(authorityEngine === 'codex' ? { billingRequestId: requestId } : {}),
      connectionChallenge: 'challenge-priv',
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
      connectionChallenge: 'challenge-priv',
      canonicalModel,
      securityEpoch: 1,
      issuedAt,
      expiresAt: issuedAt + 600_000,
    }
    const authorityEnvelope = encodeAuthorityEnvelope(
      payload,
      sign(null, authoritySigningInput(payload), kp.privateKey),
    )
    const leaseEnvelope = encodeTurnLeaseEnvelope(
      leasePayload,
      sign(null, turnLeaseSigningInput(leasePayload), kp.privateKey),
    )

    const events: Array<Record<string, unknown>> = []
    await sm.submit(
      session,
      userText,
      (ev) => events.push(ev as unknown as Record<string, unknown>),
      'medium',
      canonicalModel,
      requestId,
      `trace-priv-${turnSeq}`,
      undefined,
      {
        modelAuthority: {
          authorityEnvelope,
          leaseEnvelope,
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
      },
    )
    return { events }
  }

  const readCcLaunches = () => {
    if (!ccLaunchesFile) return []
    try {
      return readFileSync(ccLaunchesFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { pid: number; args: string[]; sessionId: string; prompt: string })
    } catch {
      return []
    }
  }

  const readCodexRpcs = () => {
    if (!codexRpcsFile) return []
    try {
      return readFileSync(codexRpcsFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { pid: number; method: string; threadId: string; baseInstructions: string })
    } catch {
      return []
    }
  }

  return {
    driverId,
    sm,
    session,
    peerId,
    canonicalModel,
    relay,
    controlCalls,
    executedTools,
    settledReceipts,
    ccLaunchesFile,
    codexRpcsFile,
    setMasterPolicy: (policy) => {
      currentPolicy = policy
    },
    setFailRecycle: (fail) => {
      failRecycle = fail
    },
    setOnPrivacyFetch: (hook) => {
      onPrivacyFetch = hook
    },
    submitUserTurn,
    readCcLaunches,
    readCodexRpcs,
  }
}

for (const driverId of ['cc', 'codex'] as const) {
  test(
    `[${driverId}] SessionManager.submit enforces 4-turn consent grant -> revoke -> modify -> unchanged reuse on warm v4 lane`,
    { timeout: 60_000 },
    async (t) => {
      const h = await createProductionPrivacyHarness(t, driverId)

      // Turn 1: Consent granted (`SYNTH_NICK_ALPHA`)
      h.setMasterPolicy({
        schemaVersion: 1,
        profile: { nickname: 'SYNTH_NICK_ALPHA', sessionId: h.peerId },
      })
      await h.submitUserTurn('MSG_TURN_1')
      const turn1NativeId = h.session.runner.nativeSessionId
      assert.ok(turn1NativeId?.startsWith('remotev4:'), 'Turn 1 must bind remotev4 nativeSessionId')

      const admit1 = h.controlCalls.filter((c) => c.path === '/admit')[0]!
      assert.ok(admit1, 'Turn 1 must call /admit')
      assert.ok(String(admit1.body.instructions).includes('SYNTH_NICK_ALPHA'), 'Turn 1 /admit must carry SYNTH_NICK_ALPHA')
      assert.ok(String(admit1.body.instructions).includes('<tool-naming>'), 'Turn 1 /admit must carry <tool-naming>')

      // Turn 2 (warm lane): Consent REVOKED (`profile: null`) — MUST recycle remote app & purge `SYNTH_NICK_ALPHA`!
      h.setMasterPolicy({ schemaVersion: 1, profile: null })
      // Reopening a warm session may request preheat before the next user turn. Remote
      // admission is lazy: preheat must not run the legacy privacy shutdown path and
      // permanently close this lane (N1-R5).
      const preheatOutcome = await h.sm.preheatRunner(h.session)
      const recyclesBeforeTurn2 = h.controlCalls.filter((c) => c.path === '/recycle').length
      await h.submitUserTurn('MSG_TURN_2')
      assert.equal(preheatOutcome, 'skipped_engine', 'Remote lane must decline eager preheat')
      const recyclesAfterTurn2 = h.controlCalls.filter((c) => c.path === '/recycle').length
      assert.equal(recyclesAfterTurn2, recyclesBeforeTurn2 + 1, 'Turn 2 revocation MUST invoke /recycle exactly once')
      assert.equal(h.session.runner.nativeSessionId, turn1NativeId, 'Turn 2 MUST preserve exact same nativeSessionId')

      const admit2 = h.controlCalls.filter((c) => c.path === '/admit')[1]!
      assert.ok(!String(admit2.body.instructions).includes('SYNTH_NICK_ALPHA'), 'Turn 2 /admit MUST NOT contain revoked SYNTH_NICK_ALPHA')
      assert.ok(String(admit2.body.instructions).includes('<tool-naming>'), 'Turn 2 /admit must preserve <tool-naming>')

      // Turn 3 (warm lane): Consent MODIFIED (`SYNTH_NICK_BETA`) — MUST recycle remote app & inject `SYNTH_NICK_BETA`!
      h.setMasterPolicy({
        schemaVersion: 1,
        profile: { nickname: 'SYNTH_NICK_BETA', sessionId: h.peerId },
      })
      await h.submitUserTurn('MSG_TURN_3')
      const recyclesAfterTurn3 = h.controlCalls.filter((c) => c.path === '/recycle').length
      assert.equal(recyclesAfterTurn3, recyclesAfterTurn2 + 1, 'Turn 3 modification MUST invoke /recycle')
      assert.equal(h.session.runner.nativeSessionId, turn1NativeId, 'Turn 3 MUST preserve exact same nativeSessionId')

      const admit3 = h.controlCalls.filter((c) => c.path === '/admit')[2]!
      assert.ok(String(admit3.body.instructions).includes('SYNTH_NICK_BETA'), 'Turn 3 /admit MUST contain SYNTH_NICK_BETA')
      assert.ok(!String(admit3.body.instructions).includes('SYNTH_NICK_ALPHA'), 'Turn 3 /admit MUST NOT contain SYNTH_NICK_ALPHA')

      // Turn 4 (warm lane): Consent UNCHANGED (`SYNTH_NICK_BETA`) — MUST reuse warm process with ZERO `/recycle`!
      await h.submitUserTurn('MSG_TURN_4')
      const recyclesAfterTurn4 = h.controlCalls.filter((c) => c.path === '/recycle').length
      assert.equal(recyclesAfterTurn4, recyclesAfterTurn3, 'Turn 4 unchanged consent MUST NOT invoke /recycle')
      assert.equal(h.session.runner.nativeSessionId, turn1NativeId, 'Turn 4 MUST preserve exact same nativeSessionId')

      // Verify all 4 turns executed container tools and settled receipts!
      assert.equal(h.executedTools.length, 4, 'All 4 turns must execute real container tools over kept-alive tool-socket')
      assert.equal(h.settledReceipts.length, 4, 'All 4 turns must settle billing receipts')

      // Verify CLI-observed system prompts on the remote node!
      if (driverId === 'cc') {
        const launches = h.readCcLaunches()
        assert.equal(launches.length, 3, 'cc must spawn 3 times across 4 turns (Turn 4 reuses Launch 3 warm process)')
        assert.ok(launches[0]!.args.includes('--session-id'), 'Launch 1 must use --session-id')
        assert.ok(launches[0]!.prompt.includes('SYNTH_NICK_ALPHA'), 'Launch 1 prompt.md must contain SYNTH_NICK_ALPHA')

        assert.ok(launches[1]!.args.includes('--resume'), 'Launch 2 must use --resume against Turn 1 transcript')
        assert.equal(launches[1]!.sessionId, launches[0]!.sessionId)
        assert.notEqual(launches[1]!.pid, launches[0]!.pid, 'Launch 2 must run in a freshly spawned CLI process')
        assert.ok(!launches[1]!.prompt.includes('SYNTH_NICK_ALPHA'), 'Launch 2 prompt.md MUST NOT contain revoked SYNTH_NICK_ALPHA')

        assert.ok(launches[2]!.args.includes('--resume'), 'Launch 3 must use --resume')
        assert.equal(launches[2]!.sessionId, launches[0]!.sessionId)
        assert.notEqual(launches[2]!.pid, launches[1]!.pid, 'Launch 3 must run in a freshly spawned CLI process')
        assert.ok(launches[2]!.prompt.includes('SYNTH_NICK_BETA'), 'Launch 3 prompt.md MUST contain SYNTH_NICK_BETA')
        assert.ok(!launches[2]!.prompt.includes('SYNTH_NICK_ALPHA'), 'Launch 3 prompt.md MUST NOT contain SYNTH_NICK_ALPHA')
      } else {
        const rpcs = h.readCodexRpcs()
        assert.equal(rpcs.length, 3, 'codex must load thread 3 times across 4 turns (Turn 4 reuses already-loaded thread)')
        assert.equal(rpcs[0]!.method, 'thread/start')
        assert.ok(rpcs[0]!.baseInstructions.includes('SYNTH_NICK_ALPHA'), 'Launch 1 thread/start must carry SYNTH_NICK_ALPHA')

        assert.equal(rpcs[1]!.method, 'thread/resume')
        assert.equal(rpcs[1]!.threadId, rpcs[0]!.threadId)
        assert.notEqual(rpcs[1]!.pid, rpcs[0]!.pid, 'Launch 2 thread/resume must run on a freshly spawned app-server PID')
        assert.ok(!rpcs[1]!.baseInstructions.includes('SYNTH_NICK_ALPHA'), 'Launch 2 thread/resume MUST NOT contain revoked SYNTH_NICK_ALPHA')

        assert.equal(rpcs[2]!.method, 'thread/resume')
        assert.equal(rpcs[2]!.threadId, rpcs[0]!.threadId)
        assert.notEqual(rpcs[2]!.pid, rpcs[1]!.pid, 'Launch 3 thread/resume must run on a freshly spawned app-server PID')
        assert.ok(rpcs[2]!.baseInstructions.includes('SYNTH_NICK_BETA'), 'Launch 3 thread/resume MUST contain SYNTH_NICK_BETA')
        assert.ok(!rpcs[2]!.baseInstructions.includes('SYNTH_NICK_ALPHA'), 'Launch 3 thread/resume MUST NOT contain SYNTH_NICK_ALPHA')

        // Verify Codex cumulative delta stayed exact across `resume_replay` on recycled processes!
        for (const [idx, rec] of h.settledReceipts.entries()) {
          assert.deepEqual(
            rec.usage,
            { inputTokens: 120, outputTokens: 55, cacheReadTokens: 30, cacheWriteTokens: 0 },
            `Codex Turn ${idx + 1} delta usage must stay exact across rollout resume_replay`,
          )
        }
      }
    },
  )

  test(
    `[${driverId}] fail-closed red controls: master 503 + recovery, recycle failure, and user interrupt before admit`,
    { timeout: 60_000 },
    async (t) => {
      const h = await createProductionPrivacyHarness(t, driverId)

      // Establish warm Turn 1 with `SYNTH_NICK_ALPHA`
      h.setMasterPolicy({
        schemaVersion: 1,
        profile: { nickname: 'SYNTH_NICK_ALPHA', sessionId: h.peerId },
      })
      await h.submitUserTurn('WARMUP_ALPHA')
      assert.equal(h.controlCalls.filter((c) => c.path === '/admit').length, 1)
      assert.equal(h.executedTools.length, 1)

      // Red Control A: Master `/internal/v3/platform-prompt-slots` returns 503 on warm Turn 2 ->
      // MUST fail closed BEFORE `/recycle` and BEFORE `/admit`, never resending cached `SYNTH_NICK_ALPHA`!
      h.setMasterPolicy('http_503')
      await assert.rejects(
        () => h.submitUserTurn('SHOULD_REJECT_503'),
        /暂时无法核验助手隐私设置/,
      )
      assert.equal(h.controlCalls.filter((c) => c.path === '/admit').length, 1, '503 must not reach /admit')
      assert.equal(h.controlCalls.filter((c) => c.path === '/recycle').length, 0, '503 must not mutate or recycle warm runner before policy is known')
      assert.equal(h.executedTools.length, 1, '503 must execute zero tools')

      // Red Control B: Master recovers with `profile: null`, but `/recycle` fails ->
      // MUST throw `助手隐私设置尚未生效` BEFORE `/admit`!
      h.setMasterPolicy({ schemaVersion: 1, profile: null })
      h.setFailRecycle(true)
      await assert.rejects(
        () => h.submitUserTurn('SHOULD_REJECT_UNSTOPPED'),
        /助手隐私设置尚未生效，本轮未发送/,
      )
      assert.equal(h.controlCalls.filter((c) => c.path === '/recycle').length, 1, 'Recycle was attempted once')
      assert.equal(h.controlCalls.filter((c) => c.path === '/admit').length, 1, 'Failed recycle MUST NOT reach /admit')
      assert.equal(h.executedTools.length, 1, 'Failed recycle MUST execute zero tools')

      // Recovery after transient `/recycle` transport failure: re-enable `/recycle` ->
      // retry STILL knows privacyChanged === true, recycles warm app, and purges `SYNTH_NICK_ALPHA`!
      h.setFailRecycle(false)
      await h.submitUserTurn('RECOVERED_AFTER_RECYCLE')
      assert.equal(h.controlCalls.filter((c) => c.path === '/recycle').length, 2, 'Retry must run real /recycle')
      assert.equal(h.controlCalls.filter((c) => c.path === '/admit').length, 2)
      const recoveredAdmit = h.controlCalls.filter((c) => c.path === '/admit')[1]!
      assert.ok(
        !String(recoveredAdmit.body.instructions).includes('SYNTH_NICK_ALPHA'),
        'Recovered Turn 2 MUST purge SYNTH_NICK_ALPHA',
      )
      assert.equal(h.executedTools.length, 2)

      // Red Control C: Concurrent user interrupt (`sm.interrupt`) during privacy metadata fetch ->
      // MUST abort BEFORE `/admit` with zero model invocations!
      let interruptedDuringFetch = false
      h.setMasterPolicy({
        schemaVersion: 1,
        profile: { nickname: 'SYNTH_NICK_GAMMA', sessionId: h.peerId },
      })
      h.setOnPrivacyFetch(() => {
        if (!interruptedDuringFetch) {
          interruptedDuringFetch = true
          h.sm.interrupt(h.session.sessionKey, 'user')
        }
      })
      await h.submitUserTurn('INTERRUPTED_AT_PRIVACY_FETCH').catch(() => {})
      h.setOnPrivacyFetch(undefined)
      assert.equal(interruptedDuringFetch, true)
      assert.equal(
        h.controlCalls.filter((c) => c.path === '/admit').length,
        2,
        'Interrupted turn during privacy fetch MUST NOT reach /admit',
      )
      assert.equal(h.executedTools.length, 2, 'Interrupted turn MUST execute zero tools')
    },
  )
}
