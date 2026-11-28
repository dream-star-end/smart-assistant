/**
 * OCV5-915 P3-2 — Outcome-based real-entry verification for L3 ToolBrokerServer
 * production wiring, ExecEnvHandle.openChannel('tool-broker'), anti-loopback
 * single-use `octk1.*` isolation, Antigravity & efficiency hooks, MCP routing,
 * RemoteContainerLane default broker, Gate 4 55s detach, and Sandbox Red Proof v2.
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstatSync, readFileSync, existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CURSOR_ENGINE_MODEL,
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  SANDBOX_RED_CONTROL_IDS,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  isReadOnlyAllowedCanonicalTool,
  type ToolCallEnvelope,
} from '@openclaude/protocol'
import { randomUUID } from 'node:crypto'
import {
  TOOL_BROKER_LOCAL_PREFIX,
  createInMemoryFrameLinkPair,
  isToolBrokerWireFrame,
} from '@openclaude/protocol/exec-env'
import { paths, type AgentsConfig, type OpenClaudeConfig } from '@openclaude/storage'
import {
  GatewayToolBrokerRuntime,
  scrubToolBrokerEnv,
  type ToolBrokerApprovalBridge,
} from '../../toolBrokerRuntime.js'
import {
  createGatewayToolBrokerRuntime,
  isGatewayToolBrokerSelfhostEnabled,
} from '../../remoteSwarmLocal.js'
import { Gateway } from '../../server.js'
import { handlePermissionResponse, type AskUserPermissionsHost } from '../../askUserPermissions.js'
import {
  buildDetachedAskUserPersistMessage,
  pendingFromDetachedAskUserMessage,
} from '../../detachedAskUser.js'
import {
  TOOL_BROKER_CAPABILITY_HEADER,
  TOOL_BROKER_HOOK_TOKEN_HEADER,
  TOOL_BROKER_MCP_TOKEN_HEADER,
  handleToolBrokerLocalHttp,
} from '../../routes/toolBrokerLocalRoute.js'
import { PRE_AUTH_ROUTES, type PreAuthRoutesIo } from '../../routes/preAuth.js'
import { dispatchRoutes } from '../../routes/routeTable.js'
import {
  ContainerLinkToolBrokerHost,
  TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS,
  createLiveExecEnvHandle,
} from '../index.js'
import {
  ANTIGRAVITY_BROKER_HOOK_GROUP,
  ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC,
  installAntigravityBrokerHook,
  resolveActiveAntigravityBrokerHook,
} from '../../engine/antigravityBrokerHook.js'
import {
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
} from '../../engine/antigravityPlatform.js'
import { AntigravityAdapter } from '../../engine/antigravityAdapter.js'
import { CursorAdapter } from '../../engine/cursorAdapter.js'
import { SubprocessRunner } from '../../subprocessRunner.js'
import { RemoteContainerLane, type LaneToolHost } from '../../remotePool/containerLane.js'
import { remotePoolBackendOf, type RemotePoolBinding } from '../../remotePool/types.js'
import { isSelfhostRemoteLaneBrokerEnabled } from '../../remotePool/containerLaneBroker.js'
import type { EngineCreateOpts } from '../../engine/registry.js'
import {
  ACTION_POLICY_HOOK_ENGINE_TIMEOUT_SEC,
  TOOL_BROKER_HOOK_ENGINE_TIMEOUT_SEC,
  buildCcbEfficiencySettings,
  buildCursorEfficiencyHooks,
  registerEfficiencyBrokerHookProvider,
  resolveActiveEfficiencyBrokerHook,
  resolveEfficiencyHookRunner,
} from '../../efficiencyHookConfig.js'
import { handlePreToolHookInput } from '../../efficiencyPreToolHook.js'
import { RemoteLaneToolBroker, type LaneToolHostLike } from '../../remotePool/containerLaneBroker.js'
import type { PermissionRequest } from '../../engine/engineEvents.js'
import type { LoadedActionPolicy } from '../../actionPolicyEngine.js'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)))

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
interface LocalCliToolsModule {
  handleOcBash(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
  handleOcRead(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
  handleOcGrep(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
  handleOcGlob(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
  handleOcFind(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
  handleOcTree(args: unknown, deps?: { env?: NodeJS.ProcessEnv }): Promise<ToolTextResult>
}
interface ToolBrokerClientModule {
  readSpilledBlobViaMcpToolBroker(input: {
    blobId: string
    sha256?: string
    offset?: number
    limit?: number
    env: Readonly<Record<string, string | undefined>>
  }): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>
}
interface RedProofV2Module {
  runSandboxRedProofV2(): Promise<{
    schemaVersion: 2
    controlIds: readonly string[]
    allRedControlsCaught: boolean
    allGreenPassed: boolean
    controls: ReadonlyArray<{ requirementId: string; redControlCaught: boolean; greenPassed: boolean; observedRedCode: string }>
    proofSha256: string
  }>
}

async function loadExternalModule<T>(relFromRepoRoot: string): Promise<T> {
  const url = new URL(relFromRepoRoot, `file://${REPO_ROOT}/`).href
  return (await import(url)) as T
}

function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
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

function makeCall(input: {
  leaseId: string
  turnId: string
  callId: string
  canonicalName: string
  arguments: Record<string, unknown>
}): ToolCallEnvelope {
  const argsSha256 = computeSchemaFilteredArgsSha256(input.arguments, null)
  return {
    schemaVersion: 1,
    leaseId: input.leaseId,
    turnId: input.turnId,
    callId: input.callId,
    idempotencyKey: computeToolIdempotencyKey(input.leaseId, input.turnId, input.callId),
    canonicalName: input.canonicalName,
    arguments: input.arguments,
    argsSha256,
    attestation: {
      kind: 'gateway_signed_grant',
      argsSha256,
      observedAt: new Date().toISOString(),
      grantId: 'p32-test',
    },
  }
}

function runCmd(bin: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveOut) => {
    const child = execFile(bin, args, { timeout: 15_000, env: opts.env }, (err, stdout, stderr) => {
      const code = err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0
      resolveOut({ code, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

async function startPreAuthBrokerServer(runtime: GatewayToolBrokerRuntime): Promise<{
  server: ReturnType<typeof createServer>
  port: number
  baseUrl: string
  close: () => Promise<void>
}> {
  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const io = {
    sendJson,
    readBody,
    sendInternalError: (res: ServerResponse, err: unknown) => sendJson(res, 500, { ok: false, error: String(err) }),
    handleToolBrokerLocal: async (req: IncomingMessage, res: ServerResponse, url: URL) => {
      await handleToolBrokerLocalHttp({ req, res, url, readBody, sendJson, runtime })
    },
  } as unknown as PreAuthRoutesIo
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handled = dispatchRoutes(PRE_AUTH_ROUTES, io, req, res, url)
    if (!handled) sendJson(res, 404, { ok: false, error: 'not found' })
  })
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections?.()
      return new Promise<void>((res) => server.close(() => res()))
    },
  }
}

test('R8 + Q1/Q2: PRE_AUTH_ROUTES loopback ToolBroker enforces single-use octk1.* tokens, rejects raw Bearer, replay, mismatch, and non-loopback', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-r8-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  let invokeCount = 0
  runtime.registerTool({
    canonicalName: 'p32_echo',
    readOnly: true,
    handler: async (args) => {
      invokeCount += 1
      return { echoed: args.text ?? '', n: invokeCount }
    },
  })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-r8'
    const lease = runtime.ensureSessionLease(sessionKey)
    const call = makeCall({ leaseId: lease.leaseId, turnId: 't1', callId: 'c1', canonicalName: 'p32_echo', arguments: { text: 'hello' } })

    // 1. Raw Bearer token MUST be rejected (401)
    const noCap = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`,
      { Authorization: 'Bearer raw-gateway-secret' },
      { call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
    )
    assert.equal(noCap.status, 401)
    assert.equal(noCap.json.errorCode, 'CAPABILITY_TOKEN_MALFORMED')
    assert.equal(invokeCount, 0)

    // 2. Non-loopback remote address MUST be rejected (403)
    let nonLoopbackStatus = 0
    let nonLoopbackBody: Record<string, unknown> = {}
    await handleToolBrokerLocalHttp({
      req: { method: 'POST', headers: {}, socket: { remoteAddress: '10.99.0.5' } } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://127.0.0.1${TOOL_BROKER_LOCAL_PREFIX}/invoke`),
      readBody: async () => '{}',
      sendJson: (_r, code, body) => { nonLoopbackStatus = code; nonLoopbackBody = body as Record<string, unknown> },
      runtime,
    })
    assert.equal(nonLoopbackStatus, 403)
    assert.equal(nonLoopbackBody.errorCode, 'TOOL_BROKER_LOOPBACK_ONLY')

    // 3. Valid single-use octk1.* succeeds once
    const tok1 = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c1', toolName: 'p32_echo' })
    const okRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`,
      { [TOOL_BROKER_CAPABILITY_HEADER]: tok1.token },
      { call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
    )
    assert.equal(okRes.status, 200)
    assert.equal(okRes.json.ok, true)
    assert.equal(invokeCount, 1)

    // 4. Replay of consumed octk1.* MUST fail (403 CAPABILITY_TOKEN_REPLAYED)
    const replay = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`,
      { [TOOL_BROKER_CAPABILITY_HEADER]: tok1.token },
      { call, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
    )
    assert.equal(replay.status, 403)
    assert.equal(replay.json.errorCode, 'CAPABILITY_TOKEN_REPLAYED')
    assert.equal(invokeCount, 1)

    // 5. Claim mismatch (wrong toolName / wrong callId / wrong sessionKey) MUST fail (403)
    const tokWrongTool = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c2', toolName: 'oc_read' })
    const call2 = makeCall({ leaseId: lease.leaseId, turnId: 't1', callId: 'c2', canonicalName: 'p32_echo', arguments: { text: 'bad' } })
    const mismatchTool = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/invoke`,
      { [TOOL_BROKER_CAPABILITY_HEADER]: tokWrongTool.token },
      { call: call2, leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
    )
    assert.equal(mismatchTool.status, 403)
    assert.equal(mismatchTool.json.errorCode, 'CAPABILITY_TOKEN_TOOL_MISMATCH')
    assert.equal(invokeCount, 1)

    // 6. Cross-token isolation: octh1.* rejected on /mcp-execute, octm1.* rejected on /hook-evaluate
    const hookTok = runtime.issueTurnHookToken({ sessionKey })
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey })
    const cross1 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: hookTok.token }, { toolName: 'p32_echo', arguments: {} })
    const cross2 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: mcpTok.token }, { toolName: 'read_file', arguments: {} })
    assert.equal(cross1.status, 401)
    assert.equal(cross2.status, 401)

    // 7. Ephemeral secrets NEVER leak into process.env
    for (const k of Object.keys(process.env)) {
      assert.equal(k.includes('CAPABILITY_SECRET'), false)
    }
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Live ExecEnvHandle.openChannel("tool-broker") streams output, enforces single-use octk1.*, and cleans up on teardown (Q4)', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-handle-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  let aborted = false
  runtime.registerTool({
    canonicalName: 'p32_stream',
    readOnly: true,
    handler: async (_args, ctx) => {
      ctx.emitStdout('chunk-1\n')
      ctx.emitStderr('err-1\n')
      return 'done-stream'
    },
  })
  runtime.registerTool({
    canonicalName: 'p32_hang',
    readOnly: true,
    handler: async (_args, ctx) => {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, 10_000)
        ctx.signal.addEventListener('abort', () => { aborted = true; clearTimeout(t); rej(new Error('cancelled')) }, { once: true })
      })
      return 'never'
    },
  })
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-handle'
    const lease = runtime.ensureSessionLease(sessionKey)
    const [clientLink, serverLink] = createInMemoryFrameLinkPair()
    const host = new ContainerLinkToolBrokerHost({
      link: serverLink,
      server: runtime.server,
      leaseManager: runtime.leaseManager,
      rebindAuthority: runtime.capabilityAuthority,
    })
    const handle = createLiveExecEnvHandle({
      envId: runtime.execEnvId,
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        sessionKey,
        hostKind: 'local-docker',
        envId: runtime.execEnvId,
        placementEpoch: 1,
        issuedAt: new Date(lease.issuedAtMs).toISOString(),
        expiresAt: new Date(lease.expiresAtMs).toISOString(),
      },
      capabilities: {
        hostKind: 'local-docker',
        supportedChannels: ['ws_tunnel', 'loopback_http'],
        supportsManagedJobs: true,
        supportsDaemonServices: true,
        supportsWorkspaceSnapshots: true,
        supportsNetworkIsolation: true,
        supportsSeccompProfile: true,
        maxConcurrentJobs: 8,
      },
      attachment: {
        leaseId: lease.leaseId,
        channelKind: 'ws_tunnel',
        workspaceTreeSha256: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64),
        toolCatalogSha256: 'c'.repeat(64),
        attachedAt: new Date().toISOString(),
      },
      openFrameLink: () => clientLink,
    })

    const channel = handle.openChannel('tool-broker', { fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
    assert.equal(handle.activeChannelCount(), 1)
    const call = makeCall({ leaseId: lease.leaseId, turnId: 't-s1', callId: 'c-s1', canonicalName: 'p32_stream', arguments: {} })
    const tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-s1', toolName: 'p32_stream' })
    const frames: string[] = []
    for await (const f of channel.stream(call, { capabilityToken: tok.token })) {
      frames.push(f.kind)
    }
    assert.ok(frames.includes('tool_stdout'))
    assert.ok(frames.includes('tool_stderr'))
    assert.ok(frames.includes('tool_result'))
    assert.equal(isToolBrokerWireFrame({ type: 'broker.invoke', channelId: 'ch1', requestId: 'r1', leaseId: lease.leaseId, fencingToken: lease.fencingToken, call }), true)
    assert.equal(isToolBrokerWireFrame({ type: 'inbound.message' }), false)

    // Q4 cancel & teardown
    const hangCall = makeCall({ leaseId: lease.leaseId, turnId: 't-s2', callId: 'c-hang', canonicalName: 'p32_hang', arguments: {} })
    const hangTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-hang', toolName: 'p32_hang' })
    const pending = channel.invoke(hangCall, { capabilityToken: hangTok.token }).catch(() => null)
    await new Promise<void>((res) => setTimeout(res, 40))
    await channel.cancel('c-hang', 'test_cancel')
    await pending
    assert.equal(aborted, true)
    handle.closeAllChannels('test_done')
    assert.equal(handle.activeChannelCount(), 0)
    host.dispose('test_done')
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Antigravity PreToolUse broker hook installs 65s guard on normal/readOnly/hermetic turns and enforces live loopback evaluation + readOnly canonical tools', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-agy-hook-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  process.env.OPENCLAUDE_HOME = join(workDir, 'oc-home')
  paths.home = join(workDir, 'storage-home')

  const policy: LoadedActionPolicy = {
    ok: true,
    source: 'default',
    path: '<test>',
    policy: {
      version: 1,
      defaultTier: 'allow',
      extendsDefaults: false,
      rules: [
        { id: 'deny-force-push', category: 'destructive_shell', tier: 'deny', reason: 'Force push blocked', match: { tool: ['Bash'], commandPattern: 'git\\s+push\\s+--force' } },
      ],
    },
    warnings: [],
  }
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, loadedActionPolicy: policy })
  const srv = await startPreAuthBrokerServer(runtime)
  const unreg = runtime.registerAsAntigravityHookProvider()
  try {
    // Verify L0 validator additions (Plan Mode, MCP read-only, ExecuteExtraTool & call_mcp_tool unwrapping)
    assert.equal(isReadOnlyAllowedCanonicalTool('mcp_openclaude-memory_oc_grep', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('mcp_openclaude-memory_oc_read', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('mcp_openclaude-memory_oc_bash', {}), false)
    assert.equal(isReadOnlyAllowedCanonicalTool('list_resources', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('read_resource', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('search_extra_tools', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('AskUserQuestion', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('exit_plan_mode', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('oc_read', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('oc_find', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('oc_tree', {}), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('ExecuteExtraTool', { tool_name: 'oc_read', arguments: { path: '/tmp/a' } }), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('ExecuteExtraTool', { tool_name: 'oc_read', arguments: { write: true } }), false)
    assert.equal(isReadOnlyAllowedCanonicalTool('ExecuteExtraTool', { tool_name: 'oc_bash', arguments: { command: 'ls' } }), false)
    assert.equal(isReadOnlyAllowedCanonicalTool('call_mcp_tool', { ServerName: 'openclaude-memory', ToolName: 'oc_grep', Arguments: { pattern: 'x' } }), true)
    assert.equal(isReadOnlyAllowedCanonicalTool('call_mcp_tool', { ServerName: 'openclaude-memory', ToolName: 'oc_bash', Arguments: {} }), false)
    assert.equal(isReadOnlyAllowedCanonicalTool('call_mcp_tool', { ServerName: 'evil-server', ToolName: 'oc_grep', Arguments: {} }), false)

    const baseInput = {
      credential: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:p32-agy-normal',
      gatewayPort: srv.port,
      gatewayToken: 'gw-tok',
      delegationDepth: 0,
      claudeCodePath: REPO_ROOT,
      hostBin: null,
    }
    const normalProj = projectAntigravityPlatform({ ...baseInput, readOnly: false })
    const roProj = projectAntigravityPlatform({ ...baseInput, sessionKey: 'agent:main:webchat:dm:p32-agy-ro', readOnly: true })
    const hermeticProj = projectAntigravityPlatform({ ...baseInput, sessionKey: 'agent:main:webchat:dm:p32-agy-hermetic', hermeticNoTools: true })

    try {
      // Normal turn gets 65s PreToolUse broker hook + MCP broker token file
      assert.ok(normalProj.brokerHook)
      assert.equal(normalProj.brokerHook.timeoutSec, ANTIGRAVITY_BROKER_HOOK_TIMEOUT_SEC)
      assert.equal(lstatSync(normalProj.brokerHook.hooksConfigPath).mode & 0o777, 0o400)
      const hooksJson = JSON.parse(readFileSync(normalProj.brokerHook.hooksConfigPath, 'utf8')) as Record<string, { PreToolUse: Array<{ matcher: string; hooks: Array<{ timeout: number }> }> }>
      assert.equal(hooksJson[ANTIGRAVITY_BROKER_HOOK_GROUP]!.PreToolUse[0]!.matcher, '.*')
      assert.equal(hooksJson[ANTIGRAVITY_BROKER_HOOK_GROUP]!.PreToolUse[0]!.hooks[0]!.timeout, 65)

      // Live normal hook: allows benign command, denies force push
      const allowNormal = await runCmd(normalProj.brokerHook.pythonBin, ['-I', '-B', normalProj.brokerHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo hello' } } }),
      })
      assert.deepEqual(JSON.parse(allowNormal.stdout.trim()), { decision: 'allow' })
      const denyForce = await runCmd(normalProj.brokerHook.pythonBin, ['-I', '-B', normalProj.brokerHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } } }),
      })
      assert.equal((JSON.parse(denyForce.stdout.trim()) as { decision: string }).decision, 'deny')

      // Read-only turn allows read_file + search_extra_tools, denies write_file
      assert.ok(roProj.brokerHook)
      const allowRo = await runCmd(roProj.brokerHook.pythonBin, ['-I', '-B', roProj.brokerHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'search_extra_tools', args: {} } }),
      })
      assert.deepEqual(JSON.parse(allowRo.stdout.trim()), { decision: 'allow' })
      const denyRo = await runCmd(roProj.brokerHook.pythonBin, ['-I', '-B', roProj.brokerHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'write_file', args: { Path: '/tmp/a' } } }),
      })
      assert.equal((JSON.parse(denyRo.stdout.trim()) as { decision: string }).decision, 'deny')

      // Hermetic turn denies EVERY tool + projects 0 MCP servers
      assert.ok(hermeticProj.brokerHook)
      assert.equal(hermeticProj.advertisedMcpTools.length, 0)
      const denyHermetic = await runCmd(hermeticProj.brokerHook.pythonBin, ['-I', '-B', hermeticProj.brokerHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/tmp/a' } } }),
      })
      assert.equal((JSON.parse(denyHermetic.stdout.trim()) as { decision: string }).decision, 'deny')

      // Unreachable broker fails closed
      const badDir = join(workDir, 'unreachable')
      await mkdir(join(badDir, '.gemini', 'config'), { recursive: true })
      const badHook = installAntigravityBrokerHook({
        launchHome: badDir,
        configDir: join(badDir, '.gemini', 'config'),
        mode: 'normal',
        brokerUrl: 'http://127.0.0.1:1',
        hookToken: 'octh1.dummy.sig',
      })
      const failClosed = await runCmd(badHook.pythonBin, ['-I', '-B', badHook.guardScriptPath], {
        input: JSON.stringify({ toolCall: { name: 'read_file', args: {} } }),
      })
      assert.equal((JSON.parse(failClosed.stdout.trim()) as { decision: string }).decision, 'deny')
    } finally {
      cleanupAntigravityLaunch(normalProj)
      cleanupAntigravityLaunch(roProj)
      cleanupAntigravityLaunch(hermeticProj)
    }

    // Q1: after unregistering provider, standalone normal projection has no hooks.json
    unreg()
    const standalone = projectAntigravityPlatform({ ...baseInput, readOnly: false })
    try {
      assert.equal(existsSync(join(standalone.launchHome, '.gemini', 'config', 'hooks.json')), false)
    } finally {
      cleanupAntigravityLaunch(standalone)
    }
  } finally {
    unreg()
    runtime.dispose()
    await srv.close()
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('efficiencyHookRunner.cjs + efficiencyHookConfig + efficiencyPreToolHook delegate to live ToolBroker with 65s timeout & scrub env', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-eff-'))
  const policy: LoadedActionPolicy = {
    ok: true,
    source: 'default',
    path: '<eff-test>',
    policy: {
      version: 1,
      defaultTier: 'allow',
      extendsDefaults: false,
      rules: [
        { id: 'deny-rm-rf', category: 'destructive_shell', tier: 'deny', reason: 'Destructive rm blocked', match: { tool: ['Bash'], commandPattern: 'rm\\s+-rf\\s+/tmp/forbidden' } },
      ],
    },
    warnings: [],
  }
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, loadedActionPolicy: policy })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    // Config timeout preserves 6s default and raises to 65s when brokerApprovalActive
    const ccbDefault = buildCcbEfficiencySettings('deny', true) as { hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> } }
    const ccbBroker = buildCcbEfficiencySettings('deny', true, { brokerApprovalActive: true }) as { hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> } }
    const curBroker = buildCursorEfficiencyHooks('deny', true, { brokerApprovalActive: true }) as { hooks: { beforeShellExecution: Array<{ timeout: number }> } }
    assert.equal(ccbDefault.hooks.PreToolUse[0]!.hooks[0]!.timeout, ACTION_POLICY_HOOK_ENGINE_TIMEOUT_SEC)
    assert.equal(ccbBroker.hooks.PreToolUse[0]!.hooks[0]!.timeout, TOOL_BROKER_HOOK_ENGINE_TIMEOUT_SEC)
    assert.equal(curBroker.hooks.beforeShellExecution[0]!.timeout, 65)

    // Live efficiencyHookRunner.cjs subprocess over loopback broker
    const sessionKey = 'agent:main:webchat:dm:p32-eff'
    const hookTok = runtime.issueTurnHookToken({ sessionKey })
    const tokenFile = join(workDir, 'hook-token')
    await writeFile(tokenFile, `${hookTok.token}\n`, { mode: 0o600 })
    const runner = resolveEfficiencyHookRunner()
    const env = {
      ...process.env,
      OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
      OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN_FILE: tokenFile,
      OPENCLAUDE_ACTION_POLICY: 'on',
    }

    const allowRes = await runCmd(process.execPath, [runner, '--protocol=ccb', '--mode=deny'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' } }),
      env,
    })
    assert.equal(allowRes.code, 0)
    assert.equal((JSON.parse(allowRes.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'allow')

    const denyRes = await runCmd(process.execPath, [runner, '--protocol=ccb', '--mode=deny'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/forbidden' } }),
      env,
    })
    assert.equal(denyRes.code, 0)
    assert.equal((JSON.parse(denyRes.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')

    // handlePreToolHookInput brokerEvaluate delegate + scrubToolBrokerEnv
    const delegated = await handlePreToolHookInput(
      { tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      'cursor',
      'deny',
      { brokerEvaluate: async () => ({ decision: 'deny', reason: 'broker-denied' }) },
    )
    assert.equal(delegated.permission, 'deny')
    const scrubbed = scrubToolBrokerEnv({ PATH: '/usr/bin', OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN: 'secret', OC_TOOL_BROKER_X: '1' })
    assert.deepEqual(scrubbed, { PATH: '/usr/bin' })
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('MCP localCliTools routes oc_bash/oc_read/oc_grep/oc_glob/oc_find/oc_tree via ToolBroker, scrubs env, and spills >256 KiB cleanly (R6 & R9)', async () => {
  const { handleOcBash, handleOcFind, handleOcGlob, handleOcGrep, handleOcRead, handleOcTree } =
    await loadExternalModule<LocalCliToolsModule>('packages/mcp-memory/src/localCliTools.ts')
  const { readSpilledBlobViaMcpToolBroker } =
    await loadExternalModule<ToolBrokerClientModule>('packages/mcp-memory/src/toolBrokerClient.ts')
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-mcp-'))
  const sampleFile = join(workDir, 'hello.txt')
  await writeFile(sampleFile, 'needle_p32_line\n', 'utf8')
  const bigFile = join(workDir, 'big.txt')
  const bigContent = 'B'.repeat(300 * 1024)
  await writeFile(bigFile, bigContent, 'utf8')

  const runtime = new GatewayToolBrokerRuntime({
    homeDir: workDir,
    baseToolEnv: {
      HOME: workDir,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: 'octm1.must_never_leak',
      OC_TOOL_BROKER_SECRET: 'must_never_leak',
    },
  })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-mcp'
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey })
    const tokenFile = join(workDir, 'mcp-tok')
    await writeFile(tokenFile, `${mcpTok.token}\n`, { mode: 0o600 })
    const brokerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
      OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE: tokenFile,
    }

    const bashRes = await handleOcBash({ command: 'env | grep -E "OPENCLAUDE_TOOL_BROKER_|OC_TOOL_BROKER_" || echo ENV_CLEAN' }, { env: brokerEnv })
    assert.equal(bashRes.isError, undefined)
    assert.ok(bashRes.content[0]!.text.includes('ENV_CLEAN'))
    assert.equal(bashRes.content[0]!.text.includes('must_never_leak'), false)

    const readRes = await handleOcRead({ path: sampleFile }, { env: brokerEnv })
    assert.equal(readRes.content[0]!.text.trim(), 'needle_p32_line')

    const grepRes = await handleOcGrep({ pattern: 'needle_p32_line', path: workDir }, { env: brokerEnv })
    assert.ok(grepRes.content[0]!.text.includes('needle_p32_line'))

    const globRes = await handleOcGlob({ pattern: '*.txt', path: workDir }, { env: brokerEnv })
    assert.ok(globRes.content[0]!.text.includes('hello.txt'))

    const findRes = await handleOcFind({ path: workDir }, { env: brokerEnv })
    assert.ok(findRes.content[0]!.text.includes('hello.txt'))

    const treeRes = await handleOcTree({ path: workDir }, { env: brokerEnv })
    assert.ok(treeRes.content[0]!.text.includes('hello.txt'))

    // >256 KiB spill + verified spill-read
    const spillRes = await handleOcRead({ path: bigFile }, { env: brokerEnv })
    const spillText = spillRes.content[0]!.text
    assert.ok(spillText.startsWith('[tool-broker:spilled '))
    const blobLine = spillText.split('\n')[1]!
    const blobRef = JSON.parse(blobLine) as { blobId: string; sha256: string; bytes: number }
    assert.ok(blobRef.bytes > 256 * 1024)
    const readBack = await readSpilledBlobViaMcpToolBroker({ blobId: blobRef.blobId, sha256: blobRef.sha256, offset: 0, limit: 2048, env: brokerEnv })
    assert.equal(readBack.ok, true)
    assert.equal(readBack.data?.bytesRead, 2048)

    // Read-only MCP token MUST deny oc_bash (never bypass to local!)
    const roTok = runtime.issueTurnMcpToken({ sessionKey: 'agent:main:webchat:dm:p32-mcp-ro', mode: 'read_only' })
    const roRes = await handleOcBash({ command: 'echo should-not-run' }, {
      env: { ...process.env, OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl, OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: roTok.token },
    })
    assert.equal(roRes.isError, true)
    assert.ok(roRes.content[0]!.text.includes('EXEC_POLICY_READ_ONLY_DENIED'))
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('RemoteLaneToolBroker wraps Cc5ToolHost by default with octk1.*, readOnly tightening, >256 KiB spill, Gate 4 detach, and cancel/dispose (Q3/Q4)', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-lane-'))
  let writeCount = 0
  let bigCalled = 0
  let permHandler: ((req: PermissionRequest) => Promise<Record<string, unknown>>) | undefined
  const fakeHost: LaneToolHostLike = {
    tools: async () => [
      { name: 'Read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'Write', description: 'write', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'big_dump', description: 'big', inputSchema: { type: 'object', properties: {} } },
      { name: 'hang_tool', description: 'hang', inputSchema: { type: 'object', properties: {} } },
    ],
    execute: async (name: string) => {
      if (name === 'Read') return { content: [{ type: 'text', text: 'file-contents' }], isError: false }
      if (name === 'Write') { writeCount += 1; return { content: [{ type: 'text', text: 'wrote-ok' }], isError: false } }
      if (name === 'big_dump') { bigCalled += 1; return { content: [{ type: 'text', text: 'Z'.repeat(300 * 1024) }], isError: false } }
      if (name === 'hang_tool') {
        await new Promise<void>((res) => setTimeout(res, 10_000).unref())
        return { content: [{ type: 'text', text: 'done' }], isError: false }
      }
      return { content: [{ type: 'text', text: 'unknown' }], isError: true }
    },
    close: async () => {},
  }

  const laneBroker = new RemoteLaneToolBroker({
    operationId: 'op-p32-lane',
    sessionKey: 'agent:main:webchat:dm:p32-lane',
    walDir: join(workDir, 'tool-broker-wal'),
    detachedFallbackAfterMs: 100,
    getPermissionHandler: () => permHandler,
    loadedActionPolicy: {
      ok: true,
      source: 'default',
      path: '<lane-test>',
      policy: {
        version: 1,
        defaultTier: 'allow',
        extendsDefaults: false,
        rules: [{ id: 'lane-appr', category: 'custom', tier: 'human_approval', reason: 'Approve write', match: { tool: ['Write'] } }],
      },
      warnings: [],
    },
  })
  const textOf = (r: { content: Array<Record<string, unknown>> }) => String(r.content[0]?.text ?? '')
  try {
    // Normal read succeeds
    const r1 = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'Read', arguments: { path: 'a.ts' }, callId: 'lc1', authorityTurnId: 'lt1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
    })
    assert.equal(r1.isError, false)
    assert.equal(textOf(r1), 'file-contents')

    // >256 KiB output formats clean blob_ref + preview
    const rBig = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'big_dump', arguments: {}, callId: 'lc-big', authorityTurnId: 'lt1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
    })
    assert.equal(rBig.isError, false)
    assert.equal(bigCalled, 1)
    assert.ok(textOf(rBig).includes('[tool-broker spilled output:'))

    // Gate 4 approval: approve within window executes once; timeout detaches without executing
    let apprCalls = 0
    permHandler = async () => { apprCalls += 1; return { behavior: 'allow' } }
    const rWriteOk = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'Write', arguments: { path: 'x' }, callId: 'lc-w1', authorityTurnId: 'lt1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
    })
    assert.equal(rWriteOk.isError, false)
    assert.equal(writeCount, 1)
    assert.equal(apprCalls, 1)

    permHandler = () => new Promise(() => {})
    const rWriteDetach = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'Write', arguments: { path: 'y' }, callId: 'lc-w2', authorityTurnId: 'lt1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
    })
    assert.equal(rWriteDetach.isError, true)
    assert.equal(writeCount, 1)
    assert.equal(laneBroker.recordedDetachedCards.length, 1)

    // readOnly turn tightens monotonically & denies Write while allowing Read
    const rRoDeny = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'Write', arguments: { path: 'z' }, callId: 'lc-ro1', authorityTurnId: 'lt2', turnKey: 'tk2', nativeSessionUuid: 'ns1', readOnly: true,
    })
    assert.equal(rRoDeny.isError, true)
    const rRoOk = await laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'Read', arguments: { path: 'a.ts' }, callId: 'lc-ro2', authorityTurnId: 'lt2', turnKey: 'tk2', nativeSessionUuid: 'ns1', readOnly: true,
    })
    assert.equal(rRoOk.isError, false)

    // Cancel aborts in-flight tool (Q4)
    const hangP = laneBroker.executeHostTool({
      host: fakeHost, clientToolName: 'hang_tool', arguments: {}, callId: 'lc-hang', authorityTurnId: 'lt3', turnKey: 'tk3', nativeSessionUuid: 'ns1', readOnly: false,
    })
    await new Promise<void>((res) => setTimeout(res, 30))
    await laneBroker.cancelActive('test_interrupt')
    const hangRes = await hangP
    assert.equal(hangRes.isError, true)
  } finally {
    laneBroker.dispose('test_done')
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Gate 4 55s default blocking-then-detached approval prevents double execution on late response (Q3/R10)', async () => {
  assert.equal(TOOL_BROKER_DEFAULT_DETACHED_FALLBACK_MS, 55_000)
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-gate4-'))
  const settledEvents: Array<{ requestId: string; behavior: string }> = []
  const detachedEvents: string[] = []
  const bridge: ToolBrokerApprovalBridge = {
    openApprovalCard() {},
    markDetachedCard(card) { detachedEvents.push(card.requestId) },
    settleApprovalCard(input) { settledEvents.push({ requestId: input.requestId, behavior: input.behavior }) },
  }
  const runtime = new GatewayToolBrokerRuntime({
    homeDir: workDir,
    detachedFallbackAfterMs: 80,
    approvalBridge: bridge,
    loadedActionPolicy: {
      ok: true,
      source: 'default',
      path: '<gate4-test>',
      policy: {
        version: 1,
        defaultTier: 'allow',
        extendsDefaults: false,
        rules: [{ id: 'g4-rule', category: 'custom', tier: 'human_approval', reason: 'Need human approval', match: { tool: ['g4_write'] } }],
      },
      warnings: [],
    },
  })
  let execCount = 0
  runtime.registerTool({ canonicalName: 'g4_write', readOnly: false, handler: async () => { execCount += 1; return 'executed' } })
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-gate4'
    const lease = runtime.ensureSessionLease(sessionKey)
    const call = makeCall({ leaseId: lease.leaseId, turnId: 'tg4', callId: 'cg4', canonicalName: 'g4_write', arguments: {} })
    const tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'cg4', toolName: 'g4_write' })
    const res = await runtime.server.invoke({ ...call, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: tok.token })
    assert.equal(res.status, 'denied')
    assert.equal(res.approvalStatus, 'detached_pending')
    assert.equal(execCount, 0)
    assert.equal(detachedEvents.length, 1)

    // Late human approval settles persisted card terminal as deny/timeout — MUST NOT re-execute the tool!
    const handled = runtime.handlePermissionResponse({ requestId: detachedEvents[0]!, behavior: 'allow' })
    assert.equal(handled, true)
    await new Promise<void>((r) => setTimeout(r, 30))
    assert.equal(execCount, 0)
    assert.equal(settledEvents.length, 1)
    assert.equal(settledEvents[0]!.behavior, 'deny')
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Sandbox Red Proof v2 runs live R1..R11 verification with 100% red/green pass and deterministic digest', async () => {
  const { runSandboxRedProofV2 } = await loadExternalModule<RedProofV2Module>('scripts/v5-generate-sandbox-red-proof-v2.ts')
  const artifact = await runSandboxRedProofV2()
  assert.equal(artifact.schemaVersion, 2)
  assert.deepEqual(artifact.controlIds, [...SANDBOX_RED_CONTROL_IDS])
  assert.equal(artifact.controls.length, SANDBOX_RED_CONTROL_IDS.length)
  for (const c of artifact.controls) {
    assert.equal(c.redControlCaught, true, `red control failed for ${c.requirementId}: ${c.observedRedCode}`)
    assert.equal(c.greenPassed, true, `green control failed for ${c.requirementId}`)
  }
  assert.equal(artifact.allRedControlsCaught, true)
  assert.equal(artifact.allGreenPassed, true)
  assert.match(artifact.proofSha256, /^[0-9a-f]{64}$/)
})

// ─── Audit R1 Regression Coverage (B01, B02, B03, B05-P32, B07, B08, B09, B10C/D, B12, B13-AGY, B14, W05) ───

test('B01: AskUserQuestion Deny/empty/ambiguous updatedInput.answers denies execution & post-restart ask-user:tb:* card never calls dispatchInbound', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b01-'))
  const settled: Array<{ requestId: string; behavior: string; reason: string }> = []
  let onCardOpened: ((reqId: string) => void) | null = null
  const bridge: ToolBrokerApprovalBridge = {
    openApprovalCard(ctx) {
      const fn = onCardOpened
      onCardOpened = null
      fn?.(ctx.requestId)
    },
    settleApprovalCard(input) {
      settled.push({ requestId: input.requestId, behavior: input.behavior, reason: input.reason })
    },
  }
  const policy: LoadedActionPolicy = {
    ok: true,
    source: 'default',
    path: '<b01-test>',
    policy: {
      version: 1,
      defaultTier: 'allow',
      extendsDefaults: false,
      rules: [{ id: 'b01-rule', category: 'custom', tier: 'human_approval', reason: 'Approve tool', match: { tool: ['b01_write'] } }],
    },
    warnings: [],
  }
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, detachedFallbackAfterMs: 5_000, approvalBridge: bridge, loadedActionPolicy: policy })
  let execCount = 0
  runtime.registerTool({ canonicalName: 'b01_write', readOnly: false, handler: async () => { execCount += 1; return 'ok' } })
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-b01'
    const lease = runtime.ensureSessionLease(sessionKey)
    const runWithReply = async (callId: string, updatedInput: Record<string, unknown>) => {
      const opened = new Promise<string>((r) => { onCardOpened = r })
      const call = makeCall({ leaseId: lease.leaseId, turnId: 'tb01', callId, canonicalName: 'b01_write', arguments: {} })
      const tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId, toolName: 'b01_write' })
      const pending = runtime.server.invoke({ ...call, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: tok.token })
      const reqId = await opened
      assert.equal(runtime.handlePermissionResponse({ requestId: reqId, behavior: 'allow', updatedInput }), true)
      return await pending
    }

    // 1. User selected "Deny" on AskUserQuestion card (client sends behavior: 'allow' with answers.q = 'Deny')
    const denyChoice = await runWithReply('b01-c1', { questions: [{ question: 'Approve tool "b01_write"?' }], answers: { 'Approve tool "b01_write"?': 'Deny' } })
    assert.equal(denyChoice.status, 'denied')
    assert.equal(execCount, 0)
    assert.equal(settled.at(-1)?.behavior, 'deny')

    // 2. Empty updatedInput or empty/ambiguous answers MUST deny
    const emptyUpdated = await runWithReply('b01-c2', {})
    assert.equal(emptyUpdated.status, 'denied')
    const emptyAnswers = await runWithReply('b01-c3', { answers: {} })
    assert.equal(emptyAnswers.status, 'denied')
    const ambiguous = await runWithReply('b01-c4', { answers: { 'Approve tool "b01_write"?': 'Maybe' } })
    assert.equal(ambiguous.status, 'denied')
    assert.equal(execCount, 0)

    // 3. Explicit "Approve" executes once
    const approved = await runWithReply('b01-c5', { questions: [{ question: 'Approve tool "b01_write"?' }], answers: { 'Approve tool "b01_write"?': 'Approve' } })
    assert.equal(approved.status, 'ok')
    assert.equal(execCount, 1)
    assert.equal(settled.at(-1)?.behavior, 'allow')

    // 4. Post-restart persisted `ask-user:tb:*` card handled by askUserPermissions.handlePermissionResponse
    const persisted = buildDetachedAskUserPersistMessage({
      requestId: 'ask-user:tb:appr_post_restart_1',
      questions: [{ question: 'Approve tool "b01_write"?' }],
      sessionKey,
      userId: 'u1',
      channel: 'webchat',
      peer: { id: 'p32-b01', kind: 'dm' },
      expiresAt: Date.now() + 60_000,
    })
    assert.equal(persisted._brokerApproval, true)
    const hydrated = pendingFromDetachedAskUserMessage(persisted as unknown as Record<string, unknown>, {
      userId: 'u1',
      channel: 'webchat',
      peer: { id: 'p32-b01', kind: 'dm' },
      peerKey: 'u1:webchat:p32-b01',
    })
    assert.ok(hydrated)
    assert.equal(hydrated.brokerApproval, true)

    let dispatchCalls = 0
    const patched: Array<Record<string, unknown>> = []
    const broadcasted: Array<Record<string, unknown>> = []
    const host = {
      _pendingPermissions: new Map(),
      _askUserWaiters: new Map(),
      _hydrateDetachedAskUserPending: async () => hydrated,
      _lookupSettlement: () => null,
      _recordSettlement: () => {},
      _broadcastPermissionSettled: (_pk: string, payload: Record<string, unknown>) => { broadcasted.push(payload) },
      _patchDetachedAskUserResolved: async (_p: unknown, _id: string, patch: Record<string, unknown>) => { patched.push(patch) },
      dispatchInbound: async () => { dispatchCalls += 1 },
      sessions: { getByKey: () => null },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as AskUserPermissionsHost

    await handlePermissionResponse.call(host, {
      type: 'inbound.permission_response',
      channel: 'webchat',
      peer: { id: 'p32-b01', kind: 'dm' },
      requestId: 'ask-user:tb:appr_post_restart_1',
      behavior: 'allow',
      updatedInput: { answers: { 'Approve tool "b01_write"?': 'Approve' } },
    })
    assert.equal(dispatchCalls, 0)
    assert.equal(broadcasted.length, 1)
    assert.equal(broadcasted[0]!.behavior, 'deny')
    assert.equal(broadcasted[0]!.reason, 'timeout')
    assert.equal(patched.length, 1)
    assert.deepEqual(patched[0], { _resolved: true, _behavior: 'deny', _settledReason: 'timeout' })
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B02: Antigravity turn tokens live outside launchHome (0400 in 0700 credDir) and revoke immediately on turn cleanup', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b02-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  process.env.OPENCLAUDE_HOME = join(workDir, 'oc-home')
  paths.home = join(workDir, 'storage-home')

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  const unreg = runtime.registerAsAntigravityHookProvider()
  try {
    const proj = projectAntigravityPlatform({
      credential: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:p32-b02',
      gatewayPort: srv.port,
      gatewayToken: 'gw-tok',
      delegationDepth: 0,
      claudeCodePath: REPO_ROOT,
      hostBin: null,
      readOnly: false,
    })
    assert.ok(proj.brokerHook)
    assert.ok(proj.brokerHook.mcpTokenFile)

    // Both credential files MUST sit outside launchHome inside runtime.credDir
    const relHook = relative(proj.launchHome, proj.brokerHook.hookTokenFile)
    const relMcp = relative(proj.launchHome, proj.brokerHook.mcpTokenFile)
    assert.ok(relHook.startsWith('..'), `hookTokenFile leaked inside launchHome: ${proj.brokerHook.hookTokenFile}`)
    assert.ok(relMcp.startsWith('..'), `mcpTokenFile leaked inside launchHome: ${proj.brokerHook.mcpTokenFile}`)
    assert.equal(lstatSync(proj.brokerHook.hookTokenFile).mode & 0o777, 0o400)
    assert.equal(lstatSync(proj.brokerHook.mcpTokenFile).mode & 0o777, 0o400)
    assert.equal((await stat(runtime.credDir)).mode & 0o777, 0o700)

    const copiedHookTok = (await readFile(proj.brokerHook.hookTokenFile, 'utf8')).trim()
    const copiedMcpTok = (await readFile(proj.brokerHook.mcpTokenFile, 'utf8')).trim()

    // Active during turn
    const activeHook = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: copiedHookTok }, { toolName: 'read_file', arguments: {} })
    assert.equal(activeHook.status, 200)
    assert.equal(activeHook.json.decision, 'allow')
    const activeMcp = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: copiedMcpTok }, { toolName: 'oc_bash', arguments: { command: 'echo active_ok' } })
    assert.equal(activeMcp.status, 200)
    assert.equal(activeMcp.json.ok, true)

    // Revoke on turn cleanup -> immediate 401 TOOL_BROKER_TURN_TOKEN_REVOKED + cred files unlinked
    cleanupAntigravityLaunch(proj)
    await new Promise<void>((r) => setTimeout(r, 40))

    const revokedHook = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: copiedHookTok }, { toolName: 'read_file', arguments: {} })
    assert.equal(revokedHook.status, 401)
    assert.equal(revokedHook.json.code, 'TOOL_BROKER_TURN_TOKEN_REVOKED')

    const revokedMcp = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: copiedMcpTok }, { toolName: 'oc_bash', arguments: { command: 'echo should_not_run' } })
    assert.equal(revokedMcp.status, 401)
    assert.equal(revokedMcp.json.errorCode, 'TOOL_BROKER_TURN_TOKEN_REVOKED')

    assert.equal(existsSync(proj.brokerHook.hookTokenFile), false)
    assert.equal(existsSync(proj.brokerHook.mcpTokenFile), false)
  } finally {
    unreg()
    runtime.dispose()
    await srv.close()
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B03: Custom ActionPolicy YAML enforced live (no hardcoded bypass), corrupt YAML fails closed, and misconfigured MCP broker never falls back locally', async () => {
  const { handleOcBash } = await loadExternalModule<LocalCliToolsModule>('packages/mcp-memory/src/localCliTools.ts')
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b03-'))
  const customYamlPath = join(workDir, 'action-policy.yaml')
  await writeFile(
    customYamlPath,
    [
      'version: 1',
      'extendsDefaults: false',
      'defaultTier: allow',
      'rules:',
      '  - id: block-custom-token',
      '    category: destructive_shell',
      '    tier: deny',
      '    reason: Blocked by custom user YAML policy',
      '    match:',
      '      tool: [Bash]',
      '      commandPattern: "custom_yaml_policy_blocked"',
      '',
    ].join('\n'),
    'utf8',
  )
  const corruptYamlPath = join(workDir, 'corrupt-policy.yaml')
  await writeFile(corruptYamlPath, 'version: [unclosed\n  bad: ::::\n', 'utf8')

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, actionPolicyPath: customYamlPath })
  const corruptRuntime = new GatewayToolBrokerRuntime({ homeDir: join(workDir, 'corrupt'), actionPolicyPath: corruptYamlPath })
  const srv = await startPreAuthBrokerServer(runtime)
  const corruptSrv = await startPreAuthBrokerServer(corruptRuntime)
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-b03'
    const hookTok = runtime.issueTurnHookToken({ sessionKey })
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey })

    // Custom YAML blocks benign-looking command on BOTH /hook-evaluate and /mcp-execute
    const hookDeny = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token }, { toolName: 'Bash', arguments: { command: 'echo custom_yaml_policy_blocked' } })
    assert.equal(hookDeny.json.decision, 'deny')
    assert.equal(hookDeny.json.code, 'ACTION_POLICY_DENIED')

    const hookAllow = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token }, { toolName: 'Bash', arguments: { command: 'echo custom_yaml_policy_allowed' } })
    assert.equal(hookAllow.json.decision, 'allow')

    const mcpDeny = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo custom_yaml_policy_blocked' } })
    assert.equal(mcpDeny.status, 403)
    assert.equal((mcpDeny.json.result as { errorCode?: string })?.errorCode, 'ACTION_POLICY_DENIED')

    const mcpAllow = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo custom_yaml_policy_allowed' } })
    assert.equal(mcpAllow.status, 200)
    assert.equal(mcpAllow.json.ok, true)

    // Corrupt YAML fails closed (ok === false -> human_approval -> denied with no approver)
    assert.equal(corruptRuntime.loadAuthoritativeActionPolicy().ok, false)
    const corruptHookTok = corruptRuntime.issueTurnHookToken({ sessionKey: 'agent:main:webchat:dm:p32-b03-corrupt' })
    const corruptEval = await postJson(`${corruptSrv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: corruptHookTok.token }, { toolName: 'Bash', arguments: { command: 'echo harmless' } })
    assert.equal(corruptEval.json.decision, 'deny')
    assert.equal(corruptEval.json.code, 'HUMAN_APPROVAL_DENIED')

    // Misconfigured MCP broker config MUST fail closed with ZERO local execution
    const probeFile = join(workDir, 'must-not-exist.txt')
    const baseCleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workDir }
    const misconfigs: Array<{ label: string; extra: Record<string, string>; expectedCode: string }> = [
      { label: 'non-loopback url', extra: { OPENCLAUDE_TOOL_BROKER_URL: 'https://evil.example', OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: 'octm1.a.b' }, expectedCode: 'TOOL_BROKER_URL_INVALID' },
      { label: 'unreadable token file', extra: { OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl, OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE: join(workDir, 'missing.tok') }, expectedCode: 'TOOL_BROKER_TOKEN_FILE_UNREADABLE' },
      { label: 'partial config missing token', extra: { OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl }, expectedCode: 'TOOL_BROKER_TOKEN_INVALID' },
      { label: 'partial config missing url', extra: { OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: 'octm1.a.b' }, expectedCode: 'TOOL_BROKER_URL_MISSING' },
      { label: 'bad token prefix', extra: { OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl, OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: 'Bearer raw' }, expectedCode: 'TOOL_BROKER_TOKEN_INVALID' },
    ]
    for (const mc of misconfigs) {
      const res = await handleOcBash({ command: `touch ${probeFile}` }, { env: { ...baseCleanEnv, ...mc.extra } })
      assert.equal(res.isError, true, `expected fail-closed for ${mc.label}`)
      assert.ok(res.content[0]!.text.includes(mc.expectedCode), `expected ${mc.expectedCode} for ${mc.label}, got: ${res.content[0]!.text}`)
      assert.equal(existsSync(probeFile), false, `local execution leaked for ${mc.label}`)
    }

    // Unconfigured standalone env still works locally
    const standalone = await handleOcBash({ command: 'echo standalone_ok' }, { env: baseCleanEnv })
    assert.equal(standalone.isError, undefined)
    assert.ok(standalone.content[0]!.text.includes('standalone_ok'))
  } finally {
    runtime.dispose()
    corruptRuntime.dispose()
    await srv.close()
    await corruptSrv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B05-P32: Gateway selfhost gate disables ToolBroker completely on commercial builds (zero runtime, zero WAL, zero hooks, 404 TOOL_BROKER_DISABLED)', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b05-gw-'))
  const oldExempt = process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS
  Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')

  assert.equal(isGatewayToolBrokerSelfhostEnabled(false), false)
  assert.equal(isGatewayToolBrokerSelfhostEnabled(), false)
  assert.equal(isGatewayToolBrokerSelfhostEnabled(true), true)

  const config = {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: 'tok-b05' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: join(workDir, 'sessions.db') },
    defaults: { model: 'deepseek-chat' },
  } as unknown as OpenClaudeConfig
  const agentsConfig: AgentsConfig = { version: 1, default: 'main', agents: [{ id: 'main', name: 'Main' }], routes: [] } as unknown as AgentsConfig
  const gw = new Gateway({ config, agentsConfig, toolBrokerSelfhostEnabled: false })
  try {
    assert.equal((gw as unknown as { _toolBrokerRuntime: unknown })._toolBrokerRuntime, null)
    assert.equal(resolveActiveAntigravityBrokerHook({ sessionKey: 'agent:main:webchat:dm:b05', gatewayPort: 18789, mode: 'normal' }), null)
    assert.equal(await resolveActiveEfficiencyBrokerHook({ protocol: 'ccb', sessionKey: 'agent:main:webchat:dm:b05', gatewayPort: 18789 }), null)

    // Verify commercial preAuth route returns 404 TOOL_BROKER_DISABLED without initializing ToolBrokerRuntime
    const io = (gw as unknown as { preAuthRoutesIo: PreAuthRoutesIo }).preAuthRoutesIo
    let statusCode = 0
    let bodyPayload: Record<string, unknown> = {}
    const fakeRes = {
      writeHead: (code: number) => { statusCode = code },
      end: (raw: string) => { bodyPayload = JSON.parse(raw) as Record<string, unknown> },
      setHeader: () => {},
      headersSent: false,
    } as unknown as ServerResponse
    assert.ok(io.handleToolBrokerLocal)
    await io.handleToolBrokerLocal(
      { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage,
      fakeRes,
      new URL(`http://127.0.0.1${TOOL_BROKER_LOCAL_PREFIX}/invoke`),
    )
    assert.equal(statusCode, 404)
    assert.equal(bodyPayload.errorCode, 'TOOL_BROKER_DISABLED')
    assert.equal((gw as unknown as { _toolBrokerRuntime: unknown })._toolBrokerRuntime, null)
  } finally {
    await gw.shutdown(false).catch((err) => { void err })
    if (oldExempt === undefined) Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
    else process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = oldExempt
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B07: Expired lease replaced with brainGen+1 (old fenced) and read_only turn does not poison subsequent normal turn on same session', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b07-'))
  let nowMs = 1_700_000_000_000
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, clock: () => nowMs })
  const srv = await startPreAuthBrokerServer(runtime)
  const laneBroker = new RemoteLaneToolBroker({
    operationId: 'op-b07-lane',
    sessionKey: 'agent:main:webchat:dm:p32-b07-lane',
    walDir: join(workDir, 'lane-wal'),
    clock: () => nowMs,
  })
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-b07'
    const lease1 = runtime.ensureSessionLease(sessionKey)
    assert.equal(lease1.brainGen, 1)

    // 1. Read-only turn blocks oc_bash while allowing oc_grep; subsequent normal turn on SAME session executes oc_bash
    const roTok = runtime.issueTurnMcpToken({ sessionKey, mode: 'read_only' })
    const roDeny = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: roTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo blocked_in_ro' } })
    assert.equal(roDeny.status, 403)
    assert.equal(roDeny.json.errorCode, 'EXEC_POLICY_READ_ONLY_DENIED')

    const normalTok = runtime.issueTurnMcpToken({ sessionKey, mode: 'normal' })
    const longTok = runtime.issueTurnMcpToken({ sessionKey, mode: 'normal', ttlMs: 3_600_000 })
    const normalOk = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: normalTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo normal_restored' } })
    assert.equal(normalOk.status, 200)
    assert.equal(normalOk.json.ok, true)

    // 2. Advance clock past lease TTL (>15 min) -> ensureSessionLease fences old lease and issues brainGen=2
    nowMs = lease1.expiresAtMs + 10_000
    const lease2 = runtime.ensureSessionLease(sessionKey)
    assert.notEqual(lease2.leaseId, lease1.leaseId)
    assert.equal(lease2.brainGen, 2)
    assert.ok(lease2.expiresAtMs > nowMs)
    assert.equal(runtime.leaseManager.getLease(lease1.leaseId)?.state, 'closed')

    const oldShortRes = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: normalTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo stale' } })
    assert.equal(oldShortRes.status, 401)
    assert.equal(oldShortRes.json.errorCode, 'TOOL_BROKER_TURN_TOKEN_EXPIRED')

    const oldLongRes = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: longTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo stale' } })
    assert.equal(oldLongRes.status, 401)
    assert.equal(oldLongRes.json.errorCode, 'EXEC_LEASE_CLOSED')

    const freshTok = runtime.issueTurnMcpToken({ sessionKey, mode: 'normal' })
    const freshOk = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: freshTok.token }, { toolName: 'oc_bash', arguments: { command: 'echo after_expiry_ok' } })
    assert.equal(freshOk.status, 200)
    assert.equal(freshOk.json.ok, true)

    // 3. RemoteLaneToolBroker also replaces expired baseLease cleanly
    const host: LaneToolHostLike = {
      tools: async () => [{ name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
      execute: async () => ({ content: [{ type: 'text', text: 'lane-ok' }], isError: false }),
      close: async () => {},
    }
    const laneRes = await laneBroker.executeHostTool({
      host, clientToolName: 'Read', arguments: {}, callId: 'b07-lc1', authorityTurnId: 'b07-t1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
    })
    assert.equal(laneRes.isError, false)
    assert.equal(laneBroker.baseLease.brainGen, 2)
  } finally {
    laneBroker.dispose('test_done')
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B08: Disconnect during Gate 4 approval prevents execution on late allow & RemoteLaneToolBroker isolates aborted stuck Cc5ToolHost', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b08-'))
  let openedReqId: ((id: string) => void) | null = null
  const runtime = new GatewayToolBrokerRuntime({
    homeDir: workDir,
    detachedFallbackAfterMs: 5_000,
    approvalBridge: {
      openApprovalCard(ctx) { openedReqId?.(ctx.requestId); openedReqId = null },
    },
    loadedActionPolicy: {
      ok: true,
      source: 'default',
      path: '<b08-test>',
      policy: {
        version: 1,
        defaultTier: 'allow',
        extendsDefaults: false,
        rules: [{ id: 'b08-appr', category: 'custom', tier: 'human_approval', reason: 'Approve', match: { tool: ['b08_write'] } }],
      },
      warnings: [],
    },
  })
  let execCount = 0
  runtime.registerTool({ canonicalName: 'b08_write', readOnly: false, handler: async () => { execCount += 1; return 'must-not-run' } })
  try {
    // 1. Disconnect during Gate 4 approval wait -> TOOL_CALL_CANCELLED, zero execution even if late allow arrives
    const sessionKey = 'agent:main:webchat:dm:p32-b08'
    const lease = runtime.ensureSessionLease(sessionKey)
    const cardP = new Promise<string>((r) => { openedReqId = r })
    const call = makeCall({ leaseId: lease.leaseId, turnId: 'tb08', callId: 'cb08', canonicalName: 'b08_write', arguments: {} })
    const tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'cb08', toolName: 'b08_write' })
    const invP = runtime.server.invoke({ ...call, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey, capabilityToken: tok.token })
    const reqId = await cardP
    runtime.server.markLeaseDisconnected(lease.leaseId, 'b08_disconnect_during_approval')
    runtime.handlePermissionResponse({ requestId: reqId, behavior: 'allow' })
    const invRes = await invP
    assert.equal(invRes.status, 'error')
    assert.equal(invRes.errorCode, 'TOOL_CALL_CANCELLED')
    assert.equal(execCount, 0)

    // 2. RemoteLaneToolBroker isolates stuck Cc5ToolHost on abort so follow-up call never sees CC5_TOOLHOST_CLOSED_OR_BUSY
    let stuckClosed = false
    let resetCalls = 0
    let activeHost: LaneToolHostLike
    const stuckHost: LaneToolHostLike = {
      tools: async () => [],
      execute: async () => {
        if (stuckClosed) throw new Error('CC5_TOOLHOST_CLOSED_OR_BUSY')
        return await new Promise(() => {})
      },
      close: async () => { stuckClosed = true },
    }
    const freshHost: LaneToolHostLike = {
      tools: async () => [],
      execute: async () => ({ content: [{ type: 'text', text: 'recovered-host-ok' }], isError: false }),
      close: async () => {},
    }
    activeHost = stuckHost
    const laneBroker = new RemoteLaneToolBroker({
      operationId: 'op-b08-lane',
      sessionKey: 'agent:main:webchat:dm:p32-b08-lane',
      walDir: join(workDir, 'lane-wal'),
      onHostResetNeeded: async (host) => {
        resetCalls += 1
        if (activeHost === host) activeHost = freshHost
      },
    })
    try {
      const hangP = laneBroker.executeHostTool({
        host: activeHost, clientToolName: 'Read', arguments: {}, callId: 'b08-hang', authorityTurnId: 't1', turnKey: 'tk1', nativeSessionUuid: 'ns1', readOnly: false,
      })
      await new Promise<void>((r) => setTimeout(r, 30))
      await laneBroker.cancelActive('user_abort')
      const cancelled = await hangP
      assert.equal(cancelled.isError, true)
      await laneBroker.waitForHostIsolation()
      assert.equal(stuckClosed, true)
      assert.equal(resetCalls, 1)
      assert.equal(activeHost, freshHost)

      const recovered = await laneBroker.executeHostTool({
        host: activeHost, clientToolName: 'Read', arguments: {}, callId: 'b08-ok', authorityTurnId: 't2', turnKey: 'tk2', nativeSessionUuid: 'ns1', readOnly: false,
      })
      assert.equal(recovered.isError, false)
      assert.equal(String(recovered.content[0]?.text ?? ''), 'recovered-host-ok')
    } finally {
      laneBroker.dispose('test_done')
    }
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B09: Broker-routed oc_bash preserves resumable job_id/status/wait/kill, cwd, lifecycle_class, and non-zero exit isError', async () => {
  const { handleOcBash } = await loadExternalModule<LocalCliToolsModule>('packages/mcp-memory/src/localCliTools.ts')
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b09-'))
  const subDir = join(workDir, 'subdir-b09')
  await mkdir(subDir, { recursive: true })
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey: 'agent:main:webchat:dm:p32-b09' })
    const brokerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workDir,
      OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
      OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: mcpTok.token,
    }

    // 1. Soft-yield + cwd + lifecycle_class -> status -> wait completion
    const first = await handleOcBash(
      { command: 'printf "cwd=%s\\n" "$(pwd)"; sleep 0.5; printf "finished-part2\\n"', cwd: subDir, timeout_ms: 150, kill_on_timeout: false, lifecycle_class: 'managed_job' },
      { env: brokerEnv },
    )
    assert.equal(first.isError, undefined, first.content[0]!.text)
    assert.match(first.content[0]!.text, /status=running job_id=(ocb_\S+)/)
    assert.match(first.content[0]!.text, /lifecycle_class=managed_job/)
    const jobId = /job_id=(ocb_\S+)/.exec(first.content[0]!.text)![1]!

    const statusRes = await handleOcBash({ job_id: jobId, action: 'status' }, { env: brokerEnv })
    assert.equal(statusRes.isError, undefined)

    const waitRes = await handleOcBash({ job_id: jobId, action: 'wait', timeout_ms: 5_000 }, { env: brokerEnv })
    assert.equal(waitRes.isError, undefined, waitRes.content[0]!.text)
    assert.match(waitRes.content[0]!.text, /exit=0/)
    assert.ok(waitRes.content[0]!.text.includes('subdir-b09'))
    assert.ok(waitRes.content[0]!.text.includes('finished-part2'))

    // 2. Kill action terminates long-running job cleanly
    const longJob = await handleOcBash({ command: 'sleep 10', timeout_ms: 100, kill_on_timeout: false }, { env: brokerEnv })
    const killId = /job_id=(ocb_\S+)/.exec(longJob.content[0]!.text)![1]!
    const killed = await handleOcBash({ job_id: killId, action: 'kill' }, { env: brokerEnv })
    assert.equal(killed.isError, undefined)
    assert.match(killed.content[0]!.text, /status=killed/)

    // 3. Non-zero exit preserves isError: true and exit code
    const nonZero = await handleOcBash({ command: 'echo fail_out; exit 7' }, { env: brokerEnv })
    assert.equal(nonZero.isError, true)
    assert.match(nonZero.content[0]!.text, /exit=7/)
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B10C: CCB/Cursor efficiency broker hook provider writes 0600 cred outside session dir, runs CLI-arg runner without broker env, and fails closed after revoke', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b10c-'))
  const policy: LoadedActionPolicy = {
    ok: true,
    source: 'default',
    path: '<b10c-test>',
    policy: {
      version: 1,
      defaultTier: 'allow',
      extendsDefaults: false,
      rules: [{ id: 'b10c-deny', category: 'destructive_shell', tier: 'deny', reason: 'Blocked by B10C policy', match: { tool: ['Bash'], commandPattern: 'b10c_forbidden_cmd' } }],
    },
    warnings: [],
  }
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, loadedActionPolicy: policy })
  const srv = await startPreAuthBrokerServer(runtime)
  const unreg = runtime.registerAsEfficiencyHookProvider()
  try {
    const binding = await resolveActiveEfficiencyBrokerHook({
      protocol: 'ccb',
      sessionKey: 'agent:main:webchat:dm:p32-b10c',
      gatewayPort: srv.port,
    })
    assert.ok(binding)
    assert.equal(lstatSync(binding.hookTokenFile).mode & 0o777, 0o600)

    const ccbCfg = buildCcbEfficiencySettings('deny', true, { brokerHook: binding }) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> } }
    const curCfg = buildCursorEfficiencyHooks('deny', true, { brokerHook: binding }) as { hooks: { beforeShellExecution: Array<{ command: string; timeout: number; failClosed: boolean }> } }
    assert.equal(ccbCfg.hooks.PreToolUse[0]!.hooks[0]!.timeout, 65)
    assert.ok(ccbCfg.hooks.PreToolUse[0]!.hooks[0]!.command.includes('--broker-url='))
    assert.ok(ccbCfg.hooks.PreToolUse[0]!.hooks[0]!.command.includes('--broker-token-file='))
    assert.equal(curCfg.hooks.beforeShellExecution[0]!.timeout, 65)
    assert.equal(curCfg.hooks.beforeShellExecution[0]!.failClosed, true)

    // Run real efficiencyHookRunner.cjs with CLI args ONLY (zero broker env vars!)
    const runner = resolveEfficiencyHookRunner()
    const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workDir }
    const runnerArgs = [runner, '--protocol=ccb', '--mode=deny', `--broker-url=${binding.brokerUrl}`, `--broker-token-file=${binding.hookTokenFile}`]

    const allowOut = await runCmd(process.execPath, runnerArgs, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' } }), env: cleanEnv })
    assert.equal((JSON.parse(allowOut.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'allow')

    const denyOut = await runCmd(process.execPath, runnerArgs, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'b10c_forbidden_cmd' } }), env: cleanEnv })
    assert.equal((JSON.parse(denyOut.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')

    // Revoke binding -> token revoked & file unlinked -> runner fails closed immediately
    binding.revoke()
    await new Promise<void>((r) => setTimeout(r, 40))
    assert.equal(existsSync(binding.hookTokenFile), false)
    const afterRevoke = await runCmd(process.execPath, runnerArgs, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' } }), env: cleanEnv })
    assert.equal((JSON.parse(afterRevoke.stdout.trim()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny')
  } finally {
    unreg()
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B10D + B14: Real mcp-memory stdio server routes oc_bash/oc_grep/oc_glob via broker and deduplicates retries by _meta toolUseId without colliding distinct calls', { timeout: 90_000 }, async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b14-mcp-'))
  const sampleFile = join(workDir, 'b14-sample.txt')
  const counterFile = join(workDir, 'b14-counter.log')
  await writeFile(sampleFile, 'b14_unique_needle\n', 'utf8')

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  const sessionKey = 'agent:main:webchat:dm:p32-b14'
  const mcpTok = runtime.issueTurnMcpToken({ sessionKey, turnId: 'turn-b14-live' })
  const tokenFile = join(workDir, 'mcp-b14.tok')
  await writeFile(tokenFile, `${mcpTok.token}\n`, { mode: 0o600 })

  const child = spawn(join(REPO_ROOT, 'node_modules/.bin/tsx'), ['packages/mcp-memory/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: workDir,
      OPENCLAUDE_HOME: workDir,
      OPENCLAUDE_ENGINE: 'antigravity',
      OPENCLAUDE_AGENT_ID: 'main',
      OPENCLAUDE_GATEWAY_PORT: String(srv.port),
      OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
      OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE: tokenFile,
      OPENCLAUDE_TOOL_BROKER_TURN_ID: 'turn-b14-live',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pendingRpc = new Map<number, (msg: Record<string, unknown>) => void>()
  let stdoutBuf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        if (typeof msg.id === 'number' && pendingRpc.has(msg.id)) {
          const fn = pendingRpc.get(msg.id)!
          pendingRpc.delete(msg.id)
          fn(msg)
        }
      } catch (err) { void err }
    }
  })

  const rpc = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => { pendingRpc.delete(id); rejectRpc(new Error(`MCP RPC timeout for ${method}`)) }, 45_000)
      pendingRpc.set(id, (msg) => { clearTimeout(timer); resolveRpc(msg) })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p32-b14', version: '1.0.0' } })
    assert.ok(init.result)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const listed = await rpc(2, 'tools/list', {})
    const toolNames = ((listed.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name)
    assert.ok(toolNames.includes('oc_bash') && toolNames.includes('oc_grep') && toolNames.includes('oc_glob'))

    const grepCall = await rpc(3, 'tools/call', { name: 'oc_grep', arguments: { pattern: 'b14_unique_needle', path: workDir }, _meta: { 'claudecode/toolUseId': 'tu-grep-1' } })
    assert.ok(String(((grepCall.result as { content?: Array<{ text: string }> })?.content?.[0]?.text) ?? '').includes('b14_unique_needle'))

    const globCall = await rpc(4, 'tools/call', { name: 'oc_glob', arguments: { pattern: '*.txt', path: workDir }, _meta: { 'claudecode/toolUseId': 'tu-glob-1' } })
    assert.ok(String(((globCall.result as { content?: Array<{ text: string }> })?.content?.[0]?.text) ?? '').includes('b14-sample.txt'))

    // B14: Call oc_bash with _meta['claudecode/toolUseId'] = 'tu-retry-1', replay same toolUseId -> NO double side-effect!
    const appendCmd = `echo tick >> ${JSON.stringify(counterFile)} && wc -l < ${JSON.stringify(counterFile)}`
    const call1 = await rpc(5, 'tools/call', { name: 'oc_bash', arguments: { command: appendCmd }, _meta: { 'claudecode/toolUseId': 'tu-retry-1' } })
    assert.notEqual((call1.result as { isError?: boolean })?.isError, true)
    assert.equal((await readFile(counterFile, 'utf8')).trim().split('\n').length, 1)

    const retry1 = await rpc(6, 'tools/call', { name: 'oc_bash', arguments: { command: appendCmd }, _meta: { 'claudecode/toolUseId': 'tu-retry-1' } })
    assert.notEqual((retry1.result as { isError?: boolean })?.isError, true)
    assert.equal((await readFile(counterFile, 'utf8')).trim().split('\n').length, 1)

    // B14: Distinct invocation with IDENTICAL command args & different toolUseId executes fresh -> 2 lines!
    const call2 = await rpc(7, 'tools/call', { name: 'oc_bash', arguments: { command: appendCmd }, _meta: { 'claudecode/toolUseId': 'tu-distinct-2' } })
    assert.notEqual((call2.result as { isError?: boolean })?.isError, true)
    assert.equal((await readFile(counterFile, 'utf8')).trim().split('\n').length, 2)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise<void>((r) => child.once('exit', () => r()))
    }
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B12: /spill-read enforces per-session ownership fail-closed including across broker runtime restart', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b12-'))
  const bigFile = join(workDir, 'b12-big.txt')
  await writeFile(bigFile, 'S'.repeat(300 * 1024), 'utf8')
  const walDir = join(workDir, 'shared-wal')
  const sessionA = 'agent:main:webchat:dm:p32-b12-session-a'
  const sessionB = 'agent:main:webchat:dm:p32-b12-session-b'

  const runtime1 = new GatewayToolBrokerRuntime({ homeDir: workDir, walDir })
  const srv1 = await startPreAuthBrokerServer(runtime1)
  let blobId = ''
  let blobSha = ''
  try {
    const tokA1 = runtime1.issueTurnMcpToken({ sessionKey: sessionA })
    const tokB1 = runtime1.issueTurnMcpToken({ sessionKey: sessionB })

    const spillRes = await postJson(`${srv1.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokA1.token }, { toolName: 'oc_read', arguments: { path: bigFile } })
    assert.equal(spillRes.status, 200)
    const ref = (spillRes.json.result as { output?: { blobId?: string; sha256?: string } })?.output
    blobId = ref?.blobId ?? ''
    blobSha = ref?.sha256 ?? ''
    assert.ok(blobId.length > 0)

    const ownerRead1 = await postJson(`${srv1.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokA1.token }, { blobId, sha256: blobSha, offset: 0, limit: 128 })
    assert.equal(ownerRead1.status, 200)
    assert.equal(ownerRead1.json.bytesRead, 128)

    const crossRead1 = await postJson(`${srv1.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokB1.token }, { blobId, sha256: blobSha, offset: 0, limit: 128 })
    assert.equal(crossRead1.status, 403)
    assert.equal(crossRead1.json.errorCode, 'SPILL_OWNERSHIP_DENIED')
  } finally {
    runtime1.dispose()
    await srv1.close()
  }

  // Fresh restarted runtime on the same walDir MUST preserve ownership via disk .owners.json sidecar
  const runtime2 = new GatewayToolBrokerRuntime({ homeDir: workDir, walDir })
  const srv2 = await startPreAuthBrokerServer(runtime2)
  try {
    const tokA2 = runtime2.issueTurnMcpToken({ sessionKey: sessionA })
    const tokB2 = runtime2.issueTurnMcpToken({ sessionKey: sessionB })

    const ownerRead2 = await postJson(`${srv2.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokA2.token }, { blobId, sha256: blobSha, offset: 0, limit: 128 })
    assert.equal(ownerRead2.status, 200)
    assert.equal(ownerRead2.json.bytesRead, 128)

    const crossRead2 = await postJson(`${srv2.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/spill-read`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokB2.token }, { blobId, sha256: blobSha, offset: 0, limit: 128 })
    assert.equal(crossRead2.status, 403)
    assert.equal(crossRead2.json.errorCode, 'SPILL_OWNERSHIP_DENIED')
  } finally {
    runtime2.dispose()
    await srv2.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B13-AGY: Real AntigravityAdapter with hermeticNoTools disables MCP servers, denies read_file via PreToolUse hook, scrubs broker env, and revokes tokens on finish', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b13-agy-'))
  const capturePath = join(workDir, 'agy-hermetic-capture.json')
  const fakeCliPath = join(workDir, 'fake-agy-b13.cjs')
  const fakeCliSource = `#!${process.execPath}
const fs = require('node:fs')
const { execSync } = require('node:child_process')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  if (!buf.includes('\\n')) return
  const home = process.env.HOME
  const mcp = JSON.parse(fs.readFileSync(home + '/.gemini/config/mcp_config.json', 'utf8'))
  const hooks = JSON.parse(fs.readFileSync(home + '/.gemini/config/hooks.json', 'utf8'))
  const group = Object.values(hooks)[0]
  const cmd = group.PreToolUse[0].hooks[0].command
  const hookOut = execSync(cmd, { input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: '/tmp/a' } } }), encoding: 'utf8' }).trim()
  const leakedBrokerEnv = Object.keys(process.env).filter((k) => k.startsWith('OPENCLAUDE_TOOL_BROKER_') || k.startsWith('OC_TOOL_BROKER_'))
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    mcpServers: mcp.mcpServers,
    hookDecision: JSON.parse(hookOut),
    hermeticEnv: process.env.OC_HERMETIC_NO_TOOLS,
    leakedBrokerEnv,
  }))
  process.stdout.write(JSON.stringify({ event: 'result', sessionId: 'b13-conv-1', result: 'hermetic-ok' }) + '\\n')
  process.exit(0)
})
`
  await writeFile(fakeCliPath, fakeCliSource, 'utf8')
  await chmod(fakeCliPath, 0o755)

  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  const oldCliBin = process.env.OC_ANTIGRAVITY_CLI_BIN
  const oldLeak = process.env.OPENCLAUDE_TOOL_BROKER_MCP_TOKEN
  process.env.OPENCLAUDE_HOME = join(workDir, 'oc-home')
  paths.home = join(workDir, 'storage-home')
  process.env.OC_ANTIGRAVITY_CLI_BIN = fakeCliPath
  process.env.OPENCLAUDE_TOOL_BROKER_MCP_TOKEN = 'octm1.must_be_scrubbed_from_agy_cli'

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  const unreg = runtime.registerAsAntigravityHookProvider()
  try {
    const adapter = new AntigravityAdapter({
      sessionKey: 'agent:main:webchat:dm:p32-b13-hermetic',
      agentId: 'main',
      agentBaseDir: workDir,
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: srv.port, accessToken: 'tok-b13' },
        auth: { mode: 'subscription', claudeCodePath: REPO_ROOT },
        sessions: { dbPath: '' },
        defaults: { model: 'antigravity-gemini-3.8-flash' },
      } as unknown as OpenClaudeConfig,
      model: 'antigravity-gemini-3.8-flash',
      hermeticNoTools: true,
    } as EngineCreateOpts)
    adapter.on('error', () => {})
    adapter.setAntigravityRoute({
      baseUrl: `http://127.0.0.1:${srv.port}/internal/v5/antigravity-relay/route/${'b'.repeat(64)}`,
      routeToken: 'b'.repeat(64),
      accessToken: 'ya29.limited-b13',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })

    const run = adapter.submitTurn({
      input: 'Reply with hermetic-ok only.',
      traceId: 'trace-b13',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await run.submitted
    await run.summary
    await adapter.shutdown()

    const captured = JSON.parse(await readFile(capturePath, 'utf8')) as {
      mcpServers: Record<string, unknown>
      hookDecision: { decision: string; reason: string }
      hermeticEnv: string
      leakedBrokerEnv: string[]
    }
    assert.deepEqual(captured.mcpServers, {})
    assert.equal(captured.hookDecision.decision, 'deny')
    assert.ok(captured.hookDecision.reason.includes('hermetic_turn_forbidden'))
    assert.equal(captured.hermeticEnv, '1')
    assert.deepEqual(captured.leakedBrokerEnv, [])
  } finally {
    unreg()
    runtime.dispose()
    await srv.close()
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    if (oldCliBin === undefined) Reflect.deleteProperty(process.env, 'OC_ANTIGRAVITY_CLI_BIN')
    else process.env.OC_ANTIGRAVITY_CLI_BIN = oldCliBin
    if (oldLeak === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_TOOL_BROKER_MCP_TOKEN')
    else process.env.OPENCLAUDE_TOOL_BROKER_MCP_TOKEN = oldLeak
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('W05: Ambiguous dual-key call_mcp_tool and ExecuteExtraTool wrappers denied in both read_only and normal modes', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-w05-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const roTok = runtime.issueTurnHookToken({ sessionKey: 'agent:main:webchat:dm:p32-w05-ro', mode: 'read_only' })
    const normalTok = runtime.issueTurnHookToken({ sessionKey: 'agent:main:webchat:dm:p32-w05-norm', mode: 'normal' })

    const dualMcpArgs = { ServerName: 'openclaude-memory', server_name: 'evil-server', ToolName: 'oc_grep', tool_name: 'oc_bash', Arguments: {} }
    const roDual = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: roTok.token }, { toolName: 'call_mcp_tool', arguments: dualMcpArgs })
    assert.equal(roDual.json.decision, 'deny')
    assert.equal(roDual.json.code, 'EXEC_POLICY_READ_ONLY_DENIED')

    const normDual = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: normalTok.token }, { toolName: 'call_mcp_tool', arguments: dualMcpArgs })
    assert.equal(normDual.json.decision, 'deny')
    assert.equal(normDual.json.code, 'EXEC_POLICY_AMBIGUOUS_WRAPPER')

    const dualExtra = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: normalTok.token }, { toolName: 'ExecuteExtraTool', arguments: { tool_name: 'oc_read', toolName: 'oc_bash' } })
    assert.equal(dualExtra.json.decision, 'deny')
    assert.equal(dualExtra.json.code, 'EXEC_POLICY_AMBIGUOUS_WRAPPER')
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

// ─── Audit R2 Surgical Regression Coverage (B02-R2, B03-R2, B05-R2, B08-R2, B09-R2) ────────

test('B02-R2: AGY mid-setup failure revokes minted tokens, reused CCB rotates per turn & revokes on finish, and MCP ignores spoofed turnId', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b02-r2-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  const oldExempt = process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS
  process.env.OPENCLAUDE_HOME = join(workDir, 'oc-home')
  paths.home = join(workDir, 'storage-home')
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  const unregEff = runtime.registerAsEfficiencyHookProvider()
  try {
    // 1. AGY mid-setup failure after token minting MUST revoke both octh1.* & octm1.* and unlink cred files
    const failSession = 'agent:main:webchat:dm:p32-b02-r2-agy-fail'
    const hookIssued = runtime.issueTurnHookToken({ sessionKey: failSession, turnId: 'turn-fail-1' })
    const mcpIssued = runtime.issueTurnMcpToken({ sessionKey: failSession, turnId: 'turn-fail-1' })
    const tracked: string[] = []
    let blockedSettingsPath = ''
    assert.throws(() => {
      projectAntigravityPlatform({
        credential: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
        agentId: 'main',
        sessionKey: failSession,
        gatewayPort: srv.port,
        gatewayToken: 'gw-tok',
        delegationDepth: 0,
        claudeCodePath: REPO_ROOT,
        hostBin: null,
        readOnly: false,
        brokerHook: {
          brokerUrl: srv.baseUrl,
          hookToken: hookIssued.token,
          mcpToken: mcpIssued.token,
          credDir: runtime.credDir,
          turnId: 'turn-fail-1',
          trackCredFile: (p: string) => {
            tracked.push(p)
            hookIssued.trackCredFile(p)
            mcpIssued.trackCredFile(p)
            // Force a deterministic mid-setup write failure after hook projection by passing invalid expiry?
            // Even cleaner: make a blocking directory at settings.json inside launchHome on next step via throw!
            if (tracked.length === 2) {
              blockedSettingsPath = p
              throw new Error('INJECTED_MID_SETUP_FAILURE')
            }
          },
          revoke: () => { hookIssued.revoke(); mcpIssued.revoke() },
        },
      })
    }, /INJECTED_MID_SETUP_FAILURE/)
    assert.ok(blockedSettingsPath.length > 0)
    await new Promise<void>((r) => setTimeout(r, 40))
    const failHookRes = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookIssued.token }, { toolName: 'read_file', arguments: {} })
    assert.equal(failHookRes.status, 401)
    assert.equal(failHookRes.json.code, 'TOOL_BROKER_TURN_TOKEN_REVOKED')
    const failMcpRes = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpIssued.token }, { toolName: 'oc_bash', arguments: { command: 'echo no' } })
    assert.equal(failMcpRes.status, 401)
    assert.equal(failMcpRes.json.errorCode, 'TOOL_BROKER_TURN_TOKEN_REVOKED')
    for (const f of tracked) assert.equal(existsSync(f), false)

    // 2. Long-lived reused CCB SubprocessRunner rotates per-turn hook tokens & revokes Turn 1 immediately on finish
    const fakeCcbRoot = join(workDir, 'fake-ccb-b02')
    await mkdir(join(fakeCcbRoot, 'src', 'entrypoints'), { recursive: true })
    await writeFile(
      join(fakeCcbRoot, 'src', 'entrypoints', 'cli.tsx'),
      `let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c: string) => {
  buf += c
  let idx: number
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    try {
      const m = JSON.parse(line)
      if (m.type === 'user') {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\\n')
      }
    } catch {}
  }
})
`,
      'utf8',
    )
    const ccbRunner = new SubprocessRunner({
      sessionKey: 'agent:main:webchat:dm:p32-b02-ccb-reuse',
      agentId: 'main',
      agentBaseDir: workDir,
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: srv.port, accessToken: 'tok-ccb' },
        auth: { mode: 'subscription', claudeCodePath: fakeCcbRoot },
        sessions: { dbPath: '' },
        defaults: { model: 'claude-sonnet-4-5' },
      } as unknown as OpenClaudeConfig,
      model: 'claude-sonnet-4-5',
    })
    ccbRunner.on('error', () => {})
    try {
      await ccbRunner.submit('turn 1')
      const slotPath = (ccbRunner as unknown as { brokerHookSlotPath: string | null }).brokerHookSlotPath
      const pid1 = (ccbRunner as unknown as { proc: { pid?: number } | null }).proc?.pid
      assert.ok(slotPath && existsSync(slotPath), 'CCB turn 1 cred file must exist outside sessionDir')
      assert.ok(pid1 && pid1 > 0)
      const tok1 = (await readFile(slotPath, 'utf8')).trim()
      const eval1 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: tok1 }, { toolName: 'Bash', arguments: { command: 'echo t1' } })
      assert.equal(eval1.status, 200)
      assert.equal(eval1.json.decision, 'allow')

      // Turn 1 finishes -> immediate revocation without tearing down long-lived CLI process
      ccbRunner.revokeTurnBrokerHook()
      await new Promise<void>((r) => setTimeout(r, 40))
      assert.equal(existsSync(slotPath), false, 'Turn 1 cred file must be unlinked on turn finish')
      const eval1Revoked = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: tok1 }, { toolName: 'Bash', arguments: { command: 'echo t1' } })
      assert.equal(eval1Revoked.status, 401)
      assert.equal(eval1Revoked.json.code, 'TOOL_BROKER_TURN_TOKEN_REVOKED')

      // Turn 2 on SAME live CCB process rotates fresh token into slotPath
      await ccbRunner.submit('turn 2')
      const pid2 = (ccbRunner as unknown as { proc: { pid?: number } | null }).proc?.pid
      assert.equal(pid2, pid1, 'CCB process must be reused across Turn 1 -> Turn 2')
      assert.equal(existsSync(slotPath), true)
      const tok2 = (await readFile(slotPath, 'utf8')).trim()
      assert.notEqual(tok2, tok1)
      const eval2 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: tok2 }, { toolName: 'Bash', arguments: { command: 'echo t2' } })
      assert.equal(eval2.status, 200)
      assert.equal(eval2.json.decision, 'allow')
      const eval1StillRevoked = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`, { [TOOL_BROKER_HOOK_TOKEN_HEADER]: tok1 }, { toolName: 'Bash', arguments: { command: 'echo t1' } })
      assert.equal(eval1StillRevoked.status, 401)
    } finally {
      await ccbRunner.shutdown()
    }

    // 3. Authenticated MCP turnId: untrusted body.turnId MUST NOT override claims.turnId
    const mcpCounter = join(workDir, 'mcp-turnid-counter.log')
    const authMcp = runtime.issueTurnMcpToken({ sessionKey: 'agent:main:webchat:dm:p32-b02-mcp-turn', turnId: 'signed-turn-id' })
    const cmd = `echo hit >> ${JSON.stringify(mcpCounter)}`
    const r1 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: authMcp.token }, { toolName: 'oc_bash', callId: 'c-spoof-1', turnId: 'spoofed-turn-A', arguments: { command: cmd } })
    assert.equal(r1.status, 200)
    assert.equal((r1.json.result as { turnId?: string; replayStatus?: string })?.turnId, 'signed-turn-id')
    const r2 = await postJson(`${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`, { [TOOL_BROKER_MCP_TOKEN_HEADER]: authMcp.token }, { toolName: 'oc_bash', callId: 'c-spoof-1', turnId: 'spoofed-turn-B', arguments: { command: cmd } })
    assert.equal(r2.status, 200)
    assert.equal((r2.json.result as { turnId?: string; replayStatus?: string })?.turnId, 'signed-turn-id')
    assert.equal((r2.json.result as { replayStatus?: string })?.replayStatus, 'cached_receipt')
    assert.equal((await readFile(mcpCounter, 'utf8')).trim().split('\n').length, 1)
  } finally {
    unregEff()
    runtime.dispose()
    await srv.close()
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    if (oldExempt === undefined) Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
    else process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = oldExempt
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B03-R2: Selfhost CCB & Cursor abort spawn fail-closed (spawnCount === 0) when broker hook setup fails', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b03-r2-'))
  const spawnMarker = join(workDir, 'must-not-spawn.marker')
  const fakeCcbRoot = join(workDir, 'fake-ccb-b03')
  await mkdir(join(fakeCcbRoot, 'src', 'entrypoints'), { recursive: true })
  await writeFile(
    join(fakeCcbRoot, 'src', 'entrypoints', 'cli.tsx'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(spawnMarker)}, 'SPAWNED')\nprocess.exit(0)\n`,
    'utf8',
  )
  const fakeBin = join(workDir, 'fake-cli-b03.cjs')
  await writeFile(fakeBin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'SPAWNED')\nprocess.exit(0)\n`, 'utf8')
  await chmod(fakeBin, 0o755)

  const oldCursorBin = process.env.OC_CURSOR_WRAPPER_BIN
  const oldExempt = process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS
  process.env.OC_CURSOR_WRAPPER_BIN = fakeBin
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  const unreg = registerEfficiencyBrokerHookProvider(async () => {
    throw new Error('EACCES: simulated credDir write failure')
  })
  try {
    // 1. CCB SubprocessRunner MUST abort before spawning CLI
    const ccb = new SubprocessRunner({
      sessionKey: 'agent:main:webchat:dm:p32-b03-ccb',
      agentId: 'main',
      agentBaseDir: workDir,
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
        auth: { mode: 'subscription', claudeCodePath: fakeCcbRoot },
        sessions: { dbPath: '' },
        defaults: { model: 'claude-sonnet-4-5' },
      } as unknown as OpenClaudeConfig,
      model: 'claude-sonnet-4-5',
    })
    ccb.on('error', () => {})
    await assert.rejects(() => ccb.start(), /TOOL_BROKER_HOOK_SETUP_FAILED/)
    assert.equal(existsSync(spawnMarker), false, 'CCB CLI must NOT be spawned when selfhost broker hook setup fails')
    await ccb.shutdown()

    // 2. CursorAdapter MUST abort before spawning Cursor --force CLI
    const cursor = new CursorAdapter({
      sessionKey: 'agent:main:webchat:dm:p32-b03-cursor',
      agentId: 'main',
      agentBaseDir: workDir,
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
        auth: { mode: 'subscription', claudeCodePath: REPO_ROOT },
        sessions: { dbPath: '' },
        defaults: { model: DEFAULT_CURSOR_ENGINE_MODEL },
      } as unknown as OpenClaudeConfig,
      model: DEFAULT_CURSOR_ENGINE_MODEL,
    } as EngineCreateOpts)
    cursor.on('error', () => {})
    const run = cursor.submitTurn({
      input: 'hello',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(() => run.submitted, /TOOL_BROKER_HOOK_SETUP_FAILED/)
    assert.equal(existsSync(spawnMarker), false, 'Cursor --force CLI must NOT be spawned when selfhost broker hook setup fails')
    await cursor.shutdown()
  } finally {
    unreg()
    if (oldCursorBin === undefined) Reflect.deleteProperty(process.env, 'OC_CURSOR_WRAPPER_BIN')
    else process.env.OC_CURSOR_WRAPPER_BIN = oldCursorBin
    if (oldExempt === undefined) Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
    else process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = oldExempt
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B05-R2 + B10-GW: Non-selfhost AGY projection and RemoteContainerLane create zero credDir/WAL; selfhost Gateway wires live lane broker & capability supplier', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b05-r2-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  const agyHome = join(workDir, 'oc-home-nonselfhost')
  process.env.OPENCLAUDE_HOME = agyHome
  paths.home = join(workDir, 'storage-home-nonselfhost')
  try {
    assert.equal(isSelfhostRemoteLaneBrokerEnabled(), false)

    // 1. Non-selfhost AGY projection MUST NOT create tool-broker-runtime/turn-creds
    const proj = projectAntigravityPlatform({
      credential: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:p32-b05-r2-agy',
      gatewayPort: 18789,
      gatewayToken: 'gw-tok',
      delegationDepth: 0,
      claudeCodePath: REPO_ROOT,
      hostBin: null,
      readOnly: false,
    })
    try {
      assert.equal(existsSync(join(agyHome, 'tool-broker-runtime')), false, 'Non-selfhost AGY must NOT create credDir')
      assert.equal(proj.brokerHook, undefined)
    } finally {
      cleanupAntigravityLaunch(proj)
    }

    // 2. Non-selfhost RemoteContainerLane tool init MUST NOT create defaultBroker or tool-broker-wal
    const opId = randomUUID()
    const execRootNonSelfhost = join(workDir, 'lane-nonselfhost')
    const bindingFixture: RemotePoolBinding = {
      version: REMOTE_DRIVER_PROTOCOL_VERSION,
      backendKind: REMOTE_DRIVER_BACKEND,
      operationId: opId,
      runId: 'run-b05',
      uid: '1',
      containerDbId: '1',
      dockerId: 'ctr-b05',
      sessionKey: 'agent:main:webchat:dm:p32-b05-r2-lane',
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      upstreamModel: 'gemini-4-carbon-high',
      driverId: 'antigravity',
      engineId: 'antigravity',
      authorityEngine: 'antigravity',
      driverVersion: '1.0.0',
      driverDigest: 'a'.repeat(64),
      coreDigest: 'b'.repeat(64),
      probeFingerprint: 'c'.repeat(64),
      manifestSha256: 'd'.repeat(64),
      generation: '1',
      profileId: randomUUID(),
      authEpoch: 'e1',
      capability: 'e'.repeat(64),
      expiresAt: Date.now() + 600_000,
    }
    const makeLane = (executionRoot: string) =>
      new RemoteContainerLane(
        {
          sessionKey: 'agent:main:webchat:dm:p32-b05-r2-lane',
          agentId: 'main',
          agentBaseDir: workDir,
          executionBackend: remotePoolBackendOf(bindingFixture),
          config: {
            version: 1,
            gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'tok' },
            auth: { mode: 'subscription', claudeCodePath: REPO_ROOT },
            sessions: { dbPath: '' },
            defaults: { model: 'antigravity-gemini-3.8-flash' },
          } as unknown as OpenClaudeConfig,
        } as EngineCreateOpts,
        {
          executionRoot,
          binding: bindingFixture,
          keyring: new Map(),
          call: async () => ({ remoteStopped: true }),
          toolContextFactory: async () => ({
            profile: { cwd: workDir, env: {}, maxOutputBytes: 65536 } as never,
            env: {},
            cleanup: () => {},
          }),
          hostFactory: (): LaneToolHost => ({
            tools: async () => [{ name: 'Read', description: 'read', inputSchema: { type: 'object', properties: {} } }],
            execute: async () => ({ content: [{ type: 'text', text: 'baseline-ok' }], isError: false }),
            close: async () => {},
          }),
        },
      )

    const nonSelfhostLane = makeLane(execRootNonSelfhost)
    await (nonSelfhostLane as unknown as { ensureTools: (v: boolean) => Promise<unknown> }).ensureTools(false)
    assert.equal((nonSelfhostLane as unknown as { defaultBroker?: unknown }).defaultBroker, undefined)
    assert.equal(existsSync(join(execRootNonSelfhost, 'tool-broker-wal')), false, 'Non-selfhost lane must NOT create WAL dir')
    await nonSelfhostLane.stopLane()

    // 3. Selfhost Gateway runtime registers RemoteLaneBrokerProvider -> lane automatically attaches live defaultBroker & capability supplier!
    const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, registerRemoteLaneBroker: true })
    try {
      assert.equal(isSelfhostRemoteLaneBrokerEnabled(), true)
      const execRootSelfhost = join(workDir, 'lane-selfhost')
      const selfhostLane = makeLane(execRootSelfhost)
      await (selfhostLane as unknown as { ensureTools: (v: boolean) => Promise<unknown> }).ensureTools(false)
      assert.ok((selfhostLane as unknown as { defaultBroker?: unknown }).defaultBroker, 'Selfhost lane must attach live defaultBroker')
      const binding = (selfhostLane as unknown as { selfhostBrokerBinding?: { issueCapabilityToken?: (req: { callId: string; toolName: string; sessionKey: string; leaseId: string }) => string | Promise<string> } }).selfhostBrokerBinding
      assert.ok(binding?.issueCapabilityToken)
      const minted = await binding!.issueCapabilityToken!({ callId: 'c-lane-1', toolName: 'Read', sessionKey: 'agent:main:webchat:dm:p32-b05-r2-lane', leaseId: opId })
      assert.ok(minted.startsWith('octk1.'))
      await selfhostLane.stopLane()
    } finally {
      runtime.dispose()
      assert.equal(isSelfhostRemoteLaneBrokerEnabled(), false)
    }
  } finally {
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B08-R2: Composite (leaseId, callId) inFlight key isolates concurrent leases sharing identical JSON-RPC callId', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b08-r2-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const started = new Map<string, () => void>()
  const releaseLeaseB = { resolve: () => {} }
  const leaseBWait = new Promise<void>((r) => { releaseLeaseB.resolve = r })
  runtime.registerTool({
    canonicalName: 'b08_barrier',
    readOnly: true,
    handler: async (args, ctx) => {
      started.get(String(args.tag))?.()
      if (args.tag === 'A') {
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 10_000)
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('lease_a_aborted')) }, { once: true })
        })
      } else {
        await leaseBWait
      }
      return { tag: args.tag, ok: true }
    },
  })
  try {
    const sessA = 'agent:main:webchat:dm:p32-b08-r2-a'
    const sessB = 'agent:main:webchat:dm:p32-b08-r2-b'
    const leaseA = runtime.ensureSessionLease(sessA)
    const leaseB = runtime.ensureSessionLease(sessB)
    const sharedCallId = 'mcp_rpc_1'

    const startedA = new Promise<void>((r) => started.set('A', r))
    const startedB = new Promise<void>((r) => started.set('B', r))
    const callA = makeCall({ leaseId: leaseA.leaseId, turnId: 't-a', callId: sharedCallId, canonicalName: 'b08_barrier', arguments: { tag: 'A' } })
    const callB = makeCall({ leaseId: leaseB.leaseId, turnId: 't-b', callId: sharedCallId, canonicalName: 'b08_barrier', arguments: { tag: 'B' } })
    const tokA = runtime.issueSingleUseCapabilityToken({ sessionKey: sessA, callId: sharedCallId, toolName: 'b08_barrier' })
    const tokB = runtime.issueSingleUseCapabilityToken({ sessionKey: sessB, callId: sharedCallId, toolName: 'b08_barrier' })

    const pA = runtime.server.invoke({ ...callA, fencingToken: leaseA.fencingToken, brainGen: leaseA.brainGen, sessionKey: sessA, capabilityToken: tokA.token })
    const pB = runtime.server.invoke({ ...callB, fencingToken: leaseB.fencingToken, brainGen: leaseB.brainGen, sessionKey: sessB, capabilityToken: tokB.token })
    await Promise.all([startedA, startedB])

    // Cancel Lease A's callId 'mcp_rpc_1' — MUST NOT cancel Lease B's concurrent 'mcp_rpc_1'!
    await runtime.server.cancel(sharedCallId, 'cancel_only_lease_a', leaseA.leaseId)
    const resA = await pA
    assert.equal(resA.status, 'error')
    assert.equal(resA.errorCode, 'TOOL_CALL_CANCELLED')

    releaseLeaseB.resolve()
    const resB = await pB
    assert.equal(resB.status, 'ok')
    assert.deepEqual(resB.output, { tag: 'B', ok: true })
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B09-R2: Real sleep 2 at timeout_ms=1000 & kill_on_timeout=false soft-yields status=running (ephemeral_turn & managed_job) and completes on wait, while kill_on_timeout=true and cancel still kill', async () => {
  const { handleOcBash } = await loadExternalModule<LocalCliToolsModule>('packages/mcp-memory/src/localCliTools.ts')
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b09-r2-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-b09-r2'
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey })
    const brokerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: workDir,
      OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
      OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: mcpTok.token,
    }

    // 1. Exact Audit R2 probe: default ephemeral_turn + timeout_ms=1000 + outer timeoutMs=1000 + kill_on_timeout=false on `sleep 2`
    const rawSoft = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token },
      { toolName: 'oc_bash', timeoutMs: 1000, arguments: { command: 'sleep 2 && echo b09_ephemeral_done', timeout_ms: 1000, kill_on_timeout: false } },
    )
    assert.equal(rawSoft.status, 200)
    assert.equal(rawSoft.json.ok, true)
    const rawOut = (rawSoft.json.result as { output?: { kind?: string; jobId?: string; text?: string } })?.output
    assert.equal(rawOut?.kind, 'running', `Expected running (not killed), got: ${JSON.stringify(rawOut)}`)
    assert.ok(rawOut?.jobId?.startsWith('ocb_'))

    const ephWait = await handleOcBash({ job_id: rawOut!.jobId!, action: 'wait', timeout_ms: 5_000 }, { env: brokerEnv })
    assert.equal(ephWait.isError, undefined, ephWait.content[0]!.text)
    assert.match(ephWait.content[0]!.text, /exit=0/)
    assert.ok(ephWait.content[0]!.text.includes('b09_ephemeral_done'))

    // 2. Through MCP handleOcBash client with timeout_ms=1000 on managed_job
    const managedFirst = await handleOcBash(
      { command: 'sleep 2 && echo b09_managed_done', timeout_ms: 1000, kill_on_timeout: false, lifecycle_class: 'managed_job' },
      { env: brokerEnv },
    )
    assert.equal(managedFirst.isError, undefined, managedFirst.content[0]!.text)
    assert.match(managedFirst.content[0]!.text, /status=running job_id=(ocb_\S+)/)
    const managedJobId = /job_id=(ocb_\S+)/.exec(managedFirst.content[0]!.text)![1]!
    const managedWait = await handleOcBash({ job_id: managedJobId, action: 'wait', timeout_ms: 5_000 }, { env: brokerEnv })
    assert.equal(managedWait.isError, undefined, managedWait.content[0]!.text)
    assert.ok(managedWait.content[0]!.text.includes('b09_managed_done'))

    // 3. kill_on_timeout=true at timeout_ms=1000 MUST hard-kill
    const hardKill = await handleOcBash({ command: 'sleep 5', timeout_ms: 1000, kill_on_timeout: true }, { env: brokerEnv })
    assert.equal(hardKill.isError, true)
    assert.match(hardKill.content[0]!.text, /timed out after 1000ms/)

    // 4. Explicit cancelSessionCalls during ephemeral_turn MUST still kill
    const cancelSess = 'agent:main:webchat:dm:p32-b09-r2-cancel'
    const cancelTok = runtime.issueTurnMcpToken({ sessionKey: cancelSess })
    const cancelStart = Date.now()
    const cancelP = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: cancelTok.token },
      { toolName: 'oc_bash', arguments: { command: 'sleep 10', timeout_ms: 5000, kill_on_timeout: false } },
    )
    await new Promise<void>((r) => setTimeout(r, 150))
    runtime.cancelSessionCalls(cancelSess, 'user_cancelled_b09')
    const cancelRes = await cancelP
    const cancelElapsedMs = Date.now() - cancelStart
    const cancelOut = (cancelRes.json.result as { status?: string; errorCode?: string; output?: { kind?: string } })
    assert.ok(cancelElapsedMs < 2_500, `Expected immediate cancel, took ${cancelElapsedMs}ms`)
    assert.ok(
      cancelOut?.output?.kind === 'killed' || cancelOut?.errorCode === 'TOOL_CALL_CANCELLED' || cancelOut?.errorCode === 'UNKNOWN_EFFECT_FENCED',
      `Expected killed/cancelled/fenced, got: ${JSON.stringify(cancelRes.json)}`,
    )
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})


// ─── Architecture Steward S1, S2, S3 Hard-Veto Regression Coverage ─────────────────────────

test('Steward S1: 16 unqueried finished oc_bash jobs release running capacity for same and second sessions without too_many_jobs', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-steward-s1-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sess1 = 'agent:main:webchat:dm:p32-s1-sess1'
    const sess2 = 'agent:main:webchat:dm:p32-s1-sess2'
    const tok1 = runtime.issueTurnMcpToken({ sessionKey: sess1 })
    const tok2 = runtime.issueTurnMcpToken({ sessionKey: sess2 })

    // Start 16 `sleep 0.1` jobs returning `running` at timeout_ms=50, kill_on_timeout=false,
    // and DO NOT query them after they finish.
    const started = await Promise.all(
      Array.from({ length: 16 }, (_, idx) =>
        postJson(
          `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
          { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok1.token },
          {
            toolName: 'oc_bash',
            callId: `s1-sleep-${idx}`,
            arguments: { command: 'sleep 0.1', timeout_ms: 50, kill_on_timeout: false },
          },
        ),
      ),
    )
    for (const res of started) {
      assert.equal(res.status, 200)
      assert.equal(res.json.ok, true)
      const out = (res.json.result as { output?: { kind?: string } })?.output
      assert.ok(out?.kind === 'running' || out?.kind === 'finished', `Unexpected job outcome: ${JSON.stringify(out)}`)
    }

    // Wait for all 16 short sleeps to exit naturally without querying any job_id.
    const deadline = Date.now() + 5_000
    while (runtime.bashJobs.activeRunningCount() > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 30))
    }
    assert.equal(runtime.bashJobs.activeRunningCount(), 0, 'All 16 finished jobs must free active running capacity')

    // BOTH Session 1 and Session 2 must succeed running /bin/true (NEVER too_many_jobs!).
    const runSame = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok1.token },
      { toolName: 'oc_bash', callId: 's1-true-same', arguments: { command: '/bin/true' } },
    )
    assert.equal(runSame.status, 200)
    assert.equal(runSame.json.ok, true)
    const outSame = (runSame.json.result as { output?: { kind?: string; exitCode?: number } })?.output
    assert.equal(outSame?.kind, 'finished')
    assert.equal(outSame?.exitCode, 0)

    const runOther = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok2.token },
      { toolName: 'oc_bash', callId: 's1-true-other', arguments: { command: '/bin/true' } },
    )
    assert.equal(runOther.status, 200)
    assert.equal(runOther.json.ok, true)
    const outOther = (runOther.json.result as { output?: { kind?: string; exitCode?: number } })?.output
    assert.equal(outOther?.kind, 'finished')
    assert.equal(outOther?.exitCode, 0)
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S2: Session-bound workspaceCwd isolates oc_bash, oc_read, oc_grep, oc_glob, oc_find, oc_tree per session (never Gateway process.cwd())', async () => {
  const { handleOcBash, handleOcFind, handleOcGlob, handleOcGrep, handleOcRead, handleOcTree } =
    await loadExternalModule<LocalCliToolsModule>('packages/mcp-memory/src/localCliTools.ts')
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-steward-s2-'))
  const oldHome = process.env.OPENCLAUDE_HOME
  const oldStorageHome = paths.home
  process.env.OPENCLAUDE_HOME = join(workDir, 'oc-home')
  paths.home = join(workDir, 'storage-home')

  const dirA = join(workDir, 'project-a')
  const dirB = join(workDir, 'project-b')
  await mkdir(join(dirA, 'sub'), { recursive: true })
  await mkdir(join(dirB, 'sub'), { recursive: true })
  await writeFile(join(dirA, 'marker-a.txt'), 'STEWARD_S2_ALPHA_ONLY\n', 'utf8')
  await writeFile(join(dirA, 'sub', 'rel-a.txt'), 'REL_ALPHA_BODY\n', 'utf8')
  await writeFile(join(dirB, 'marker-b.txt'), 'STEWARD_S2_BETA_ONLY\n', 'utf8')
  await writeFile(join(dirB, 'sub', 'rel-b.txt'), 'REL_BETA_BODY\n', 'utf8')

  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startPreAuthBrokerServer(runtime)
  const unregAgy = runtime.registerAsAntigravityHookProvider()
  const unregEff = runtime.registerAsEfficiencyHookProvider()
  try {
    const sessA = 'agent:main:webchat:dm:p32-s2-a'
    const sessB = 'agent:main:webchat:dm:p32-s2-b'
    const sessEff = 'agent:main:webchat:dm:p32-s2-eff'

    // Bind Session A through real Antigravity projection (`workspaceCwd: dirA`).
    const projA = projectAntigravityPlatform({
      credential: { accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
      agentId: 'main',
      sessionKey: sessA,
      gatewayPort: srv.port,
      gatewayToken: 'gw-tok',
      delegationDepth: 0,
      claudeCodePath: REPO_ROOT,
      hostBin: null,
      readOnly: false,
      workspaceCwd: dirA,
    })

    // Also verify EfficiencyHookProvider threads workspaceCwd onto the issued turn token.
    const effBinding = await resolveActiveEfficiencyBrokerHook({
      protocol: 'ccb',
      sessionKey: sessEff,
      gatewayPort: srv.port,
      workspaceCwd: dirB,
    })
    assert.ok(effBinding)
    const effClaims = runtime.verifyTurnScopedToken((await readFile(effBinding!.hookTokenFile, 'utf8')).trim(), 'hook')
    assert.equal(effClaims.workspaceCwd, resolve(dirB))
    effBinding!.revoke()

    // Bind Session B directly to `workspaceCwd: dirB`.
    const tokB = runtime.issueTurnMcpToken({ sessionKey: sessB, workspaceCwd: dirB })

    try {
      assert.ok(projA.brokerHook?.mcpTokenFile)
      const envA: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workDir,
        OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
        OPENCLAUDE_TOOL_BROKER_MCP_TOKEN_FILE: projA.brokerHook!.mcpTokenFile!,
      }
      const envB: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: workDir,
        OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
        OPENCLAUDE_TOOL_BROKER_MCP_TOKEN: tokB.token,
      }

      const realA = await realpath(dirA)
      const realB = await realpath(dirB)
      const realGatewayCwd = await realpath(process.cwd())

      // 1. oc_bash pwd executes strictly inside dirA / dirB (and relative cwd resolves inside dirA), NEVER Gateway cwd!
      const pwdA = await handleOcBash({ command: 'pwd -P' }, { env: envA })
      assert.equal(pwdA.isError, undefined, pwdA.content[0]!.text)
      assert.ok(pwdA.content[0]!.text.includes(realA), `Expected ${realA}, got ${pwdA.content[0]!.text}`)
      assert.equal(pwdA.content[0]!.text.includes(realGatewayCwd), false)

      const pwdASub = await handleOcBash({ command: 'pwd -P', cwd: 'sub' }, { env: envA })
      assert.equal(pwdASub.isError, undefined, pwdASub.content[0]!.text)
      assert.ok(pwdASub.content[0]!.text.includes(join(realA, 'sub')))

      const pwdB = await handleOcBash({ command: 'pwd -P' }, { env: envB })
      assert.equal(pwdB.isError, undefined, pwdB.content[0]!.text)
      assert.ok(pwdB.content[0]!.text.includes(realB), `Expected ${realB}, got ${pwdB.content[0]!.text}`)
      assert.equal(pwdB.content[0]!.text.includes(realA), false)

      // 2. oc_read resolves relative path against workspaceCwd
      const readA = await handleOcRead({ path: 'sub/rel-a.txt' }, { env: envA })
      assert.equal(readA.content[0]!.text.trim(), 'REL_ALPHA_BODY')
      const readB = await handleOcRead({ path: 'sub/rel-b.txt' }, { env: envB })
      assert.equal(readB.content[0]!.text.trim(), 'REL_BETA_BODY')

      // 3. oc_grep searches strictly inside dirA / dirB
      const grepA = await handleOcGrep({ pattern: 'STEWARD_S2_' }, { env: envA })
      assert.ok(grepA.content[0]!.text.includes('STEWARD_S2_ALPHA_ONLY'))
      assert.equal(grepA.content[0]!.text.includes('STEWARD_S2_BETA_ONLY'), false)

      const grepB = await handleOcGrep({ pattern: 'STEWARD_S2_' }, { env: envB })
      assert.ok(grepB.content[0]!.text.includes('STEWARD_S2_BETA_ONLY'))
      assert.equal(grepB.content[0]!.text.includes('STEWARD_S2_ALPHA_ONLY'), false)

      // 4. oc_glob, oc_find, oc_tree resolve strictly inside dirA / dirB
      const globA = await handleOcGlob({ pattern: 'marker-*.txt' }, { env: envA })
      assert.ok(globA.content[0]!.text.includes('marker-a.txt'))
      assert.equal(globA.content[0]!.text.includes('marker-b.txt'), false)

      const globB = await handleOcGlob({ pattern: 'marker-*.txt' }, { env: envB })
      assert.ok(globB.content[0]!.text.includes('marker-b.txt'))
      assert.equal(globB.content[0]!.text.includes('marker-a.txt'), false)

      const findA = await handleOcFind({}, { env: envA })
      assert.ok(findA.content[0]!.text.includes('marker-a.txt'))
      assert.equal(findA.content[0]!.text.includes('marker-b.txt'), false)

      const treeB = await handleOcTree({}, { env: envB })
      assert.ok(treeB.content[0]!.text.includes('marker-b.txt'))
      assert.equal(treeB.content[0]!.text.includes('marker-a.txt'), false)
    } finally {
      cleanupAntigravityLaunch(projA)
    }
  } finally {
    unregAgy()
    unregEff()
    runtime.dispose()
    await srv.close()
    if (oldHome === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_HOME')
    else process.env.OPENCLAUDE_HOME = oldHome
    paths.home = oldStorageHome
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S3: Active-turn sliding renewal crosses multiple 15m TTL boundaries while preserving hard revocation, brainGen fencing, and idle expiry', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-steward-s3-'))
  let nowMs = 1_700_000_000_000
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, clock: () => nowMs })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sessLong = 'agent:main:webchat:dm:p32-s3-long'
    const sessIdle = 'agent:main:webchat:dm:p32-s3-idle'
    const hookTok = runtime.issueTurnHookToken({ sessionKey: sessLong })
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey: sessLong })
    const idleTok = runtime.issueTurnHookToken({ sessionKey: sessIdle })

    const verifyAt = async (label: string) => {
      const h = await postJson(
        `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
        { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token },
        { toolName: 'read_file', arguments: { path: '/tmp/ok' } },
      )
      assert.equal(h.status, 200, `${label} hook expected 200, got ${JSON.stringify(h.json)}`)
      assert.equal(h.json.decision, 'allow')

      const m = await postJson(
        `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
        { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token },
        { toolName: 'oc_bash', callId: `s3-call-${label}`, arguments: { command: '/bin/true' } },
      )
      assert.equal(m.status, 200, `${label} mcp expected 200, got ${JSON.stringify(m.json)}`)
      assert.equal(m.json.ok, true)
    }

    // Active turn crosses t=10m, t=20m, and t=32m (multiple 15m TTL windows) -> ALL SUCCEED!
    nowMs += 10 * 60_000
    await verifyAt('t10m')

    nowMs += 10 * 60_000 // t = 20m (> initial 15m expiry)
    await verifyAt('t20m')

    nowMs += 12 * 60_000 // t = 32m (> two 15m windows)
    await verifyAt('t32m')

    // Idle unrefreshed token from t=0 past 15m+1ms MUST still expire!
    const idleExpired = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: idleTok.token },
      { toolName: 'read_file', arguments: {} },
    )
    assert.equal(idleExpired.status, 401)
    assert.equal(idleExpired.json.code, 'TOOL_BROKER_TURN_TOKEN_EXPIRED')

    // Exact 15m + 1ms idle expiry check
    const exactIdleTok = runtime.issueTurnHookToken({ sessionKey: 'agent:main:webchat:dm:p32-s3-exact-idle' })
    const savedNow = nowMs
    nowMs = savedNow + 15 * 60_000 + 1
    const exactIdleRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: exactIdleTok.token },
      { toolName: 'read_file', arguments: {} },
    )
    assert.equal(exactIdleRes.status, 401)
    assert.equal(exactIdleRes.json.code, 'TOOL_BROKER_TURN_TOKEN_EXPIRED')
    nowMs = savedNow

    // Explicit revoke() immediately fails with TOOL_BROKER_TURN_TOKEN_REVOKED
    hookTok.revoke()
    const revokedRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token },
      { toolName: 'read_file', arguments: {} },
    )
    assert.equal(revokedRes.status, 401)
    assert.equal(revokedRes.json.code, 'TOOL_BROKER_TURN_TOKEN_REVOKED')

    // Bumping brainGen via rebindSessionBrain immediately fences active mcpTok with EXEC_FENCING_TOKEN_STALE
    await runtime.rebindSessionBrain(sessLong, 2)
    const fencedRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token },
      { toolName: 'oc_bash', callId: 's3-fenced', arguments: { command: '/bin/true' } },
    )
    assert.equal(fencedRes.status, 401)
    assert.equal(fencedRes.json.errorCode, 'EXEC_FENCING_TOKEN_STALE')
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S4: handleHookEvaluate re-verifies revocation, session Stop, and policy tightening after async eval before allow/mint', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s4-hook-recheck-'))
  let releaseReview!: () => void
  let reviewEntered!: () => void
  const resetDeferred = () => {
    const entered = new Promise<void>((r) => { reviewEntered = r })
    const gate = new Promise<void>((r) => { releaseReview = r })
    return { entered, gate }
  }
  let deferred = resetDeferred()
  const policyPath = join(workDir, 'action-policy.yaml')
  await writeFile(
    policyPath,
    [
      'version: 1',
      'extendsDefaults: false',
      'defaultTier: allow',
      'rules:',
      '  - id: review-write',
      '    category: destructive_shell',
      '    tier: ai_review',
      '    reason: async review write',
      '    match:',
      '      tool: [Write]',
      '',
    ].join('\n'),
    'utf8',
  )
  const runtime = new GatewayToolBrokerRuntime({
    homeDir: workDir,
    actionPolicyPath: policyPath,
    defaultMainModel: 'gpt-6.2-astra',
    aiReviewHook: async (req) => {
      reviewEntered()
      await deferred.gate
      return {
        verdict: 'allow',
        reason: 'approved by async reviewer',
        reviewerModel: req.reviewerModel,
        readOnlyEnforced: true,
        confidence: 0.99,
      }
    },
  })
  try {
    // (a) Stop / cancelSessionCalls during pending async evaluation -> denied, NO capabilityToken minted
    const sessStop = 'agent:main:webchat:dm:p32-s4-stop'
    const tokStop = runtime.issueTurnHookToken({ sessionKey: sessStop, mode: 'normal' })
    const stopEval = runtime.handleHookEvaluate(tokStop.token, {
      toolName: 'Write',
      arguments: { path: 'a.txt', content: 'x' },
      mintCapabilityToken: true,
    })
    await deferred.entered
    runtime.cancelSessionCalls(sessStop, 'user_stop')
    releaseReview()
    const stopRes = await stopEval
    assert.equal(stopRes.body.decision, 'deny')
    assert.equal(stopRes.body.capabilityToken, undefined)

    // (b) Turn scope revocation during pending async evaluation -> 401 denied, NO capabilityToken
    deferred = resetDeferred()
    const sessRevoke = 'agent:main:webchat:dm:p32-s4-revoke'
    const tokRevoke = runtime.issueTurnHookToken({ sessionKey: sessRevoke, mode: 'normal', turnId: 'turn-s4-rev' })
    const revokeEval = runtime.handleHookEvaluate(tokRevoke.token, {
      toolName: 'Write',
      arguments: { path: 'b.txt', content: 'y' },
      mintCapabilityToken: true,
    })
    await deferred.entered
    runtime.revokeTurnScope(sessRevoke, 'turn-s4-rev')
    releaseReview()
    const revokeRes = await revokeEval
    assert.equal(revokeRes.status, 401)
    assert.equal(revokeRes.body.decision, 'deny')
    assert.equal(revokeRes.body.code, 'TOOL_BROKER_TURN_TOKEN_REVOKED')
    assert.equal(revokeRes.body.capabilityToken, undefined)

    // (c) Session policy tightened to read_only during pending Write eval -> denied, NO capabilityToken
    deferred = resetDeferred()
    const sessTighten = 'agent:main:webchat:dm:p32-s4-tighten'
    const tokTighten = runtime.issueTurnHookToken({ sessionKey: sessTighten, mode: 'normal' })
    const tightenEval = runtime.handleHookEvaluate(tokTighten.token, {
      toolName: 'Write',
      arguments: { path: 'c.txt', content: 'z' },
      mintCapabilityToken: true,
    })
    await deferred.entered
    runtime.tightenSessionMode(sessTighten, 'read_only')
    releaseReview()
    const tightenRes = await tightenEval
    assert.equal(tightenRes.body.decision, 'deny')
    assert.equal(tightenRes.body.code, 'EXEC_POLICY_READ_ONLY_DENIED')
    assert.equal(tightenRes.body.capabilityToken, undefined)
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S5: RemoteLaneToolBroker renews active read-only lease and replaces expired read-only lease with unique ID across TTLs', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s5-ro-lease-'))
  let nowMs = Date.parse('2026-11-27T12:00:00.000Z')
  const broker = new RemoteLaneToolBroker({
    sessionKey: 'agent:main:webchat:dm:p32-s5-ro',
    operationId: 'op-s5-ro-long',
    walDir: join(workDir, 'wal'),
    clock: () => nowMs,
  })
  const hostCalls: string[] = []
  const fakeHost: LaneToolHostLike = {
    tools: async () => [],
    execute: async (toolName, args) => {
      const fp = args && typeof args === 'object' && 'file_path' in args ? String((args as Record<string, unknown>).file_path ?? '') : ''
      hostCalls.push(`${toolName}:${fp}`)
      return { content: [{ type: 'text', text: `ok:${toolName}` }], isError: false }
    },
    close: async () => {},
  }
  const runRead = (callId: string) =>
    broker.executeHostTool({
      host: fakeHost,
      clientToolName: 'Read',
      arguments: { file_path: `/tmp/${callId}.md` },
      callId,
      authorityTurnId: 'ro-turn-long-1',
      turnKey: 'tk-s5',
      nativeSessionUuid: 'nat-s5',
      readOnly: true,
    })
  try {
    // t=0m: initial read_only lease succeeds
    const r0 = await runRead('c-0m')
    assert.equal(r0.isError, false)

    // t=14m30s: proactively renews BOTH baseLease and active read-only lease
    nowMs += 14 * 60_000 + 30_000
    const r14 = await runRead('c-14m30s')
    assert.equal(r14.isError, false)

    // t=16m: still succeeds (previously threw EXEC_LEASE_DUPLICATE!)
    nowMs += 90_000
    const r16 = await runRead('c-16m')
    assert.equal(r16.isError, false)

    // t=36m (jump >15m past read-only & base TTL -> triggers full expiry replacement with unique :gN leaseId)
    nowMs += 20 * 60_000
    const r36 = await runRead('c-36m')
    assert.equal(r36.isError, false)
    assert.deepEqual(hostCalls, ['Read:/tmp/c-0m.md', 'Read:/tmp/c-14m30s.md', 'Read:/tmp/c-16m.md', 'Read:/tmp/c-36m.md'])

    // Verify replaced read-only lease still strictly blocks Write
    const wDenied = await broker.executeHostTool({
      host: fakeHost,
      clientToolName: 'Write',
      arguments: { file_path: '/tmp/out.txt', content: 'nope' },
      callId: 'c-36m-write',
      authorityTurnId: 'ro-turn-long-1',
      turnKey: 'tk-s5',
      nativeSessionUuid: 'nat-s5',
      readOnly: true,
    })
    assert.equal(wDenied.isError, true)
    assert.equal(hostCalls.length, 4)
  } finally {
    broker.dispose('test_done')
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S6: Soft-timed-out ephemeral_turn oc_bash jobs are reaped on turn revocation, caller abort, and idle TTL while managed_job survives', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s6-ephemeral-reap-'))
  let nowMs = 1_700_000_000_000
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, clock: () => nowMs })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sess1 = 'agent:main:webchat:dm:p32-s6-sess1'
    const sess2 = 'agent:main:webchat:dm:p32-s6-sess2'

    // (a) 16 soft-timed-out ephemeral_turn `sleep 30` jobs fill capacity; normal turn token revocation reaps all 16 immediately
    const tok1 = runtime.issueTurnMcpToken({ sessionKey: sess1, turnId: 'turn-s6-16' })
    const tok2 = runtime.issueTurnMcpToken({ sessionKey: sess2 })
    const started16 = await Promise.all(
      Array.from({ length: 16 }, (_, idx) =>
        postJson(
          `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
          { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok1.token },
          {
            toolName: 'oc_bash',
            callId: `s6-sleep-${idx}`,
            arguments: { command: 'sleep 30', timeout_ms: 50, kill_on_timeout: false },
          },
        ),
      ),
    )
    for (const res of started16) {
      assert.equal(res.status, 200)
      assert.equal((res.json.result as { output?: { kind?: string } })?.output?.kind, 'running')
    }
    assert.equal(runtime.bashJobs.activeRunningCount(), 16)

    // While all 16 are alive, a 17th call hits too_many_jobs
    const busyRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok2.token },
      { toolName: 'oc_bash', callId: 's6-17th-blocked', arguments: { command: '/bin/true' } },
    )
    assert.equal((busyRes.json.result as { output?: { kind?: string } })?.output?.kind, 'too_many_jobs')

    // Normal turn completion revokes tok1 -> all 16 ephemeral_turn jobs immediately reaped; sess2 runs cleanly!
    tok1.revoke()
    assert.equal(runtime.bashJobs.activeRunningCount(), 0)
    const afterRevoke = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok2.token },
      { toolName: 'oc_bash', callId: 's6-after-revoke', arguments: { command: '/bin/true' } },
    )
    assert.equal(afterRevoke.status, 200)
    assert.equal((afterRevoke.json.result as { output?: { kind?: string; exitCode?: number } })?.output?.kind, 'finished')
    assert.equal((afterRevoke.json.result as { output?: { exitCode?: number } })?.output?.exitCode, 0)

    // (b) managed_job survives turn token revocation while ephemeral_turn in same turn is reaped
    const tokMix = runtime.issueTurnMcpToken({ sessionKey: sess1, turnId: 'turn-s6-mix' })
    const ephMix = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokMix.token },
      { toolName: 'oc_bash', callId: 's6-mix-eph', arguments: { command: 'sleep 30', timeout_ms: 50, kill_on_timeout: false } },
    )
    const mgdMix = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokMix.token },
      { toolName: 'oc_bash', callId: 's6-mix-mgd', arguments: { command: 'sleep 30', timeout_ms: 50, kill_on_timeout: false, lifecycle_class: 'managed_job' } },
    )
    const managedJobId = (mgdMix.json.result as { output?: { jobId?: string } })?.output?.jobId ?? ''
    assert.equal((ephMix.json.result as { output?: { kind?: string } })?.output?.kind, 'running')
    assert.ok(managedJobId.startsWith('ocb_'))
    assert.equal(runtime.bashJobs.activeRunningCount(), 2)
    tokMix.revoke()
    assert.equal(runtime.bashJobs.activeRunningCount(), 1, 'managed_job must survive turn end while ephemeral_turn is reaped')
    const tokCleanup = runtime.issueTurnMcpToken({ sessionKey: sess1 })
    const killManaged = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokCleanup.token },
      { toolName: 'oc_bash', callId: 's6-mix-kill', arguments: { job_id: managedJobId, action: 'kill' } },
    )
    assert.equal((killManaged.json.result as { output?: { kind?: string } })?.output?.kind, 'killed')
    assert.equal(runtime.bashJobs.activeRunningCount(), 0)

    // (c) Caller AbortSignal after soft-timeout reaps ephemeral_turn job immediately
    const ac = new AbortController()
    const abortSoft = await runtime.bashJobs.execute({
      sessionKey: sess1,
      turnId: 'turn-s6-abort',
      command: 'sleep 30',
      timeoutMs: 50,
      killOnTimeout: false,
      lifecycleClass: 'ephemeral_turn',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      signal: ac.signal,
    })
    assert.equal(abortSoft.kind, 'running')
    assert.equal(runtime.bashJobs.activeRunningCount(), 1)
    ac.abort('caller_aborted_after_soft_timeout')
    assert.equal(runtime.bashJobs.activeRunningCount(), 0)

    // (d) Orphaned unwaited ephemeral_turn job is reaped on EPHEMERAL_IDLE_TTL_MS (10m) even without token revocation
    const tokOrphan = runtime.issueTurnMcpToken({ sessionKey: sess1, turnId: 'turn-s6-orphan' })
    const orphanRes = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokOrphan.token },
      { toolName: 'oc_bash', callId: 's6-orphan', arguments: { command: 'sleep 30', timeout_ms: 50, kill_on_timeout: false } },
    )
    assert.equal((orphanRes.json.result as { output?: { kind?: string } })?.output?.kind, 'running')
    assert.equal(runtime.bashJobs.activeRunningCount(), 1)
    nowMs += 10 * 60_000 + 1
    assert.equal(runtime.bashJobs.activeRunningCount(), 0, 'Unwaited ephemeral_turn job must reap after idle TTL')
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S7: Broker hook-evaluate, efficiencyHookRunner, and ToolBrokerServer enforce ActionPolicy target matching with full parity', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s7-target-'))
  const policyPath = join(workDir, 'action-policy.yaml')
  await writeFile(
    policyPath,
    [
      'version: 1',
      'extendsDefaults: false',
      'defaultTier: allow',
      'rules:',
      '  - id: deny-private-webfetch',
      '    tier: deny',
      '    reason: private URL fetch forbidden',
      '    match:',
      '      tool: [WebFetch]',
      '      target: "https://private.example/*"',
      '',
    ].join('\n'),
    'utf8',
  )
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, actionPolicyPath: policyPath })
  runtime.registerTool({
    canonicalName: 'WebFetch',
    readOnly: true,
    handler: async (args) => ({ fetched: String(args.url ?? '') }),
  })
  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sess = 'agent:main:webchat:dm:p32-s7-target'
    const hookTok = runtime.issueTurnHookToken({ sessionKey: sess, mode: 'normal' })
    const mcpTok = runtime.issueTurnMcpToken({ sessionKey: sess, mode: 'normal' })

    // 1. Legacy offline efficiencyPreToolHook baseline -> deny private, allow public
    const offlineDeny = await handlePreToolHookInput(
      { tool_name: 'WebFetch', tool_input: { url: 'https://private.example/secret' } },
      'ccb',
      'deny',
      { actionPolicyEnabled: true, policyPath },
    )
    assert.equal(
      (offlineDeny.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
      'deny',
    )

    // 2. Live ToolBroker /hook-evaluate -> deny private (and matchedRuleId), allow public
    const brokerDeny = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token },
      { toolName: 'WebFetch', arguments: { url: 'https://private.example/secret' } },
    )
    assert.equal(brokerDeny.status, 200)
    assert.equal(brokerDeny.json.decision, 'deny')
    assert.equal(brokerDeny.json.code, 'ACTION_POLICY_DENIED')
    assert.equal(
      (brokerDeny.json.evaluation as { matchedRuleId?: string } | undefined)?.matchedRuleId,
      'deny-private-webfetch',
    )

    const brokerAllow = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token },
      { toolName: 'WebFetch', arguments: { url: 'https://public.example/ok' } },
    )
    assert.equal(brokerAllow.status, 200)
    assert.equal(brokerAllow.json.decision, 'allow')

    // 3. Wrapped call_mcp_tool -> unwraps effectiveArgs.url and enforces target rule
    const wrappedDeny = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookTok.token },
      {
        toolName: 'call_mcp_tool',
        arguments: {
          ServerName: 'openclaude-memory',
          ToolName: 'WebFetch',
          Arguments: { url: 'https://private.example/wrapped' },
        },
      },
    )
    assert.equal(wrappedDeny.status, 200)
    assert.equal(wrappedDeny.json.decision, 'deny')
    assert.equal(wrappedDeny.json.code, 'ACTION_POLICY_DENIED')

    // 4. handlePreToolHookInput brokerEvaluate + real efficiencyHookRunner.cjs forward target
    let capturedTarget: string | undefined
    const delegatedDeny = await handlePreToolHookInput(
      { tool_name: 'WebFetch', target: 'https://private.example/top-level', tool_input: {} },
      'ccb',
      'deny',
      {
        actionPolicyEnabled: true,
        policyPath,
        brokerEvaluate: async (req) => {
          capturedTarget = req.target
          const out = await runtime.handleHookEvaluate(hookTok.token, req)
          return out.body
        },
      },
    )
    assert.equal(capturedTarget, 'https://private.example/top-level')
    assert.equal(
      (delegatedDeny.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
      'deny',
    )

    const hookTokFile = join(workDir, 's7-hook.tok')
    await writeFile(hookTokFile, `${hookTok.token}\n`, { mode: 0o600 })
    const runnerPath = resolveEfficiencyHookRunner()
    const runRunner = (stdinObj: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolveRunner, rejectRunner) => {
        const child = execFile(
          process.execPath,
          [runnerPath, '--protocol', 'ccb', '--mode', 'deny'],
          {
            env: {
              ...process.env,
              OPENCLAUDE_TOOL_BROKER_URL: srv.baseUrl,
              OPENCLAUDE_TOOL_BROKER_HOOK_TOKEN_FILE: hookTokFile,
            },
          },
          (err, stdout) => {
            if (err) {
              rejectRunner(err)
              return
            }
            resolveRunner(JSON.parse(stdout.trim()) as Record<string, unknown>)
          },
        )
        child.stdin?.end(JSON.stringify(stdinObj))
      })
    const runnerDenyTop = await runRunner({
      tool_name: 'WebFetch',
      target: 'https://private.example/runner-top',
      tool_input: {},
    })
    assert.equal(
      (runnerDenyTop.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
      'deny',
    )
    const runnerDenyUrl = await runRunner({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://private.example/runner-url' },
    })
    assert.equal(
      (runnerDenyUrl.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
      'deny',
    )
    const runnerAllow = await runRunner({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://public.example/runner-ok' },
    })
    assert.equal(
      (runnerAllow.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision,
      'allow',
    )

    // 5. Direct ToolBrokerServer.invoke via /mcp-execute enforces ActionPolicy target too
    const directDeny = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token },
      { toolName: 'WebFetch', callId: 's7-direct-deny', arguments: { url: 'https://private.example/direct' } },
    )
    assert.equal(directDeny.status, 403)
    assert.equal((directDeny.json.result as { errorCode?: string } | undefined)?.errorCode, 'ACTION_POLICY_DENIED')

    const directAllow = await postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: mcpTok.token },
      { toolName: 'WebFetch', callId: 's7-direct-allow', arguments: { url: 'https://public.example/direct' } },
    )
    assert.equal(directAllow.status, 200)
    assert.equal((directAllow.json.result as { status?: string } | undefined)?.status, 'ok')
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S8: Turn token revocation cancels approval-waiting and semaphore-queued calls and re-checks grant before handler without affecting subsequent turns', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s8-turn-revoke-'))
  const secretFile = join(workDir, 's8-secret.txt')
  await writeFile(secretFile, 'S8_REAL_FILE_BODY', 'utf8')
  const policyPath = join(workDir, 'action-policy.yaml')
  await writeFile(
    policyPath,
    [
      'version: 1',
      'extendsDefaults: false',
      'defaultTier: allow',
      'rules:',
      '  - id: approve-oc-read-and-guarded',
      '    tier: human_approval',
      '    reason: require human approval for S8 test',
      '    match:',
      '      tool: [oc_read, s8_approval_tool]',
      '',
    ].join('\n'),
    'utf8',
  )

  let nowMs = 1_700_000_000_000
  const openedCards: Array<{ requestId: string; callId: string; toolName: string }> = []
  const settledCards: Array<{ requestId: string; behavior: string }> = []
  const cardWaiters: Array<() => void> = []
  const waitForCardCount = async (expected: number) => {
    while (openedCards.length < expected) {
      await new Promise<void>((r) => cardWaiters.push(r))
    }
  }
  const approvalBridge: ToolBrokerApprovalBridge = {
    openApprovalCard: (ctx) => {
      openedCards.push({ requestId: ctx.requestId, callId: ctx.callId, toolName: ctx.toolName })
      for (const wake of cardWaiters.splice(0, cardWaiters.length)) wake()
    },
    settleApprovalCard: (info) => {
      settledCards.push({ requestId: info.requestId, behavior: info.behavior })
    },
  }

  const runtime = new GatewayToolBrokerRuntime({
    homeDir: workDir,
    actionPolicyPath: policyPath,
    approvalBridge,
    maxConcurrentToolCalls: 1,
    clock: () => nowMs,
  })
  let releaseBlocker!: () => void
  let blockerEntered!: () => void
  const blockerEnteredP = new Promise<void>((r) => { blockerEntered = r })
  const blockerGateP = new Promise<void>((r) => { releaseBlocker = r })
  const executedQueueTurns: string[] = []
  const executedApprovalTurns: string[] = []
  runtime.registerTool({
    canonicalName: 's8_blocker',
    readOnly: true,
    handler: async () => {
      blockerEntered()
      await blockerGateP
      return { blocked: true }
    },
  })
  runtime.registerTool({
    canonicalName: 's8_queued_tool',
    readOnly: true,
    handler: async (_args, ctx) => {
      executedQueueTurns.push(ctx.turnId)
      return { turnId: ctx.turnId }
    },
  })
  runtime.registerTool({
    canonicalName: 's8_approval_tool',
    readOnly: true,
    handler: async (_args, ctx) => {
      executedApprovalTurns.push(ctx.turnId)
      return { turnId: ctx.turnId }
    },
  })

  const srv = await startPreAuthBrokerServer(runtime)
  try {
    const sess = 'agent:main:webchat:dm:p32-s8-session'

    // (1) Exact Steward repro: oc_read waits in Gate 4 approval; revoke turn 1 token, then approve -> MUST NOT read file;
    //     subsequent turn 2 on SAME session approves and reads file cleanly!
    const tok1 = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-1' })
    const tok2 = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-2' })
    const pRead1 = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok1.token },
      { toolName: 'oc_read', callId: 's8-read-1', arguments: { path: secretFile } },
    )
    const pRead2 = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tok2.token },
      { toolName: 'oc_read', callId: 's8-read-2', arguments: { path: secretFile } },
    )
    await waitForCardCount(2)
    const card1 = openedCards.find((c) => c.callId === 's8-read-1')!
    const card2 = openedCards.find((c) => c.callId === 's8-read-2')!

    tok1.revoke()
    // Attempt late approval of revoked turn 1 card -> must be no-op / rejected
    runtime.handlePermissionResponse({ requestId: card1.requestId, behavior: 'allow' })
    const res1 = await pRead1
    assert.notEqual(res1.status, 200, `Revoked turn 1 must NOT return 200: ${JSON.stringify(res1.json)}`)
    const out1 = res1.json.result as { status?: string; errorCode?: string; output?: unknown }
    assert.notEqual(out1?.status, 'ok')
    assert.equal(String(out1?.output ?? '').includes('S8_REAL_FILE_BODY'), false)
    assert.ok(
      out1?.errorCode === 'TOOL_CALL_CANCELLED' || out1?.errorCode === 'TOOL_BROKER_TURN_TOKEN_REVOKED',
      `Unexpected errorCode: ${out1?.errorCode}`,
    )
    assert.ok(settledCards.some((s) => s.requestId === card1.requestId && s.behavior === 'deny'))

    // Subsequent turn 2 on the SAME session must NOT be disturbed and succeeds on approval!
    const handled2 = runtime.handlePermissionResponse({ requestId: card2.requestId, behavior: 'allow' })
    assert.equal(handled2, true)
    const res2 = await pRead2
    assert.equal(res2.status, 200)
    assert.equal((res2.json.result as { status?: string; output?: string })?.status, 'ok')
    assert.equal((res2.json.result as { output?: string })?.output, 'S8_REAL_FILE_BODY')

    // (2) Revocation during Gate 6 concurrency semaphore queue: revoking queued turn 3 cancels it
    //     immediately (handler NEVER runs) while queued turn 4 on SAME session executes cleanly!
    const tokHold = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-hold' })
    const tokQRevoke = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-q-revoke' })
    const tokQSurvive = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-q-survive' })
    const pHold = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokHold.token },
      { toolName: 's8_blocker', callId: 's8-hold-call', arguments: {} },
    )
    await blockerEnteredP
    const pQRevoke = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokQRevoke.token },
      { toolName: 's8_queued_tool', callId: 's8-q-revoke-call', arguments: {} },
    )
    const pQSurvive = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokQSurvive.token },
      { toolName: 's8_queued_tool', callId: 's8-q-survive-call', arguments: {} },
    )
    await new Promise<void>((r) => setTimeout(r, 40))

    tokQRevoke.revoke()
    const resQRevoke = await pQRevoke
    assert.notEqual(resQRevoke.status, 200)
    assert.equal((resQRevoke.json.result as { errorCode?: string })?.errorCode, 'TOOL_CALL_CANCELLED')

    releaseBlocker()
    const [resHold, resQSurvive] = await Promise.all([pHold, pQSurvive])
    assert.equal(resHold.status, 200)
    assert.equal(resQSurvive.status, 200)
    assert.deepEqual(executedQueueTurns, ['turn-s8-q-survive'])

    // (3) Synchronous pre-handler grant expiry check: turn token expires while session lease is STILL active;
    //     even if approved, authorizeBeforeExecute rejects BEFORE handler executes!
    const tokExp = runtime.issueTurnMcpToken({ sessionKey: sess, turnId: 'turn-s8-exp', ttlMs: 60_000 })
    const cardsBeforeExp = openedCards.length
    const pExp = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/mcp-execute`,
      { [TOOL_BROKER_MCP_TOKEN_HEADER]: tokExp.token },
      { toolName: 's8_approval_tool', callId: 's8-exp-call', arguments: {} },
    )
    await waitForCardCount(cardsBeforeExp + 1)
    const cardExp = openedCards.find((c) => c.callId === 's8-exp-call')!
    nowMs += 61_000
    runtime.handlePermissionResponse({ requestId: cardExp.requestId, behavior: 'allow' })
    const resExp = await pExp
    assert.equal(resExp.status, 401)
    assert.equal((resExp.json.result as { errorCode?: string })?.errorCode, 'TOOL_BROKER_TURN_TOKEN_EXPIRED')
    assert.deepEqual(executedApprovalTurns, [], 'Expired turn handler MUST NOT execute')

    // (4) Hook human_approval wait is cancelled immediately on hookTok.revoke() without affecting Turn B
    const hookA = runtime.issueTurnHookToken({ sessionKey: sess, turnId: 'turn-s8-hook-a' })
    const hookB = runtime.issueTurnHookToken({ sessionKey: sess, turnId: 'turn-s8-hook-b' })
    const cardsBeforeHook = openedCards.length
    const pHookA = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookA.token },
      { toolName: 'oc_read', callId: 's8-hook-a', arguments: { path: secretFile } },
    )
    const pHookB = postJson(
      `${srv.baseUrl}${TOOL_BROKER_LOCAL_PREFIX}/hook-evaluate`,
      { [TOOL_BROKER_HOOK_TOKEN_HEADER]: hookB.token },
      { toolName: 'oc_read', callId: 's8-hook-b', arguments: { path: secretFile } },
    )
    await waitForCardCount(cardsBeforeHook + 2)
    const cardHookB = openedCards.find((c) => c.callId === 's8-hook-b')!
    hookA.revoke()
    const resHookA = await pHookA
    assert.notEqual(resHookA.json.decision, 'allow')
    runtime.handlePermissionResponse({ requestId: cardHookB.requestId, behavior: 'allow' })
    const resHookB = await pHookB
    assert.equal(resHookB.status, 200)
    assert.equal(resHookB.json.decision, 'allow')
  } finally {
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('Steward S9: Rejected policy relaxation never mutates session baseline, blocks old normal tokens on Write, and survives lease expiry rebuild', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-s9-monotonic-'))
  let nowMs = 1_700_000_000_000
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir, clock: () => nowMs })
  try {
    const sess = 'agent:main:webchat:dm:p32-s9-monotonic'
    const normalPolicy = {
      schemaVersion: 1 as const,
      mode: 'normal' as const,
      allowedTools: [],
      allowNetworkEgress: true,
      allowWorkspaceWrite: true,
      allowSubprocessSpawn: true,
    }
    const readOnlyPolicy = {
      schemaVersion: 1 as const,
      mode: 'read_only' as const,
      allowedTools: [],
      allowNetworkEgress: false,
      allowWorkspaceWrite: false,
      allowSubprocessSpawn: false,
    }

    // 1. Mint a normal hook token BEFORE tightening
    const oldNormalHook = runtime.issueTurnHookToken({ sessionKey: sess, mode: 'normal' })
    const beforeTighten = await runtime.handleHookEvaluate(oldNormalHook.token, {
      toolName: 'Write',
      arguments: { path: 'ok.txt', content: 'before' },
    })
    assert.equal(beforeTighten.body.decision, 'allow')

    // 2. Tighten session to read_only -> old normal token is immediately denied on Write
    runtime.setSessionPolicy(sess, readOnlyPolicy)
    const afterTighten = await runtime.handleHookEvaluate(oldNormalHook.token, {
      toolName: 'Write',
      arguments: { path: 'no.txt', content: 'after' },
    })
    assert.equal(afterTighten.body.decision, 'deny')
    assert.equal(afterTighten.body.code, 'EXEC_POLICY_READ_ONLY_DENIED')

    // 3. Rejected relaxation via setSessionPolicy MUST throw AND keep baseline + broker strictly read_only
    assert.throws(() => runtime.setSessionPolicy(sess, normalPolicy), { code: 'EXEC_POLICY_RELAXATION_FORBIDDEN' })
    const lease1 = runtime.getSessionLease(sess)!
    assert.equal(runtime.server.getPolicy(lease1.leaseId)?.mode, 'read_only')
    const afterRelax1 = await runtime.handleHookEvaluate(oldNormalHook.token, {
      toolName: 'Write',
      arguments: { path: 'no1.txt', content: 'nope' },
    })
    assert.equal(afterRelax1.body.decision, 'deny')
    assert.equal(afterRelax1.body.code, 'EXEC_POLICY_READ_ONLY_DENIED')

    // 4. Rejected relaxation via ensureSessionLease({ policy }) on active lease MUST throw AND preserve read_only
    assert.throws(() => runtime.ensureSessionLease(sess, { policy: normalPolicy }), { code: 'EXEC_POLICY_RELAXATION_FORBIDDEN' })
    assert.equal(runtime.server.getPolicy(lease1.leaseId)?.mode, 'read_only')
    const afterRelax2 = await runtime.handleHookEvaluate(oldNormalHook.token, {
      toolName: 'Write',
      arguments: { path: 'no2.txt', content: 'nope' },
    })
    assert.equal(afterRelax2.body.decision, 'deny')
    assert.equal(afterRelax2.body.code, 'EXEC_POLICY_READ_ONLY_DENIED')

    // 5. Expire lease: rejected relaxation during rebuild throws, AND genuine lease rebuild preserves read_only!
    nowMs += 20 * 60_000
    assert.throws(() => runtime.ensureSessionLease(sess, { policy: normalPolicy }), { code: 'EXEC_POLICY_RELAXATION_FORBIDDEN' })
    const rebuiltLease = runtime.ensureSessionLease(sess)
    assert.notEqual(rebuiltLease.leaseId, lease1.leaseId)
    assert.equal(runtime.server.getPolicy(rebuiltLease.leaseId)?.mode, 'read_only')

    const freshHook = runtime.issueTurnHookToken({ sessionKey: sess, mode: 'normal' })
    assert.equal(freshHook.claims.mode, 'read_only')
    const afterRebuild = await runtime.handleHookEvaluate(freshHook.token, {
      toolName: 'Write',
      arguments: { path: 'no3.txt', content: 'nope' },
    })
    assert.equal(afterRebuild.body.decision, 'deny')
    assert.equal(afterRebuild.body.code, 'EXEC_POLICY_READ_ONLY_DENIED')

    // 6. Session with explicit allowlist narrows cleanly on tightenSessionMode('read_only') without relaxing allowlist
    const sessAllow = 'agent:main:webchat:dm:p32-s9-allowlist'
    runtime.ensureSessionLease(sessAllow, {
      policy: { ...normalPolicy, allowedTools: ['Read', 'Grep', 'Write'] },
    })
    const narrowed = runtime.tightenSessionMode(sessAllow, 'read_only')
    assert.equal(narrowed.mode, 'read_only')
    assert.deepEqual(narrowed.allowedTools, ['Read', 'Grep'])
    assert.throws(() => runtime.setSessionPolicy(sessAllow, normalPolicy), { code: 'EXEC_POLICY_RELAXATION_FORBIDDEN' })
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('R2 P1-4: handleStop(M1) revokes ONLY M1 turn tokens/jobs/waiters synchronously and preserves successor M2 token issued while remote swarm stop is still awaiting', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-p14-stop-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const { handleStop } = await import('../../wsConnection.js')
  try {
    const sessionKey = 'agent:main:webchat:dm:p32-p14-race'
    const scope1 = { sessionKey, turnEpoch: 1, turnId: 'tb_turn_1_m1' }
    const t1Hook = runtime.issueTurnHookToken(scope1)
    const t1Mcp = runtime.issueTurnMcpToken(scope1)

    // Start an ephemeral_turn bash job bound to M1's turnId
    const abortCtrl = new AbortController()
    const bashStart = await runtime.bashJobs.execute({
      sessionKey,
      turnId: scope1.turnId,
      leaseId: t1Mcp.lease.leaseId,
      command: 'sleep 30',
      timeoutMs: 25,
      killOnTimeout: false,
      lifecycleClass: 'ephemeral_turn',
      env: { PATH: '/usr/bin:/bin' },
      signal: abortCtrl.signal,
    })
    assert.equal(bashStart.kind, 'running')
    assert.ok(bashStart.jobId)

    let releaseRemoteSwarmStop!: () => void
    const remoteSwarmPending = new Promise<boolean>((resolve) => {
      releaseRemoteSwarmStop = () => resolve(true)
    })

    let activeCmid = 'm-p14-turn-1'
    const host = {
      log: { info: () => {}, warn: () => {}, error: () => {} },
      sessions: {
        list: () => [{ sessionKey, _runningClientMessageId: activeCmid }],
        interruptClientTurn: (sk: string, cmid: string) => sk === sessionKey && cmid === activeCmid,
        interrupt: () => false,
        fencePreStartStop: () => {},
      },
      router: { route: () => ({ sessionKey }) },
      _interruptDelegationsForParent: () => false,
      _interruptRemoteSwarmForSession: () => remoteSwarmPending,
      _settlePendingPermissionsForStop: () => {},
      _cancelToolBrokerSession: (sk: string, reason = 'user_stop') => {
        if (reason === 'user_stop') {
          runtime.cancelActiveTurnCalls(sk, reason)
          return
        }
        runtime.cancelSessionCalls(sk, reason)
      },
    }

    const stopPromise = handleStop.call(host as never, {
      type: 'inbound.control.stop',
      channel: 'webchat',
      peer: { id: 'p32-p14-race', kind: 'dm' },
      clientMessageId: 'm-p14-turn-1',
    })

    // M1's tokens and ephemeral job are ALREADY revoked synchronously before remoteSwarmPending resolves!
    assert.throws(
      () => runtime.verifyTurnScopedToken(t1Hook.token, 'hook'),
      { code: 'TOOL_BROKER_TURN_TOKEN_REVOKED' },
    )
    assert.throws(
      () => runtime.verifyTurnScopedToken(t1Mcp.token, 'mcp'),
      { code: 'TOOL_BROKER_TURN_TOKEN_REVOKED' },
    )
    const m1JobAfterStop = await runtime.bashJobs.execute({
      sessionKey,
      jobId: bashStart.jobId,
      action: 'status',
      timeoutMs: 1_000,
      killOnTimeout: false,
      lifecycleClass: 'ephemeral_turn',
      env: {},
      signal: abortCtrl.signal,
    })
    assert.equal(m1JobAfterStop.kind, 'not_found', 'M1 ephemeral_turn job must be reaped')

    // While remote swarm stop is still awaiting, successor turn M2 starts on the same session and gets T2!
    activeCmid = 'm-p14-turn-2'
    const scope2 = { sessionKey, turnEpoch: 2, turnId: 'tb_turn_2_m2' }
    const t2Hook = runtime.issueTurnHookToken(scope2)
    const t2Mcp = runtime.issueTurnMcpToken(scope2)

    // Now remote swarm stop completes late:
    releaseRemoteSwarmStop()
    const stopOk = await stopPromise
    assert.equal(stopOk, true)

    // M2's tokens MUST remain valid and usable!
    const verifiedHook2 = runtime.verifyTurnScopedToken(t2Hook.token, 'hook')
    const verifiedMcp2 = runtime.verifyTurnScopedToken(t2Mcp.token, 'mcp')
    assert.equal(verifiedHook2.turnId, 'tb_turn_2_m2')
    assert.equal(verifiedMcp2.turnId, 'tb_turn_2_m2')
    const hookEval = await runtime.handleHookEvaluate(t2Hook.token, {
      toolName: 'Read',
      arguments: { file_path: 'README.md' },
    })
    assert.equal(hookEval.body.decision, 'allow')
  } finally {
    runtime.dispose()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('OCV5-930: Antigravity broker PreToolUse honors default warn mode and never blocks native swarm rg/grep or pipe filters even in deny mode', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-930-'))
  const origGuard = process.env.OPENCLAUDE_EFFICIENCY_GUARD
  Reflect.deleteProperty(process.env, 'OPENCLAUDE_EFFICIENCY_GUARD')
  const warnRuntime = createGatewayToolBrokerRuntime({ homeDir: workDir })
  const denyRuntime = createGatewayToolBrokerRuntime({
    homeDir: join(workDir, 'deny'),
    shellHookGuardMode: 'deny',
  })
  const warnSrv = await startPreAuthBrokerServer(warnRuntime)
  const denySrv = await startPreAuthBrokerServer(denyRuntime)
  try {
    const sess = 'agent:main:webchat:dm:p32-ocv5-930'
    const launchWarn = join(workDir, 'launch-warn')
    const cfgWarn = join(launchWarn, '.gemini', 'config')
    await mkdir(cfgWarn, { recursive: true })
    const warnTok = warnRuntime.issueTurnHookToken({ sessionKey: sess, mode: 'normal' })
    const warnHook = installAntigravityBrokerHook({
      launchHome: launchWarn,
      configDir: cfgWarn,
      mode: 'normal',
      brokerUrl: warnSrv.baseUrl,
      hookToken: warnTok.token,
    })

    const runPy = async (pythonBin: string, scriptPath: string, payload: Record<string, unknown>) => {
      const res = await runCmd(pythonBin, ['-I', '-B', scriptPath], { input: JSON.stringify(payload) })
      assert.equal(res.code, 0, `hook stderr=${res.stderr}`)
      return JSON.parse(res.stdout.trim()) as { decision: string; reason?: string }
    }

    // 1. Default runtime (OPENCLAUDE_EFFICIENCY_GUARD unset -> warn): never denies efficiency hints, still denies destructive ActionPolicy
    const swarmGrepCmd =
      'grep -rn "pgSessionsBackend" /home/agent/.openclaude/workspace/wt-b1-cs1/packages/commercial/src/__tests__/ | head -n 60 && rg "HYDRATE" packages/gateway/src/ || true'
    assert.equal(
      (await runPy(warnHook.pythonBin, warnHook.guardScriptPath, {
        tool_name: 'run_command',
        tool_input: { CommandLine: swarmGrepCmd },
      })).decision,
      'allow',
    )
    assert.equal(
      (await runPy(warnHook.pythonBin, warnHook.guardScriptPath, {
        tool_name: 'run_command',
        tool_input: { CommandLine: 'cat packages/gateway/src/server.ts' },
      })).decision,
      'allow',
    )
    const destructiveRes = await runPy(warnHook.pythonBin, warnHook.guardScriptPath, {
      tool_name: 'run_command',
      tool_input: { CommandLine: 'rm -rf /' },
    })
    assert.equal(destructiveRes.decision, 'deny')

    // 2. Explicit deny mode: Antigravity run_command rg/grep & pipe filters stay allowed; cat points at read_file; sleep >= 60 stays denied
    const launchDeny = join(workDir, 'launch-deny')
    const cfgDeny = join(launchDeny, '.gemini', 'config')
    await mkdir(cfgDeny, { recursive: true })
    const denyTok = denyRuntime.issueTurnHookToken({ sessionKey: sess, mode: 'normal' })
    const denyHook = installAntigravityBrokerHook({
      launchHome: launchDeny,
      configDir: cfgDeny,
      mode: 'normal',
      brokerUrl: denySrv.baseUrl,
      hookToken: denyTok.token,
    })
    assert.equal(
      (await runPy(denyHook.pythonBin, denyHook.guardScriptPath, {
        tool_name: 'run_command',
        tool_input: { CommandLine: swarmGrepCmd },
      })).decision,
      'allow',
    )
    assert.equal(
      (await runPy(denyHook.pythonBin, denyHook.guardScriptPath, {
        tool_name: 'run_command',
        tool_input: { CommandLine: 'git diff --name-only | grep packages/gateway/src/server.ts' },
      })).decision,
      'allow',
    )
    const denyCat = await runPy(denyHook.pythonBin, denyHook.guardScriptPath, {
      tool_name: 'run_command',
      tool_input: { CommandLine: 'cat packages/gateway/src/server.ts' },
    })
    assert.equal(denyCat.decision, 'deny')
    assert.match(String(denyCat.reason ?? ''), /read_file/)
    assert.equal(String(denyCat.reason ?? '').includes('Read/Grep/Glob'), false)

    const denySleep = await runPy(denyHook.pythonBin, denyHook.guardScriptPath, {
      tool_name: 'run_command',
      tool_input: { CommandLine: 'sleep 120' },
    })
    assert.equal(denySleep.decision, 'deny')
  } finally {
    if (origGuard === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_EFFICIENCY_GUARD')
    else process.env.OPENCLAUDE_EFFICIENCY_GUARD = origGuard
    warnRuntime.dispose()
    denyRuntime.dispose()
    await warnSrv.close()
    await denySrv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})
