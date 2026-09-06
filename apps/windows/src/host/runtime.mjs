import { createIdentityBridge } from './identityBridge.mjs'
import { createTokenMinter } from './tokenMinter.mjs'
import { createEgressProxy, createMasterProxy, EGRESS_PROXY_PORT, MASTER_PROXY_PORT } from './localProxy.mjs'
import { createGatewayProcess, GATEWAY_PORT } from './gatewayProcess.mjs'
import { createMuxHttpForwarder } from './muxForward.mjs'
import { createLocalBridgeToken, createLahToken, createLahGwToken } from './tokens.mjs'
import { createTunnelClient, TunnelState } from '../tunnel/tunnelClient.mjs'
import { createApprovalController } from './workspace/approval.mjs'
import { classifyPermissionFrame, createApprovalBridge, shouldForwardGatewayFrame } from './approvalBridge.mjs'
import { fetchArtifact } from './runtime/fetchArtifact.mjs'
import { resolveRuntimeManifest, shouldDownloadRuntimeArtifact } from './runtime/manifest.mjs'
import { applyWorkspaceToGatewaySpawn } from './workspace/applySpawn.mjs'
import { buildWorkspaceEnv } from './workspace/workspaceEnv.mjs'
import { snapshotWorkspace } from './workspace/snapshot.mjs'
import { createWorkspaceStore } from './workspace/workspaces.mjs'

export function createHostRuntime(opts = {}) {
  const {
    registerOrigin,
    egressOrigin,
    spkiPin,
    deviceCaPem,
    keyringFp = '',
    gatewayCommand,
    gatewayArgs = [],
    gatewayExtraEnv = {},
    claudeCodePath,
    claudeCodeEntry,
    claudeCodeRuntime,
    runtimeManifestUrl,
    runtimeManifestToken,
    publicOrigin,
    masterHttps,
    manifestFetchImpl,
    runtimeRoot,
    gatewayPort = GATEWAY_PORT,
    egressPort = EGRESS_PROXY_PORT,
    masterPort = MASTER_PROXY_PORT,
    refreshLeadMs,
    workspaceRoots = [],
    workspacesPath,
    now = () => Date.now(),
    onState,
    onEvent,
    onDegraded,
    onUpdateRequired,
    onApprovalRequest,
    onFallback,
  } = opts

  let identity = null
  let minter = null
  let egressProxy = null
  let masterProxy = null
  let gateway = null
  let tunnel = null
  let started = false
  let tokens = null
  let lastError = null
  let approval = null
  const audit = []

  function emit(event, extra = {}) {
    audit.push({ event, at: now(), ...extra })
    onEvent?.(event, extra)
  }

  function status() {
    return {
      started,
      tunnelState: tunnel?.state ?? TunnelState.OFFLINE,
      generation: identity?.getGeneration?.() ?? 0,
      containerId: identity?.getContainerId?.() ?? null,
      ports: {
        gateway: gatewayPort,
        egress: egressProxy?.port ?? egressPort,
        master: masterProxy?.port ?? masterPort,
      },
      degraded: Boolean(gateway?.degraded),
      degradedReason: gateway?.degradedReason ?? null,
      lastError: lastError ? String(lastError.message || lastError) : null,
      proxyStats: {
        egress: egressProxy?.stats ?? null,
        master: masterProxy?.stats ?? null,
      },
    }
  }

  async function loadWorkspaceRoots() {
    if (Array.isArray(workspaceRoots) && workspaceRoots.length > 0) return workspaceRoots
    if (typeof workspacesPath !== 'string' || !workspacesPath) return []
    try {
      const store = createWorkspaceStore({ filePath: workspacesPath })
      return await store.getRoots()
    } catch {
      return []
    }
  }

  async function snapshotRoots(roots) {
    for (const root of roots) {
      try {
        const snap = await snapshotWorkspace(root)
        emit('workspace_snapshot', { root, ok: snap.ok === true, warning: snap.warning || null, ref: snap.ref || null })
      } catch (err) {
        emit('workspace_snapshot', { root, ok: false, warning: err.message })
      }
    }
  }

  async function start(record) {
    if (started) await stop()
    lastError = null
    tokens = {
      localBridge: createLocalBridgeToken(),
      lah: createLahToken(),
      lahGw: createLahGwToken(),
    }
    identity = createIdentityBridge(record)
    minter = createTokenMinter({
      identity,
      registerOrigin,
      spkiPin,
      deviceCaPem,
      refreshLeadMs,
      now,
      onRotated: ({ reason }) => {
        emit('token_rotated', { reason })
        if (reason !== 'mint' && tunnel && !tunnel.stopped) {
          void tunnel.refreshAndReconnect(reason)
        }
      },
      onError: (err) => {
        lastError = err
        emit('token_error', { message: err.message })
      },
    })

    const proxyOpts = {
      identity,
      spkiPin,
      deviceCaPem,
      registerOrigin,
      egressOrigin,
      onUnauth: (info) => emit('lah_proxy_unauth', info),
    }
    egressProxy = createEgressProxy({
      ...proxyOpts,
      port: egressPort,
      lahToken: tokens.lah,
    })
    masterProxy = createMasterProxy({
      ...proxyOpts,
      port: masterPort,
      lahGwToken: tokens.lahGw,
    })
    try {
      await egressProxy.start()
      await masterProxy.start()
    } catch (err) {
      lastError = err
      await egressProxy.stop().catch(() => {})
      await masterProxy.stop().catch(() => {})
      const wrapped = new Error(`proxy bind failed: ${err.message}`)
      wrapped.code = err.code || 'EADDRINUSE'
      wrapped.cause = err
      throw wrapped
    }

    approval = createApprovalController({
      prompt: async (request) => {
        onApprovalRequest?.({
          id: request.id,
          kind: request.kind,
          detail: request.detail,
          command: request.command,
        })
      },
      audit: (entry) => emit(entry.event, entry),
    })
    const approvalBridge = createApprovalBridge({
      approval,
      audit: (entry) => emit(entry.event, entry),
    })

    const forwarder = createMuxHttpForwarder({
      gatewayPort,
      localBridgeToken: tokens.localBridge,
      onGatewayFrame: (data, isBinary, { sendJson }) => {
        if (isBinary) return true
        const forward = shouldForwardGatewayFrame(data, isBinary, classifyPermissionFrame)
        void approvalBridge.inspectOutbound(data, { sendJson }).catch((err) => {
          emit('approval_bridge_error', { message: err.message })
        })
        return forward
      },
    })

    const roots = await loadWorkspaceRoots()
    const workspaceEnv = buildWorkspaceEnv({ roots, platform: process.platform })
    const spawnOpts = applyWorkspaceToGatewaySpawn(workspaceEnv, { extraEnv: gatewayExtraEnv })

    let resolvedClaudeCodePath = claudeCodePath
    try {
      const resolvedManifest = await resolveRuntimeManifest({
        remoteUrl: runtimeManifestUrl,
        accessToken: runtimeManifestToken,
        publicOrigin: publicOrigin || registerOrigin,
        masterHttps,
        fetchImpl: manifestFetchImpl,
        env: opts.env || process.env,
      })
      if (shouldDownloadRuntimeArtifact(resolvedManifest)) {
        const fetched = await fetchArtifact({
          url: resolvedManifest.selected.url,
          sha256: resolvedManifest.selected.sha256,
          spkiPin,
          publicOrigin: publicOrigin || registerOrigin,
          caPem: deviceCaPem,
          destRoot: runtimeRoot,
        })
        resolvedClaudeCodePath = fetched.path
        emit('runtime_ready', { source: resolvedManifest.source, sha256: resolvedManifest.selected.sha256 })
      } else {
        emit('runtime_unavailable', { reason: resolvedManifest.reason || 'placeholder-bake', source: resolvedManifest.source })
      }
    } catch (err) {
      emit('runtime_unavailable', { reason: err.code || err.message })
    }

    gateway = createGatewayProcess({
      command: gatewayCommand,
      args: gatewayArgs,
      cwd: spawnOpts.cwd,
      localBridgeToken: tokens.localBridge,
      lahGwToken: tokens.lahGw,
      lahToken: tokens.lah,
      masterProxyPort: masterProxy.port,
      egressProxyPort: egressProxy.port,
      gatewayPort,
      claudeCodePath: resolvedClaudeCodePath,
      claudeCodeEntry,
      claudeCodeRuntime,
      extraEnv: spawnOpts.extraEnv,
      onDegraded: (info) => {
        onDegraded?.(info)
        emit('gateway_degraded', info)
        onState?.(TunnelState.DEGRADED)
      },
      onExit: (info) => emit('gateway_exit', info),
    })
    try {
      await gateway.start()
      await snapshotRoots(roots)
      const minted = await minter.mint('mint')
      minter.start(minted.expires_in)

      const containerId = Number(identity.getContainerId()) || Number(minted.container_id)
      tunnel = createTunnelClient({
        identity,
        registerOrigin,
        egressOrigin,
        spkiPin,
        deviceCaPem,
        containerId,
        keyringFp,
        handler: forwarder.handler,
        onOpenWs: forwarder.onOpenWs,
        now,
        onState,
        onUpdateRequired,
        onEvent: (event, extra) => {
          emit(event, extra)
          if (extra?.code === 'KILLSWITCH' || extra?.mapped === 'KILLSWITCH') {
            onFallback?.({ reason: 'killswitch' })
          }
          if (event === 'stopped' && extra?.reason === 'flag_off') {
            onFallback?.({ reason: 'flag_off' })
          }
        },
        refreshToken: async ({ reason }) => minter.refresh(reason),
      })
      started = true
      tunnel.start()
      emit('started', { ports: status().ports })
      return status()
    } catch (err) {
      lastError = err
      await stop('start_failed')
      throw err
    }
  }

  async function stop(reason = 'stop') {
    started = false
    try { minter?.stop() } catch { /* */ }
    try { tunnel?.stop(reason) } catch { /* */ }
    try { await gateway?.stop() } catch { /* */ }
    try { await egressProxy?.stop() } catch { /* */ }
    try { await masterProxy?.stop() } catch { /* */ }
    identity?.clearSession?.()
    emit('stopped', { reason })
  }

  function handlePower(event) {
    if (!tunnel) return
    if (event === 'suspend') tunnel.onSuspend()
    else if (event === 'resume') tunnel.onResume()
    else if (event === 'network_change' || event === 'offline' || event === 'online') tunnel.onNetworkChange()
  }

  return {
    start,
    stop,
    status,
    handlePower,
    approve(id) {
      return approval?.approve(id) ?? { ok: false, error: 'no-approval', approved: false }
    },
    deny(id) {
      return approval?.deny(id) ?? { ok: false, error: 'no-approval', approved: false }
    },
    get identity() {
      return identity
    },
    get tokens() {
      return tokens
    },
    get audit() {
      return audit.slice()
    },
    get tunnel() {
      return tunnel
    },
    get gateway() {
      return gateway
    },
    get approval() {
      return approval
    },
  }
}
