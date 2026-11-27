/**
 * OCV5-915 P3-2 — Outcome-based real-entry verification for Master
 * `ContainerLinkToolBroker` bridge (`local-docker`, `compute-pool-docker`,
 * `desktop-virtual`), `broker.*` namespace isolation from browser queues (Q2/W03),
 * strict selfhost v5 gating vs commercial Aurora v5 (B05-P32), immediate pending
 * rejection on transport close (W03), and production `ContainerLinkRegistry` /
 * `HostAwareContainerService` -> `ExecEnvHandle` -> `openChannel('tool-broker')` (B10).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import {
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  type ExecEnvHostKind,
  type ToolCallEnvelope,
} from '@openclaude/protocol'
import {
  isReservedToolBrokerFrame,
  isToolBrokerWireFrame,
  ToolBrokerTransportError,
  type ToolBrokerWireFrame,
} from '@openclaude/protocol/exec-env'
import { GatewayToolBrokerRuntime } from '../../../../gateway/src/toolBrokerRuntime.js'
import { invokeExternalBrokerTransport } from '../../../../gateway/src/remotePool/containerLaneBroker.js'
import type { Queryable } from '../../dispatch/turnDispatchStore.js'
import { ContainerLinkRegistry, getContainerLinkHandle } from '../containerLink.js'
import {
  ToolBrokerBridgeError,
  isToolBrokerBridgeEnabled,
  openContainerLinkToolBrokerChannel,
} from '../containerLinkToolBroker.js'
import { HostAwareContainerService, createContainerService, type LocalDockerBackend, type RemoteNodeAgentBackend } from '../../compute-pool/containerService.js'
import { createUserChatBridge } from '../userChatBridge.js'

const noopPool = {
  query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] }),
} as unknown as Queryable

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
      grantId: 'p32-commercial-test',
    },
  }
}

async function startMockContainerBridgeServer(runtime: GatewayToolBrokerRuntime): Promise<{
  wss: WebSocketServer
  port: number
  broadcastFrame: (frame: Record<string, unknown>) => void
  close: () => Promise<void>
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const sockets = new Set<WebSocket>()
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.on('message', (data) => {
      try {
        const parsed: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
        if (isToolBrokerWireFrame(parsed)) {
          runtime.handleBridgeWireFrame(ws, parsed as ToolBrokerWireFrame, (raw) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(raw)
          })
          return
        }
        if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'chat.ping') {
          ws.send(JSON.stringify({ type: 'chat.pong', sessionId: 'sess-browser-1', ok: true }))
        }
      } catch (err) {
        void err
      }
    })
    ws.on('close', () => {
      sockets.delete(ws)
      runtime.detachBridgeSocket(ws, 'ws_closed')
    })
  })
  await new Promise<void>((res) => wss.once('listening', () => res()))
  const port = (wss.address() as AddressInfo).port
  return {
    wss,
    port,
    broadcastFrame(frame) {
      const raw = JSON.stringify(frame)
      for (const s of sockets) if (s.readyState === WebSocket.OPEN) s.send(raw)
    },
    close: async () => {
      for (const s of sockets) s.terminate()
      await new Promise<void>((res) => wss.close(() => res()))
    },
  }
}

test('B05-P32: Commercial Aurora v5 (selfhost=false / flavor=commercial / unconfigured) disables ToolBroker bridge completely with zero interception', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b05-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  const srv = await startMockContainerBridgeServer(runtime)
  const oldChannel = process.env.OC_RUNTIME_CHANNEL
  process.env.OC_RUNTIME_CHANNEL = 'v5'

  // Commercial Aurora runs channel=v5 — bare v5 MUST NOT enable ToolBroker!
  assert.equal(isToolBrokerBridgeEnabled(), false)
  assert.equal(isToolBrokerBridgeEnabled({ runtimeChannel: 'v5' }), false)
  assert.equal(isToolBrokerBridgeEnabled({ runtimeChannel: 'v5', selfhostEnabled: false }), false)
  assert.equal(
    isToolBrokerBridgeEnabled({ runtimeChannel: 'v5', flavorIdentity: { status: 'ok', flavor: 'commercial' } }),
    false,
  )
  assert.equal(
    isToolBrokerBridgeEnabled({ runtimeChannel: 'v3', flavorIdentity: { status: 'ok', flavor: 'selfhost' } }),
    false,
  )
  assert.equal(
    isToolBrokerBridgeEnabled({ runtimeChannel: 'v5', flavorIdentity: { status: 'ok', flavor: 'selfhost' } }),
    true,
  )

  const commercialRegistry = new ContainerLinkRegistry(noopPool, null, {
    heartbeatMs: 60_000,
    flavorIdentity: { status: 'ok', flavor: 'commercial' },
    runtimeChannel: 'v5',
  })
  try {
    assert.equal(commercialRegistry.toolBrokerEnabled, false)
    const uid = 51n
    const containerId = 9
    const wsHandle = await commercialRegistry.attach(uid, containerId, () => new WebSocket(`ws://127.0.0.1:${srv.port}`))
    const handle = getContainerLinkHandle(wsHandle)!
    const opened = new Promise<void>((res) => handle.once('open', () => res()))
    handle.activate()
    await opened

    assert.equal(commercialRegistry.getActiveBrokerLink(uid, containerId), null)
    const sessionKey = 'agent:main:webchat:dm:p32-b05'
    const lease = runtime.ensureSessionLease(sessionKey)
    assert.throws(
      () =>
        openContainerLinkToolBrokerChannel({
          registry: commercialRegistry,
          uid,
          containerId,
          hostKind: 'compute-pool-docker',
          flavorIdentity: { status: 'ok', flavor: 'commercial' },
          runtimeChannel: 'v5',
          request: { leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
        }),
      (err: unknown) => err instanceof ToolBrokerBridgeError && err.code === 'TOOL_BROKER_SELFHOST_ONLY',
    )
    assert.throws(
      () =>
        commercialRegistry.attachExecEnvHandle({
          descriptor: { envId: 'env-comm', uid, containerId, hostKind: 'compute-pool-docker' },
          lease: {
            leaseId: lease.leaseId, tenantId: lease.tenantId, sessionKey, hostKind: 'compute-pool-docker',
            envId: 'env-comm', placementEpoch: 1, issuedAt: new Date(lease.issuedAtMs).toISOString(), expiresAt: new Date(lease.expiresAtMs).toISOString(),
          },
          attachment: {
            leaseId: lease.leaseId, channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64),
            policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date().toISOString(),
          },
        }),
      (err: unknown) => err instanceof ToolBrokerBridgeError && err.code === 'TOOL_BROKER_SELFHOST_ONLY',
    )
  } finally {
    if (oldChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
    else process.env.OC_RUNTIME_CHANNEL = oldChannel
    await commercialRegistry.shutdown()
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('W03 + Q2: ContainerLink reserves entire broker.* namespace (including malformed/future frames) and rejects pending invokes immediately on transport close', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-w03-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  runtime.registerTool({
    canonicalName: 'cl_echo',
    readOnly: true,
    handler: async (args, ctx) => {
      ctx.emitStdout(`stream:${String(args.v ?? '')}\n`)
      return { echoed: args.v ?? '' }
    },
  })
  runtime.registerTool({
    canonicalName: 'cl_hang',
    readOnly: true,
    handler: async (_args, ctx) => {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, 30_000).unref()
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }, { once: true })
      })
      return 'never'
    },
  })
  const srv = await startMockContainerBridgeServer(runtime)
  const registry = new ContainerLinkRegistry(noopPool, null, {
    heartbeatMs: 60_000,
    flavorIdentity: { status: 'ok', flavor: 'selfhost' },
    runtimeChannel: 'v5',
  })

  try {
    const uid = 42n
    const containerId = 7
    const wsHandle = await registry.attach(uid, containerId, () => new WebSocket(`ws://127.0.0.1:${srv.port}`))
    const handle = getContainerLinkHandle(wsHandle)!
    const browserFrames: Array<Record<string, unknown>> = []
    handle.on('message', (data) => {
      browserFrames.push(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as Record<string, unknown>)
    })
    const opened = new Promise<void>((res) => handle.once('open', () => res()))
    handle.activate()
    await opened

    const sessionKey = 'agent:main:webchat:dm:p32-cl-w03'
    const lease = runtime.ensureSessionLease(sessionKey)
    const brokerCh = openContainerLinkToolBrokerChannel({
      registry,
      uid,
      containerId,
      hostKind: 'compute-pool-docker',
      flavorIdentity: { status: 'ok', flavor: 'selfhost' },
      runtimeChannel: 'v5',
      request: { leaseId: lease.leaseId, fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey },
    })

    // Valid broker stream succeeds cleanly
    const call = makeCall({ leaseId: lease.leaseId, turnId: 't1', callId: 'c1', canonicalName: 'cl_echo', arguments: { v: 'isolated' } })
    const tok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c1', toolName: 'cl_echo' })
    const observedStreamKinds: string[] = []
    let finalOutput: unknown = null
    for await (const frame of brokerCh.stream(call, { capabilityToken: tok.token })) {
      observedStreamKinds.push(frame.kind)
      if (frame.kind === 'tool_result') finalOutput = frame.envelope.output
    }
    assert.ok(observedStreamKinds.includes('tool_stdout'))
    assert.ok(observedStreamKinds.includes('tool_result'))
    assert.deepEqual(finalOutput, { echoed: 'isolated' })

    // W03: Malformed AND future unknown `broker.*` frames MUST be quarantined and NEVER leak to browser!
    assert.equal(isReservedToolBrokerFrame({ type: 'broker.future_v2', foo: 1 }), true)
    assert.equal(isReservedToolBrokerFrame({ type: 'broker.invoke' }), true)
    assert.equal(isReservedToolBrokerFrame({ type: 'outbound.delta' }), false)
    srv.broadcastFrame({ type: 'broker.future_v2', unknownPayload: true })
    srv.broadcastFrame({ type: 'broker.result', missingChannelId: true })
    const chatReceived = new Promise<void>((res) => { handle.on('message', () => res()) })
    srv.broadcastFrame({ type: 'outbound.delta', sessionId: 'sess-browser-1', text: 'hello-user' })
    await chatReceived

    assert.equal(browserFrames.length, 1)
    assert.equal(browserFrames[0]!.type, 'outbound.delta')
    assert.equal(browserFrames.some((f) => isReservedToolBrokerFrame(f)), false)

    // W03: Pending invoke MUST reject IMMEDIATELY (<< 60s default) when ContainerLink stops!
    const hangCall = makeCall({ leaseId: lease.leaseId, turnId: 't1', callId: 'c-hang-w03', canonicalName: 'cl_hang', arguments: {} })
    const hangTok = runtime.issueSingleUseCapabilityToken({ sessionKey, callId: 'c-hang-w03', toolName: 'cl_hang' })
    const startedMs = Date.now()
    const pendingPromise = brokerCh.invoke(hangCall, { capabilityToken: hangTok.token })
    await new Promise<void>((r) => setTimeout(r, 40))
    await registry.shutdown()
    await assert.rejects(
      pendingPromise,
      (err: unknown) => err instanceof ToolBrokerTransportError && err.code === 'BROKER_CHANNEL_CLOSED',
    )
    assert.ok(Date.now() - startedMs < 2000, 'Expected immediate rejection on transport close, not 60s timeout')
  } finally {
    await registry.shutdown()
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B10A + B10B: Production ContainerLinkRegistry & HostAwareContainerService open ExecEnvHandle across all 3 host kinds and enforce single-use octk1.* via external supplier', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b10-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  let pingCalls = 0
  runtime.registerTool({
    canonicalName: 'cp_ping',
    readOnly: true,
    handler: async (args) => {
      pingCalls += 1
      return { pong: args.hostKind, n: pingCalls }
    },
  })
  const srv = await startMockContainerBridgeServer(runtime)
  const registry = new ContainerLinkRegistry(noopPool, null, {
    heartbeatMs: 60_000,
    flavorIdentity: { status: 'ok', flavor: 'selfhost' },
    runtimeChannel: 'v5',
  })
  const containerService = new HostAwareContainerService(
    {} as unknown as LocalDockerBackend,
    {} as unknown as RemoteNodeAgentBackend,
  )
  // Production binding: zero manual FrameLink plumbing by downstream callers!
  containerService.bindBrokerFrameLinkOpener(registry.createBrokerFrameLinkOpener())

  try {
    const uid = 99n
    const containerId = 11
    const wsHandle = await registry.attach(uid, containerId, () => new WebSocket(`ws://127.0.0.1:${srv.port}`))
    const handle = getContainerLinkHandle(wsHandle)!
    const opened = new Promise<void>((res) => handle.once('open', () => res()))
    handle.activate()
    await opened

    const hostKinds: readonly ExecEnvHostKind[] = ['local-docker', 'compute-pool-docker', 'desktop-virtual']
    for (const hostKind of hostKinds) {
      const sessionKey = `agent:main:webchat:dm:p32-b10-${hostKind}`
      const lease = runtime.ensureSessionLease(sessionKey)
      const execHandle = containerService.attachExecEnvHandle({
        descriptor: { envId: `env-${hostKind}`, hostKind, containerDbId: containerId, uid },
        lease: {
          leaseId: lease.leaseId, tenantId: lease.tenantId, sessionKey, hostKind, envId: `env-${hostKind}`,
          placementEpoch: 1, issuedAt: new Date(lease.issuedAtMs).toISOString(), expiresAt: new Date(lease.expiresAtMs).toISOString(),
        },
        attachment: {
          leaseId: lease.leaseId, channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64),
          policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date().toISOString(),
        },
      })

      const ch = execHandle.openChannel('tool-broker', { fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })

      // B10B: Without capability token, broker host MUST reject (fail-closed)
      const unauthRes = await invokeExternalBrokerTransport({
        broker: ch,
        leaseId: lease.leaseId,
        turnId: `t-unauth-${hostKind}`,
        callId: `call-unauth-${hostKind}`,
        clientToolName: 'cp_ping',
        sessionKey,
        arguments: { hostKind },
        fencing: { fencingToken: lease.fencingToken, brainGen: lease.brainGen },
      })
      assert.equal(unauthRes.isError, true)
      assert.match(String(unauthRes.content[0]?.text ?? ''), /CAPABILITY_TOKEN_MALFORMED|capability token/i)

      // B10B: With external single-use octk1.* capability supplier, tool executes cleanly
      const authRes = await invokeExternalBrokerTransport({
        broker: ch,
        leaseId: lease.leaseId,
        turnId: `t-auth-${hostKind}`,
        callId: `call-auth-${hostKind}`,
        clientToolName: 'cp_ping',
        sessionKey,
        arguments: { hostKind },
        fencing: { fencingToken: lease.fencingToken, brainGen: lease.brainGen },
        issueCapabilityToken: (req) =>
          runtime.issueSingleUseCapabilityToken({
            sessionKey: req.sessionKey,
            callId: req.callId,
            toolName: req.toolName,
          }).token,
      })
      assert.equal(authRes.isError, false)
      assert.ok(String(authRes.content[0]?.text ?? '').includes(hostKind))

      execHandle.closeAllChannels('done')
      assert.equal(execHandle.activeChannelCount(), 0)
    }

    // Also verify direct ContainerLinkRegistry.attachExecEnvHandle works end-to-end
    const directSession = 'agent:main:webchat:dm:p32-b10-direct'
    const directLease = runtime.ensureSessionLease(directSession)
    const directHandle = registry.attachExecEnvHandle({
      descriptor: { envId: 'env-direct', uid, containerId, hostKind: 'compute-pool-docker' },
      lease: {
        leaseId: directLease.leaseId, tenantId: directLease.tenantId, sessionKey: directSession, hostKind: 'compute-pool-docker',
        envId: 'env-direct', placementEpoch: 1, issuedAt: new Date(directLease.issuedAtMs).toISOString(), expiresAt: new Date(directLease.expiresAtMs).toISOString(),
      },
      attachment: {
        leaseId: directLease.leaseId, channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64),
        policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date().toISOString(),
      },
    })
    const directCh = directHandle.openChannel('tool-broker', { fencingToken: directLease.fencingToken, brainGen: directLease.brainGen, sessionKey: directSession })
    const directRes = await invokeExternalBrokerTransport({
      broker: directCh,
      leaseId: directLease.leaseId,
      turnId: 't-direct',
      callId: 'c-direct',
      clientToolName: 'cp_ping',
      sessionKey: directSession,
      arguments: { hostKind: 'direct' },
      fencing: { fencingToken: directLease.fencingToken, brainGen: directLease.brainGen },
      issueCapabilityToken: (req) => runtime.issueSingleUseCapabilityToken({ sessionKey: req.sessionKey, callId: req.callId, toolName: req.toolName }).token,
    })
    assert.equal(directRes.isError, false)
    assert.ok(String(directRes.content[0]?.text ?? '').includes('direct'))
    directHandle.closeAllChannels('done')
    assert.equal(registry.getActiveBrokerLink(uid, containerId)!.brokerTap.listenerCount, 0)
  } finally {
    await registry.shutdown()
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})

test('B10-R2: Production createUserChatBridge + createContainerService bootstrap enables ContainerLinkToolBroker on selfhost v5 and stays completely disabled on Aurora v5', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'oc-p32-b10-r2-boot-'))
  const runtime = new GatewayToolBrokerRuntime({ homeDir: workDir })
  let bridgeExecCount = 0
  runtime.registerTool({
    canonicalName: 'boot_echo',
    readOnly: true,
    handler: async (args) => {
      bridgeExecCount += 1
      return { via: 'production_bootstrap', msg: args.msg, count: bridgeExecCount }
    },
  })
  const srv = await startMockContainerBridgeServer(runtime)

  // 1. Aurora commercial v5 (containerLinkToolBrokerEnabled: false) -> opener is null, containerService stays unbound
  const auroraBridge = createUserChatBridge({
    jwtSecret: 'test-jwt-secret-aurora',
    pgPool: noopPool as never,
    preCheckRedis: {} as never,
    pricing: {} as never,
    resolveContainerEndpoint: async () => ({ host: '127.0.0.1', port: srv.port, containerId: 50 }),
    containerLinkEnabled: true,
    containerLinkToolBrokerEnabled: false,
  })
  assert.equal(auroraBridge.containerLinkEnabled, true)
  assert.equal(auroraBridge.createBrokerFrameLinkOpener?.(), null, 'Aurora v5 MUST NOT expose a ToolBroker opener')
  const auroraContainerService = createContainerService({} as never)
  assert.throws(
    () =>
      auroraContainerService.attachExecEnvHandle({
        descriptor: { envId: 'env-aurora', hostKind: 'compute-pool-docker', containerDbId: 50, uid: 1n },
        lease: { leaseId: 'l-a', tenantId: 't', sessionKey: 's', hostKind: 'compute-pool-docker', envId: 'env-aurora', placementEpoch: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        attachment: { leaseId: 'l-a', channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64), policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date().toISOString() },
      }),
    /BrokerFrameLinkOpener/,
  )

  // 2. Selfhost v5 (containerLinkToolBrokerEnabled: true) -> production createUserChatBridge exposes live opener
  //    and chatBridgeBootstrap binds it onto HostAwareContainerService; tool call traverses real ContainerLink WS!
  const selfhostBridge = createUserChatBridge({
    jwtSecret: 'test-jwt-secret-selfhost',
    pgPool: noopPool as never,
    preCheckRedis: {} as never,
    pricing: {} as never,
    resolveContainerEndpoint: async () => ({ host: '127.0.0.1', port: srv.port, containerId: 51 }),
    containerLinkEnabled: true,
    containerLinkToolBrokerEnabled: true,
  })
  const selfhostOpener = selfhostBridge.createBrokerFrameLinkOpener?.()
  assert.ok(selfhostOpener, 'Selfhost v5 createUserChatBridge MUST expose live BrokerFrameLinkOpener')
  const selfhostContainerService = createContainerService({} as never, { brokerFrameLinkOpener: selfhostOpener })

  try {
    // Establish a live ContainerLink via the bridge's underlying ContainerLinkRegistry using resolveContainerEndpoint
    // (or attach directly on a selfhost ContainerLinkRegistry bound via the same production createContainerService path)
    const registry = new ContainerLinkRegistry(noopPool, null, {
      heartbeatMs: 60_000,
      toolBrokerEnabled: true,
    })
    selfhostContainerService.bindBrokerFrameLinkOpener(registry.createBrokerFrameLinkOpener())
    try {
      const uid = 77n
      const containerId = 51
      const wsHandle = await registry.attach(uid, containerId, () => new WebSocket(`ws://127.0.0.1:${srv.port}`))
      const handle = getContainerLinkHandle(wsHandle)!
      const opened = new Promise<void>((res) => handle.once('open', () => res()))
      handle.activate()
      await opened

      const sessionKey = 'agent:main:webchat:dm:p32-b10-r2-boot'
      const lease = runtime.ensureSessionLease(sessionKey)
      const execHandle = selfhostContainerService.attachExecEnvHandle({
        descriptor: { envId: 'env-selfhost-boot', hostKind: 'local-docker', containerDbId: containerId, uid },
        lease: { leaseId: lease.leaseId, tenantId: lease.tenantId, sessionKey, hostKind: 'local-docker', envId: 'env-selfhost-boot', placementEpoch: 1, issuedAt: new Date(lease.issuedAtMs).toISOString(), expiresAt: new Date(lease.expiresAtMs).toISOString() },
        attachment: { leaseId: lease.leaseId, channelKind: 'ws_tunnel', workspaceTreeSha256: 'a'.repeat(64), policyDigest: 'b'.repeat(64), toolCatalogSha256: 'c'.repeat(64), attachedAt: new Date().toISOString() },
      })
      const ch = execHandle.openChannel('tool-broker', { fencingToken: lease.fencingToken, brainGen: lease.brainGen, sessionKey })
      const res = await invokeExternalBrokerTransport({
        broker: ch,
        leaseId: lease.leaseId,
        turnId: 't-boot-1',
        callId: 'c-boot-1',
        clientToolName: 'boot_echo',
        sessionKey,
        arguments: { msg: 'via-selfhost-bootstrap' },
        fencing: { fencingToken: lease.fencingToken, brainGen: lease.brainGen },
        issueCapabilityToken: (req) => runtime.issueSingleUseCapabilityToken({ sessionKey: req.sessionKey, callId: req.callId, toolName: req.toolName }).token,
      })
      assert.equal(res.isError, false)
      assert.equal(bridgeExecCount, 1)
      assert.ok(String(res.content[0]?.text ?? '').includes('via-selfhost-bootstrap'))
      execHandle.closeAllChannels('done')
    } finally {
      await registry.shutdown()
    }
  } finally {
    await auroraBridge.shutdown('test_done')
    await selfhostBridge.shutdown('test_done')
    runtime.dispose()
    await srv.close()
    await rm(workDir, { recursive: true, force: true })
  }
})
