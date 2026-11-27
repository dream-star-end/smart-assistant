#!/usr/bin/env npx tsx
/**
 * OCV5-915 P3-2 — Sandbox Red Proof v2 live generator & verifier (R1..R11).
 *
 * Exercises live fail-closed red/green controls across Layer 3 ToolBrokerServer,
 * ExecEnvHandle.openChannel('tool-broker'), loopback HTTP/WS anti-bypass isolation,
 * single-use `octk1.*` replay/mismatch enforcement, Antigravity `PreToolUse` hook,
 * `>256 KiB` disk spill & verification, 55s blocking-then-detached approval single-flight,
 * and fencing/brainGen kill semantics.
 *
 * Usage:
 *   npx tsx scripts/v5-generate-sandbox-red-proof-v2.ts --verify
 *   npx tsx scripts/v5-generate-sandbox-red-proof-v2.ts --out /tmp/sandbox-red-proof-v2.json
 */
import { execFile } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SANDBOX_RED_CONTROL_IDS,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  remoteCanonicalSha256,
  validateExecutionPolicyEnvelope,
  type SandboxRedControlId,
  type ToolCallEnvelope,
} from '@openclaude/protocol'
import {
  TOOL_BROKER_LOCAL_PREFIX,
  createInMemoryFrameLinkPair,
} from '@openclaude/protocol/exec-env'
import {
  GatewayToolBrokerRuntime,
  type ToolBrokerApprovalBridge,
} from '../packages/gateway/src/toolBrokerRuntime.js'
import {
  TOOL_BROKER_CAPABILITY_HEADER,
  TOOL_BROKER_HOOK_TOKEN_HEADER,
  TOOL_BROKER_MCP_TOKEN_HEADER,
  handleToolBrokerLocalHttp,
} from '../packages/gateway/src/routes/toolBrokerLocalRoute.js'
import {
  ContainerLinkToolBrokerHost,
  TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS,
  createLiveExecEnvHandle,
} from '../packages/gateway/src/execEnv/index.js'
import { installAntigravityBrokerHook } from '../packages/gateway/src/engine/antigravityBrokerHook.js'
import type { LoadedActionPolicy } from '../packages/gateway/src/actionPolicyEngine.js'

export interface SandboxRedControlEvidence {
  readonly requirementId: SandboxRedControlId
  readonly redEnvironment: 'live-tool-broker-fault-injection'
  readonly redControlCaught: boolean
  readonly greenPassed: boolean
  readonly injectedFault: string
  readonly observedRedCode: string
}

export interface SandboxRedProofV2Artifact {
  readonly schemaVersion: 2
  readonly controlIds: readonly SandboxRedControlId[]
  readonly allRedControlsCaught: boolean
  readonly allGreenPassed: boolean
  readonly controls: readonly SandboxRedControlEvidence[]
  readonly proofSha256: string
}

function readReqBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.byteLength
      if (total > maxBytes) { rejectBody(new Error('body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const payload = JSON.stringify(body)
  return new Promise((resolveRes, rejectRes) => {
    const req = httpRequest(
      url,
      { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), Connection: 'close', ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: Record<string, unknown> = {}
          try {
            const raw: unknown = JSON.parse(text)
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, unknown>
          } catch (err) { void err }
          resolveRes({ status: res.statusCode ?? 0, json: parsed })
        })
      },
    )
    req.on('error', rejectRes)
    req.end(payload)
  })
}

function runPythonHook(pythonBin: string, scriptPath: string, stdinJson: string): Promise<{ decision: string; reason?: string }> {
  return new Promise((resolveOut, rejectOut) => {
    const child = execFile(pythonBin, ['-I', '-B', scriptPath], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) { rejectOut(new Error(`python hook failed: ${err.message} stderr=${stderr}`)); return }
      resolveOut(JSON.parse(stdout.trim()) as { decision: string; reason?: string })
    })
    child.stdin?.end(stdinJson)
  })
}

function buildEnvelope(input: {
  readonly leaseId: string
  readonly turnId: string
  readonly callId: string
  readonly canonicalName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly overrideArgsSha256?: string
}): ToolCallEnvelope {
  const argsSha256 = input.overrideArgsSha256 ?? computeSchemaFilteredArgsSha256(input.arguments, null)
  return {
    schemaVersion: 1,
    leaseId: input.leaseId,
    turnId: input.turnId,
    callId: input.callId,
    idempotencyKey: computeToolIdempotencyKey(input.leaseId, input.turnId, input.callId),
    canonicalName: input.canonicalName,
    arguments: input.arguments,
    argsSha256,
    attestation: { kind: 'gateway_signed_grant', argsSha256, observedAt: new Date(0).toISOString(), grantId: 'redproof-v2' },
  }
}

export async function runSandboxRedProofV2(): Promise<SandboxRedProofV2Artifact> {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-red-proof-v2-'))
  let httpServer: ReturnType<typeof createServer> | null = null
  let runtime: GatewayToolBrokerRuntime | null = null

  try {
    const openedCards: string[] = []
    const detachedCards: string[] = []
    let nextCardOpenedResolve: ((reqId: string) => void) | null = null
    const approvalBridge: ToolBrokerApprovalBridge = {
      openApprovalCard(ctx) {
        openedCards.push(ctx.requestId)
        if (nextCardOpenedResolve) {
          const fn = nextCardOpenedResolve
          nextCardOpenedResolve = null
          fn(ctx.requestId)
        }
      },
      markDetachedCard(card) { detachedCards.push(card.requestId) },
    }

    const testPolicy: LoadedActionPolicy = {
      ok: true,
      source: 'default',
      path: '<red-proof-v2>',
      policy: {
        version: 1,
        defaultTier: 'allow',
        extendsDefaults: false,
        rules: [
          {
            id: 'r10-approval-tool',
            category: 'custom',
            tier: 'human_approval',
            reason: 'Red proof R10 approval gate',
            match: { tool: ['r10_guarded_write'] },
          },
        ],
      },
      warnings: [],
    }

    runtime = new GatewayToolBrokerRuntime({
      homeDir: workDir,
      loadedActionPolicy: testPolicy,
      detachedFallbackAfterMs: 120,
      approvalBridge,
      baseToolEnv: {
        HOME: workDir,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN: 'octh1.leaked_secret_must_be_scrubbed',
        OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: 'octm1.leaked_secret_must_be_scrubbed',
        OC_TOOL_BROKER_INTERNAL: 'secret',
      },
    })

    let r4aExecCount = 0
    let r10ExecCount = 0
    let r11ExecCount = 0
    const spillText = 'X'.repeat(300 * 1024)
    let r4bStartedResolve: (() => void) | null = null
    const r4bStarted = new Promise<void>((res) => { r4bStartedResolve = res })

    runtime.registerTool({ canonicalName: 'rp_echo', readOnly: true, handler: async (args) => ({ echo: args.msg ?? '' }) })
    runtime.registerTool({ canonicalName: 'rp_write', readOnly: false, handler: async (args) => { r4aExecCount += 1; return { wrote: args.path ?? 'ok', count: r4aExecCount } } })
    runtime.registerTool({
      canonicalName: 'rp_slow_write', readOnly: false,
      handler: async (_args, ctx) => {
        r4bStartedResolve?.()
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 5_000)
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }, { once: true })
        })
        return 'finished'
      },
    })
    runtime.registerTool({ canonicalName: 'rp_big_output', readOnly: true, handler: async () => spillText })
    runtime.registerTool({ canonicalName: 'r10_guarded_write', readOnly: false, handler: async () => { r10ExecCount += 1; return { ok: true } } })
    runtime.registerTool({ canonicalName: 'rp_fenced', readOnly: true, handler: async () => { r11ExecCount += 1; return 'fenced-ok' } })

    const activeRuntime = runtime
    httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void handleToolBrokerLocalHttp({
        req,
        res,
        url,
        readBody: readReqBody,
        sendJson: (r, code, body) => {
          r.writeHead(code, { 'Content-Type': 'application/json' })
          r.end(JSON.stringify(body))
        },
        runtime: activeRuntime,
      })
    })
    await new Promise<void>((res) => httpServer!.listen(0, '127.0.0.1', () => res()))
    const port = (httpServer.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`

    const controls: SandboxRedControlEvidence[] = []
    const sessionKey = 'agent:main:webchat:dm:redproof-v2'
    const lease = runtime.ensureSessionLease(sessionKey, { mode: 'normal' })

    // R1: Attestation / schema-filtered argsSha256 mismatch vs valid
    const r1BadCall = buildEnvelope({ leaseId: lease.leaseId, turnId: 't1', callId: 'c-r1-bad', canonicalName: 'rp_echo', arguments: { msg: 'hi' }, overrideArgsSha256: '0'.repeat(64) })
    const r1BadTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r1-bad', toolName: 'rp_echo' })
    const r1Bad = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r1BadTok.token }, { call: r1BadCall, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r1GoodCall = buildEnvelope({ leaseId: lease.leaseId, turnId: 't1', callId: 'c-r1-ok', canonicalName: 'rp_echo', arguments: { msg: 'hi' } })
    const r1GoodTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r1-ok', toolName: 'rp_echo' })
    const r1Good = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r1GoodTok.token }, { call: r1GoodCall, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    controls.push({
      requirementId: 'R1', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r1Bad.status === 403 && r1Bad.json.errorCode === 'TOOL_ARGS_SCHEMA_HASH_MISMATCH',
      greenPassed: r1Good.status === 200 && r1Good.json.ok === true,
      injectedFault: 'tampered_args_sha256', observedRedCode: String(r1Bad.json.errorCode ?? r1Bad.status),
    })

    // R2: Read-only enforcement (blocks write, allows read_file + search_extra_tools + mcp_openclaude-memory_oc_grep)
    const roSession = 'agent:main:webchat:dm:redproof-ro'
    const roHook = runtime.issueTurnHookToken({ sessionKey: roSession, mode: 'read_only' })
    const r2Red = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: roHook.token }, { toolName: 'write_file', arguments: { Path: '/tmp/x' } })
    const r2Green1 = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: roHook.token }, { toolName: 'mcp_openclaude-memory_oc_grep', arguments: { pattern: 'foo' } })
    const r2Green2 = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: roHook.token }, { toolName: 'search_extra_tools', arguments: {} })
    controls.push({
      requirementId: 'R2', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r2Red.json.decision === 'deny' && r2Red.json.code === 'EXEC_POLICY_READ_ONLY_DENIED',
      greenPassed: r2Green1.json.decision === 'allow' && r2Green2.json.decision === 'allow',
      injectedFault: 'read_only_write_mutation', observedRedCode: String(r2Red.json.code ?? r2Red.status),
    })

    // R3: Monotonic policy tightening (downgrade rejected + hermetic blocks all)
    const r3Session = 'agent:main:webchat:dm:redproof-r3'
    runtime.tightenSessionMode(r3Session, 'read_only')
    let r3DowngradeCode = ''
    try {
      runtime.setSessionPolicy(r3Session, validateExecutionPolicyEnvelope({ schemaVersion: 1, mode: 'normal', allowedTools: [], allowNetworkEgress: true, allowWorkspaceWrite: true, allowSubprocessSpawn: true }))
    } catch (err) { r3DowngradeCode = (err as { code?: string }).code ?? 'ERR' }
    runtime.tightenSessionMode(r3Session, 'hermetic_no_tools')
    const r3Hook = runtime.issueTurnHookToken({ sessionKey: r3Session, mode: 'hermetic_no_tools' })
    const r3Hermetic = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: r3Hook.token }, { toolName: 'read_file', arguments: {} })
    controls.push({
      requirementId: 'R3', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r3DowngradeCode === 'EXEC_POLICY_RELAXATION_FORBIDDEN' && r3Hermetic.json.code === 'EXEC_POLICY_HERMETIC_NO_TOOLS',
      greenPassed: runtime.server.getPolicy(runtime.ensureSessionLease(r3Session).leaseId)?.mode === 'hermetic_no_tools',
      injectedFault: 'monotonic_policy_downgrade_and_hermetic_call', observedRedCode: `${r3DowngradeCode}|${String(r3Hermetic.json.code)}`,
    })

    // R4a: Idempotency receipt replay without double side-effects
    const r4aCall = buildEnvelope({ leaseId: lease.leaseId, turnId: 't4a', callId: 'c-r4a', canonicalName: 'rp_write', arguments: { path: 'a.txt' } })
    const r4aTok1 = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r4a', toolName: 'rp_write' })
    const r4aFirst = await runtime.server.invoke({ ...r4aCall, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: r4aTok1.token })
    const r4aTok2 = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r4a', toolName: 'rp_write' })
    const r4aSecond = await runtime.server.invoke({ ...r4aCall, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: r4aTok2.token })
    controls.push({
      requirementId: 'R4a', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r4aSecond.replayStatus === 'cached_receipt' && r4aExecCount === 1,
      greenPassed: r4aFirst.status === 'ok' && r4aFirst.replayStatus === 'executed',
      injectedFault: 'duplicate_idempotency_key_replay', observedRedCode: String(r4aSecond.replayStatus),
    })

    // R4b: Disconnect in-flight side-effect -> unknown_effect_fenced on retry
    const r4bSession = 'agent:main:webchat:dm:redproof-r4b'
    const r4bLease = runtime.ensureSessionLease(r4bSession)
    const r4bCall = buildEnvelope({ leaseId: r4bLease.leaseId, turnId: 't4b', callId: 'c-r4b', canonicalName: 'rp_slow_write', arguments: {} })
    const r4bTok1 = runtime.issueSingleUseCapabilityToken({ sessionKey: r4bSession, callId: 'c-r4b', toolName: 'rp_slow_write' })
    const r4bInFlight = runtime.server.invoke({ ...r4bCall, fencingToken: r4bLease.fencingToken, brainGen: r4bLease.brainGen, sessionKey: r4bSession, capabilityToken: r4bTok1.token })
    await r4bStarted
    runtime.server.markLeaseDisconnected(r4bLease.leaseId, 'redproof_disconnect')
    await r4bInFlight
    const r4bTok2 = runtime.issueSingleUseCapabilityToken({ sessionKey: r4bSession, callId: 'c-r4b', toolName: 'rp_slow_write' })
    const r4bRetry = await runtime.server.invoke({ ...r4bCall, fencingToken: r4bLease.fencingToken, brainGen: r4bLease.brainGen, sessionKey: r4bSession, capabilityToken: r4bTok2.token })
    controls.push({
      requirementId: 'R4b', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r4bRetry.replayStatus === 'unknown_effect_fenced' && r4bRetry.errorCode === 'UNKNOWN_EFFECT_FENCED',
      greenPassed: r4bRetry.status === 'error',
      injectedFault: 'disconnect_inflight_unknown_effect_replay', observedRedCode: String(r4bRetry.errorCode ?? r4bRetry.replayStatus),
    })

    // R5: Antigravity PreToolUse real python3 hook fail-closed + live broker allow
    const hookLaunch = join(workDir, 'agy-hook-launch')
    const hookCfgDir = join(hookLaunch, '.gemini', 'config')
    await mkdir(hookCfgDir, { recursive: true })
    const r5NormalHook = runtime.issueTurnHookToken({ sessionKey, mode: 'normal' })
    const r5Artifacts = installAntigravityBrokerHook({ launchHome: hookLaunch, configDir: hookCfgDir, mode: 'read_only', brokerUrl: baseUrl, hookToken: r5NormalHook.token })
    const r5DenyWrite = await runPythonHook(r5Artifacts.pythonBin, r5Artifacts.guardScriptPath, JSON.stringify({ toolCall: { name: 'write_file' } }))
    const r5DenyBadJson = await runPythonHook(r5Artifacts.pythonBin, r5Artifacts.guardScriptPath, '{bad')
    const r5AllowRead = await runPythonHook(r5Artifacts.pythonBin, r5Artifacts.guardScriptPath, JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/tmp/a' } } }))
    controls.push({
      requirementId: 'R5', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r5DenyWrite.decision === 'deny' && r5DenyBadJson.decision === 'deny',
      greenPassed: r5AllowRead.decision === 'allow' && r5Artifacts.timeoutSec === 65,
      injectedFault: 'antigravity_pretool_write_and_malformed_json', observedRedCode: `${r5DenyWrite.reason}|${r5DenyBadJson.reason}`,
    })

    // R6: Child subprocess broker env secret scrubbing
    const r6Mcp = runtime.issueTurnMcpToken({ sessionKey, mode: 'normal' })
    const r6Res = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: r6Mcp.token }, { toolName: 'oc_bash', arguments: { command: 'env | grep -E "OPENCLAUDE_TOOL_BROKER_|OC_TOOL_BROKER_" || echo CLEAN' } })
    const r6RawOut = (r6Res.json.result as { output?: unknown } | undefined)?.output
    const r6Out = typeof r6RawOut === 'string'
      ? r6RawOut
      : r6RawOut && typeof r6RawOut === 'object' && typeof (r6RawOut as { text?: unknown }).text === 'string'
        ? (r6RawOut as { text: string }).text
        : String(r6RawOut ?? '')
    controls.push({
      requirementId: 'R6', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: !r6Out.includes('leaked_secret') && r6Out.includes('CLEAN'),
      greenPassed: r6Res.status === 200 && r6Res.json.ok === true,
      injectedFault: 'parent_env_broker_token_leak_to_bash', observedRedCode: r6Out.includes('CLEAN') ? 'SCRUBBED_CLEAN' : 'LEAKED',
    })

    // R7: Live ExecEnvHandle.openChannel('tool-broker') multiplexed channel + teardown
    const [clientLink, serverLink] = createInMemoryFrameLinkPair()
    const host = new ContainerLinkToolBrokerHost({ link: serverLink, server: runtime.server, leaseManager: runtime.leaseManager, rebindAuthority: runtime.capabilityAuthority })
    const handle = createLiveExecEnvHandle({
      envId: runtime.execEnvId,
      lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, sessionKey, hostKind: 'local-docker', envId: runtime.execEnvId, placementEpoch: 1, issuedAt: new Date(lease.issuedAtMs).toISOString(), expiresAt: new Date(lease.expiresAtMs).toISOString() },
      capabilities: { hostKind: 'local-docker', supportedChannels: ['ws_tunnel', 'loopback_http'], supportsManagedJobs: true, supportsDaemonServices: true, supportsWorkspaceSnapshots: true, supportsNetworkIsolation: true, supportsSeccompProfile: true, maxConcurrentJobs: 16 },
      attachment: { leaseId: lease.leaseId, channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64), policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date(0).toISOString() },
      openFrameLink: () => clientLink,
    })
    let r7MismatchErr = ''
    try { handle.openChannel('tool-broker', { leaseId: 'wrong-lease', fencingToken: lease.fencingToken }) } catch (err) { r7MismatchErr = err instanceof Error ? err.message : String(err) }
    const ch = handle.openChannel('tool-broker', { fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r7Call = buildEnvelope({ leaseId: lease.leaseId, turnId: 't7', callId: 'c-r7', canonicalName: 'rp_echo', arguments: { msg: 'via-handle' } })
    const r7Tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r7', toolName: 'rp_echo' })
    const r7Res = await ch.invoke(r7Call, { capabilityToken: r7Tok.token })
    handle.closeAllChannels('redproof_done')
    host.dispose('redproof_done')
    controls.push({
      requirementId: 'R7', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r7MismatchErr.includes('does not match') && handle.activeChannelCount() === 0,
      greenPassed: r7Res.status === 'ok' && (r7Res.output as { echo?: string })?.echo === 'via-handle',
      injectedFault: 'mismatched_lease_channel_open', observedRedCode: r7MismatchErr ? 'LEASE_MISMATCH_REJECTED' : 'MISSED',
    })

    // R8: Anti-loopback HTTP bypass + single-use octk1.* replay + claim mismatch + cross-token isolation
    const r8Call = buildEnvelope({ leaseId: lease.leaseId, turnId: 't8', callId: 'c-r8-1', canonicalName: 'rp_echo', arguments: { msg: 'once' } })
    const r8NoCap = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { Authorization: 'Bearer raw-gateway-token' }, { call: r8Call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r8Tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r8-1', toolName: 'rp_echo' })
    const r8Ok = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r8Tok.token }, { call: r8Call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r8Replay = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r8Tok.token }, { call: r8Call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r8WrongToolTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r8-2', toolName: 'oc_read' })
    const r8MismatchCall = buildEnvelope({ leaseId: lease.leaseId, turnId: 't8', callId: 'c-r8-2', canonicalName: 'rp_echo', arguments: { msg: 'wrong-tool' } })
    const r8Mismatch = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r8WrongToolTok.token }, { call: r8MismatchCall, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    const r8CrossTok = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: r5NormalHook.token }, { toolName: 'rp_echo', arguments: {} })
    controls.push({
      requirementId: 'R8', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught:
        r8NoCap.status === 401 && r8NoCap.json.errorCode === 'CAPABILITY_TOKEN_MALFORMED' &&
        r8Replay.status === 403 && r8Replay.json.errorCode === 'CAPABILITY_TOKEN_REPLAYED' &&
        r8Mismatch.status === 403 && r8Mismatch.json.errorCode === 'CAPABILITY_TOKEN_TOOL_MISMATCH' &&
        r8CrossTok.status === 401,
      greenPassed: r8Ok.status === 200 && r8Ok.json.ok === true,
      injectedFault: 'raw_bearer_bypass_octk1_replay_tool_mismatch_cross_token',
      observedRedCode: `${String(r8NoCap.json.errorCode)}|${String(r8Replay.json.errorCode)}|${String(r8Mismatch.json.errorCode)}`,
    })

    // R9: >256 KiB disk spill + sha256 tamper rejection + verified read-back
    const r9Res = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: r6Mcp.token }, { toolName: 'rp_big_output', arguments: {} })
    const r9Result = r9Res.json.result as { output?: { type?: string; blobId?: string; sha256?: string; bytes?: number }; spilledBlobId?: string } | undefined
    const blobRef = r9Result?.output
    const r9Tamper = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: r6Mcp.token }, { blobId: blobRef?.blobId ?? '', sha256: 'f'.repeat(64) })
    const r9Read = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: r6Mcp.token }, { blobId: blobRef?.blobId ?? '', sha256: blobRef?.sha256, offset: 0, limit: 1024 })
    controls.push({
      requirementId: 'R9', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: blobRef?.type === 'blob_ref' && (blobRef?.bytes ?? 0) > 256 * 1024 && r9Tamper.status === 422 && r9Tamper.json.errorCode === 'TOOL_SPILLED_BLOB_CORRUPT',
      greenPassed: r9Read.status === 200 && r9Read.json.ok === true && r9Read.json.bytesRead === 1024,
      injectedFault: 'oversize_300kib_spill_and_sha256_tamper', observedRedCode: String(r9Tamper.json.errorCode ?? r9Tamper.status),
    })

    // R10: Gate 4 55s blocking-then-detached approval + late response does NOT double-execute
    const r10Call = buildEnvelope({ leaseId: lease.leaseId, turnId: 't10', callId: 'c-r10-detach', canonicalName: 'r10_guarded_write', arguments: {} })
    const r10Tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r10-detach', toolName: 'r10_guarded_write' })
    const r10Detached = await runtime.server.invoke({ ...r10Call, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: r10Tok.token })
    const lateReqId = detachedCards[0] ?? ''
    const lateHandled = lateReqId ? runtime.handlePermissionResponse({ requestId: lateReqId, behavior: 'allow' }) : false
    const r10OkCall = buildEnvelope({ leaseId: lease.leaseId, turnId: 't10', callId: 'c-r10-approve', canonicalName: 'r10_guarded_write', arguments: {} })
    const r10OkTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-r10-approve', toolName: 'r10_guarded_write' })
    const cardOpened = new Promise<string>((res) => { nextCardOpenedResolve = res })
    const r10Pending = runtime.server.invoke({ ...r10OkCall, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: r10OkTok.token })
    const inWindowReqId = await cardOpened
    runtime.handlePermissionResponse({ requestId: inWindowReqId, behavior: 'allow' })
    const r10Approved = await r10Pending
    controls.push({
      requirementId: 'R10', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught:
        TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS === 55_000 &&
        r10Detached.status === 'denied' &&
        r10Detached.approvalStatus === 'detached_pending' &&
        lateHandled &&
        r10ExecCount === 1,
      greenPassed: r10Approved.status === 'ok' && r10Approved.approvalStatus === 'approved',
      injectedFault: 'approval_window_timeout_detach_and_late_response_no_double_exec',
      observedRedCode: String(r10Detached.errorCode ?? r10Detached.approvalStatus),
    })

    // R11: Fencing kill / stale brainGen & fencingToken rejection + session cancel revokes turn token
    const r11Session = 'agent:main:webchat:dm:redproof-r11'
    const r11Lease1 = runtime.ensureSessionLease(r11Session)
    const r11OldHook = runtime.issueTurnHookToken({ sessionKey: r11Session, mode: 'normal' })
    const r11Lease2 = await runtime.rebindSessionBrain(r11Session, 2, 'ft_redproof_gen2')
    const r11StaleCall = buildEnvelope({ leaseId: r11Lease1.leaseId, turnId: 't11', callId: 'c-r11-stale', canonicalName: 'rp_fenced', arguments: {} })
    const r11StaleTok = runtime.capabilityAuthority.issueToken({ callId: 'c-r11-stale', toolName: 'rp_fenced', sessionKey: r11Session, leaseId: r11Lease1.leaseId, brainGen: 1 })
    const r11Stale = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r11StaleTok.token }, { call: r11StaleCall, leaseId: r11Lease1.leaseId, fencingToken: r11Lease1.fencingToken, brainGen: 1, sessionKey: r11Session })
    const r11OldHookEval = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: r11OldHook.token }, { toolName: 'read_file', arguments: {} })
    const r11FreshCall = buildEnvelope({ leaseId: r11Lease2.leaseId, turnId: 't11', callId: 'c-r11-fresh', canonicalName: 'rp_fenced', arguments: {} })
    const r11FreshTok = runtime.issueSingleUseCapabilityToken({ sessionKey: r11Session, callId: 'c-r11-fresh', toolName: 'rp_fenced' })
    const r11Fresh = await postJson(`${baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`, { [TOOL_BROKER_CAPABILITY_HEADER]: r11FreshTok.token }, { call: r11FreshCall, leaseId: r11Lease2.leaseId, fencingToken: r11Lease2.fencingToken, brainGen: 2, sessionKey: r11Session })
    controls.push({
      requirementId: 'R11', redEnvironment: 'live-tool-broker-fault-injection',
      redControlCaught: r11Stale.status === 403 && r11OldHookEval.status === 401 && r11OldHookEval.json.code === 'EXEC_FENCING_TOKEN_STALE' && r11ExecCount === 1,
      greenPassed: r11Fresh.status === 200 && r11Fresh.json.ok === true,
      injectedFault: 'stale_brain_gen_and_old_fencing_token_after_rebind',
      observedRedCode: `${String(r11Stale.json.errorCode)}|${String(r11OldHookEval.json.code)}`,
    })

    const allRedControlsCaught = controls.length === SANDBOX_RED_CONTROL_IDS.length && controls.every((c) => c.redControlCaught)
    const allGreenPassed = controls.every((c) => c.greenPassed)
    const payloadWithoutSha = {
      schemaVersion: 2 as const,
      controlIds: [...SANDBOX_RED_CONTROL_IDS],
      allRedControlsCaught,
      allGreenPassed,
      controls,
    }
    const proofSha256 = remoteCanonicalSha256(payloadWithoutSha)
    return { ...payloadWithoutSha, proofSha256 }
  } finally {
    runtime?.dispose()
    if (httpServer) {
      httpServer.closeAllConnections?.()
      await new Promise<void>((res) => httpServer!.close(() => res()))
    }
    await rm(workDir, { recursive: true, force: true })
  }
}

async function mainCli(): Promise<void> {
  const argv = process.argv.slice(2)
  let outPath: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outPath = resolve(argv[++i]!)
  }
  const artifact = await runSandboxRedProofV2()
  if (!artifact.allRedControlsCaught || !artifact.allGreenPassed) {
    process.stderr.write(`${JSON.stringify(artifact, null, 2)}\n`)
    process.exit(1)
  }
  if (outPath) {
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
    process.stdout.write(`Wrote Sandbox Red Proof v2 to ${outPath} (controls=${artifact.controls.length}, proofSha256=${artifact.proofSha256})\n`)
  } else {
    process.stdout.write(`Sandbox Red Proof v2 PASS (controls=${artifact.controls.length}, proofSha256=${artifact.proofSha256})\n`)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  void mainCli().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}
