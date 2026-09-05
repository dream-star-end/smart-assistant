import { createIdentityBridge } from './identityBridge.mjs'
import { createTokenMinter } from './tokenMinter.mjs'
import { createEgressProxy, createMasterProxy, EGRESS_PROXY_PORT, MASTER_PROXY_PORT } from './localProxy.mjs'
import { createGatewayProcess, GATEWAY_PORT } from './gatewayProcess.mjs'
import { createMuxHttpForwarder } from './muxForward.mjs'
import { createLocalBridgeToken, createLahToken, createLahGwToken } from './tokens.mjs'
import { createTunnelClient, TunnelState } from '../tunnel/tunnelClient.mjs'

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
    gatewayPort = GATEWAY_PORT,
    egressPort = EGRESS_PROXY_PORT,
    masterPort = MASTER_PROXY_PORT,
    refreshLeadMs,
    now = () => Date.now(),
    onState,
    onEvent,
    onDegraded,
    onUpdateRequired,
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

    const forwarder = createMuxHttpForwarder({
      gatewayPort,
      localBridgeToken: tokens.localBridge,
    })

    gateway = createGatewayProcess({
      command: gatewayCommand,
      args: gatewayArgs,
      localBridgeToken: tokens.localBridge,
      lahGwToken: tokens.lahGw,
      lahToken: tokens.lah,
      masterProxyPort: masterProxy.port,
      egressProxyPort: egressProxy.port,
      gatewayPort,
      claudeCodePath,
      claudeCodeEntry,
      claudeCodeRuntime,
      extraEnv: gatewayExtraEnv,
      onDegraded: (info) => {
        onDegraded?.(info)
        emit('gateway_degraded', info)
        onState?.(TunnelState.DEGRADED)
      },
      onExit: (info) => emit('gateway_exit', info),
    })
    try {
      await gateway.start()
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
        onEvent: (event, extra) => emit(event, extra),
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

  return {
    start,
    stop,
    status,
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
  }
}
