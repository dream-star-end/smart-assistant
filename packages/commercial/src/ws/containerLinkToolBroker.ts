/**
 * OCV5-915 P3-2 — Master `ContainerLink` <-> ToolBroker bridge (`ws-container-link`, selfhost v5 gated).
 *
 * Bridges `ContainerLinkRegistry` (`local-docker`, `compute-pool-docker`, `desktop-virtual`)
 * to L0 `FrameLinkLike` + `openExecEnvToolBrokerChannel`, reserving the ENTIRE `broker.*`
 * frame namespace BEFORE `ContainerLink.deliver()` can route frames to browser handles or
 * `this.queued` (W03), propagating transport close immediately to all pending clients, and
 * gating strictly on proven selfhost v5 identity (B05-P32).
 *
 * Architecture invariants:
 * - Zero `process.env`, zero `syncIo`, zero `emptyCatch`, zero `typeEscape`, zero `export *`.
 * - Imports ONLY L0 `@openclaude/protocol/exec-env` and `../runtimeChannel.js`.
 */
import {
  defaultCapabilitiesForHostKind,
  isReservedToolBrokerFrame,
  isToolBrokerWireFrame,
  openExecEnvToolBrokerChannel,
  type ContainerLinkToolBrokerClient,
  type ExecEnvAttachmentDigest,
  type ExecEnvCapabilities,
  type ExecEnvChannelKind,
  type ExecEnvHandle,
  type ExecEnvHostKind,
  type ExecEnvLease,
  type FrameLinkLike,
  type OpenToolBrokerChannelRequest,
} from '@openclaude/protocol/exec-env'
import { getRuntimeChannel } from '../runtimeChannel.js'

export { defaultCapabilitiesForHostKind }

export class ToolBrokerBridgeError extends Error {
  constructor(
    readonly code:
      | 'TOOL_BROKER_SELFHOST_ONLY'
      | 'TOOL_BROKER_LINK_NOT_OPEN'
      | 'TOOL_BROKER_UNSUPPORTED_HOST_KIND',
    message: string,
  ) {
    super(message)
    this.name = 'ToolBrokerBridgeError'
  }
}

const SUPPORTED_HOST_KINDS: ReadonlySet<ExecEnvHostKind> = new Set([
  'local-docker',
  'compute-pool-docker',
  'desktop-virtual',
])

export interface ToolBrokerFlavorIdentityLike {
  readonly status: string
  readonly flavor?: string
}

export interface ToolBrokerBridgeGateOptions {
  readonly selfhostEnabled?: boolean
  readonly flavorIdentity?: ToolBrokerFlavorIdentityLike | null
  readonly runtimeChannel?: string
}

/**
 * Strict B05-P32 gate: ToolBroker over ContainerLink is enabled ONLY on proven
 * personal selfhost v5 deployments. Commercial Aurora ALSO runs `runtimeChannel === 'v5'`
 * and MUST remain 100% disabled when `selfhostEnabled !== true` and `flavorIdentity.flavor !== 'selfhost'`.
 */
export function isToolBrokerBridgeEnabled(opts?: ToolBrokerBridgeGateOptions): boolean {
  const channel = opts?.runtimeChannel ?? getRuntimeChannel()
  if (channel !== 'v5') return false
  if (typeof opts?.selfhostEnabled === 'boolean') return opts.selfhostEnabled
  if (opts?.flavorIdentity) {
    return opts.flavorIdentity.status === 'ok' && opts.flavorIdentity.flavor === 'selfhost'
  }
  return false
}

/**
 * Per-`ContainerLink` tap that reserves the ENTIRE `broker.*` namespace before
 * browser handles or `ContainerLink.queued` ever observe it (W03), and notifies
 * subscribed clients immediately when the underlying transport closes.
 */
export class ContainerLinkBrokerTap {
  private readonly listeners = new Set<(raw: string) => void>()
  private readonly closeListeners = new Set<(reason: string) => void>()
  private disposed = false
  private disposedReason = 'container_link_closed'

  get listenerCount(): number {
    return this.listeners.size
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  subscribe(listener: (raw: string) => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.disposed) {
      queueMicrotask(() => listener(this.disposedReason))
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  /**
   * Reserves ALL inbound `broker.*` frames (valid, malformed, or future versions)
   * so `ContainerLink.deliver()` NEVER forwards them to browsers or `this.queued`.
   * Only well-formed `ToolBrokerWireFrame` payloads are dispatched to listeners.
   */
  interceptInboundData(raw: string, parsedFrame: Record<string, unknown> | null): boolean {
    if (!parsedFrame || !isReservedToolBrokerFrame(parsedFrame)) return false
    if (this.disposed || this.listeners.size === 0 || !isToolBrokerWireFrame(parsedFrame)) {
      return true
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(raw)
      } catch (err) {
        void err
      }
    }
    return true
  }

  dispose(reason = 'container_link_closed'): void {
    if (this.disposed) return
    this.disposed = true
    this.disposedReason = reason
    this.listeners.clear()
    for (const cb of [...this.closeListeners]) {
      try {
        cb(reason)
      } catch (err) {
        void err
      }
    }
    this.closeListeners.clear()
  }
}

export interface ContainerLinkBrokerLinkLike {
  readonly uid: bigint
  readonly containerId: number
  readonly stopping: boolean
  readonly brokerTap: ContainerLinkBrokerTap
  isOpen(): boolean
  sendBrokerRaw(raw: string): void
}

export interface ContainerLinkRegistryBrokerLookup {
  readonly toolBrokerEnabled?: boolean
  getActiveBrokerLink(uid: bigint, containerId: number): ContainerLinkBrokerLinkLike | null
}

export interface ManagedContainerLinkFrameLink extends FrameLinkLike {
  readonly hostKind: ExecEnvHostKind
  close(reason?: string): void
}

export function createContainerLinkFrameLink(deps: {
  readonly link: ContainerLinkBrokerLinkLike
  readonly hostKind?: ExecEnvHostKind
}): ManagedContainerLinkFrameLink {
  const hostKind: ExecEnvHostKind = deps.hostKind ?? 'compute-pool-docker'
  if (!SUPPORTED_HOST_KINDS.has(hostKind)) {
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_UNSUPPORTED_HOST_KIND',
      `Unsupported ExecEnv hostKind: ${String(hostKind)}`,
    )
  }
  const unsubs = new Set<() => void>()
  const closeListeners = new Set<(reason: string) => void>()
  let closed = false
  let closeReason = 'frame_link_closed'

  const notifyClose = (reason: string) => {
    if (closed) return
    closed = true
    closeReason = reason
    for (const unsub of [...unsubs]) unsub()
    unsubs.clear()
    for (const cb of [...closeListeners]) {
      try {
        cb(reason)
      } catch (err) {
        void err
      }
    }
    closeListeners.clear()
  }

  const unsubTapClose = deps.link.brokerTap.onClose((reason) => {
    notifyClose(reason)
  })
  unsubs.add(unsubTapClose)

  return {
    hostKind,
    send(raw: string): void {
      if (closed || deps.link.stopping || !deps.link.isOpen()) {
        throw new ToolBrokerBridgeError(
          'TOOL_BROKER_LINK_NOT_OPEN',
          `ContainerLink ${String(deps.link.uid)}:${deps.link.containerId} is not open`,
        )
      }
      deps.link.sendBrokerRaw(raw)
    },
    onFrame(cb: (raw: string) => void): () => void {
      if (closed) return () => {}
      const unsub = deps.link.brokerTap.subscribe(cb)
      unsubs.add(unsub)
      return () => {
        if (unsubs.delete(unsub)) unsub()
      }
    },
    onClose(cb: (reason: string) => void): () => void {
      if (closed) {
        queueMicrotask(() => cb(closeReason))
        return () => {}
      }
      closeListeners.add(cb)
      return () => {
        closeListeners.delete(cb)
      }
    },
    close(reason = 'frame_link_closed'): void {
      notifyClose(reason)
    },
  }
}

export interface OpenContainerLinkToolBrokerChannelDeps extends ToolBrokerBridgeGateOptions {
  readonly registry: ContainerLinkRegistryBrokerLookup
  readonly uid: bigint
  readonly containerId: number
  readonly hostKind: ExecEnvHostKind
  readonly request: OpenToolBrokerChannelRequest
}

export type ManagedContainerLinkToolBrokerChannel = ContainerLinkToolBrokerClient & {
  readonly hostKind: ExecEnvHostKind
}

function assertBridgeEnabled(opts: ToolBrokerBridgeGateOptions & { readonly registry?: ContainerLinkRegistryBrokerLookup }): void {
  const effectiveSelfhost =
    typeof opts.selfhostEnabled === 'boolean'
      ? opts.selfhostEnabled
      : typeof opts.registry?.toolBrokerEnabled === 'boolean' && !opts.flavorIdentity
        ? opts.registry.toolBrokerEnabled
        : undefined
  if (
    !isToolBrokerBridgeEnabled({
      selfhostEnabled: effectiveSelfhost,
      flavorIdentity: opts.flavorIdentity,
      runtimeChannel: opts.runtimeChannel,
    })
  ) {
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_SELFHOST_ONLY',
      'ContainerLink ToolBroker channel is gated to proven selfhost v5 deployments',
    )
  }
}

export function openContainerLinkToolBrokerChannel(
  deps: OpenContainerLinkToolBrokerChannelDeps,
): ManagedContainerLinkToolBrokerChannel {
  assertBridgeEnabled(deps)
  if (!SUPPORTED_HOST_KINDS.has(deps.hostKind)) {
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_UNSUPPORTED_HOST_KIND',
      `Unsupported ExecEnv hostKind: ${String(deps.hostKind)}`,
    )
  }
  const link = deps.registry.getActiveBrokerLink(deps.uid, deps.containerId)
  if (!link || link.stopping || !link.isOpen()) {
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_LINK_NOT_OPEN',
      `No open ContainerLink for uid=${String(deps.uid)} containerId=${deps.containerId}`,
    )
  }
  const frameLink = createContainerLinkFrameLink({ link, hostKind: deps.hostKind })
  const leaseId = deps.request.leaseId ?? ''
  if (!leaseId) {
    frameLink.close('missing_lease_id')
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_LINK_NOT_OPEN',
      'OpenToolBrokerChannelRequest.leaseId is required when opening via ContainerLinkRegistry',
    )
  }
  const channel = openExecEnvToolBrokerChannel('tool-broker', {
    ...deps.request,
    leaseId,
    link: frameLink,
    hostKind: deps.hostKind,
    channelKind: deps.request.channelKind ?? 'ws_tunnel',
  })
  const origClose = channel.close.bind(channel)
  channel.close = (reason?: string): void => {
    try {
      origClose(reason)
    } finally {
      frameLink.close(reason)
    }
  }
  return Object.assign(channel, { hostKind: deps.hostKind })
}

export interface ContainerLinkExecEnvHandleDescriptor {
  readonly envId: string
  readonly uid: bigint | string
  readonly containerDbId?: number
  readonly containerId?: number
  readonly hostKind: ExecEnvHostKind
}

export interface AttachContainerLinkExecEnvHandleDeps extends ToolBrokerBridgeGateOptions {
  readonly registry: ContainerLinkRegistryBrokerLookup
  readonly descriptor: ContainerLinkExecEnvHandleDescriptor
  readonly lease: ExecEnvLease
  readonly attachment: ExecEnvAttachmentDigest
  readonly capabilities?: ExecEnvCapabilities
}

export interface ContainerLinkExecEnvHandle extends ExecEnvHandle {
  openChannel(
    channelName: 'tool-broker',
    opts: OpenToolBrokerChannelRequest,
  ): ManagedContainerLinkToolBrokerChannel
  closeAllChannels(reason?: string): void
  activeChannelCount(): number
}

/**
 * Production FrameLink opener factory bound directly to a `ContainerLinkRegistry`,
 * accepted by `HostAwareContainerService.bindBrokerFrameLinkOpener(...)` (B10).
 */
export function createContainerLinkFrameLinkOpener(
  registry: ContainerLinkRegistryBrokerLookup,
  gate?: ToolBrokerBridgeGateOptions,
): (
  request: OpenToolBrokerChannelRequest,
  descriptor: { readonly uid?: bigint | string; readonly containerDbId?: number; readonly hostKind: ExecEnvHostKind },
) => FrameLinkLike {
  return (_request, descriptor) => {
    assertBridgeEnabled({ ...gate, registry })
    if (descriptor.uid === undefined || descriptor.containerDbId === undefined) {
      throw new ToolBrokerBridgeError(
        'TOOL_BROKER_LINK_NOT_OPEN',
        'Container descriptor requires uid and containerDbId to open ContainerLink frame link',
      )
    }
    const uid = typeof descriptor.uid === 'bigint' ? descriptor.uid : BigInt(descriptor.uid)
    const link = registry.getActiveBrokerLink(uid, descriptor.containerDbId)
    if (!link || link.stopping || !link.isOpen()) {
      throw new ToolBrokerBridgeError(
        'TOOL_BROKER_LINK_NOT_OPEN',
        `No open ContainerLink for uid=${String(uid)} containerId=${descriptor.containerDbId}`,
      )
    }
    return createContainerLinkFrameLink({ link, hostKind: descriptor.hostKind })
  }
}

/**
 * Production `ContainerLinkRegistry -> ExecEnvHandle` lifecycle binder (B10).
 */
export function attachContainerLinkExecEnvHandle(
  deps: AttachContainerLinkExecEnvHandleDeps,
): ContainerLinkExecEnvHandle {
  assertBridgeEnabled(deps)
  const uid = typeof deps.descriptor.uid === 'bigint' ? deps.descriptor.uid : BigInt(deps.descriptor.uid)
  const containerId = deps.descriptor.containerId ?? deps.descriptor.containerDbId
  if (containerId === undefined) {
    throw new ToolBrokerBridgeError(
      'TOOL_BROKER_LINK_NOT_OPEN',
      'Container descriptor requires containerId or containerDbId',
    )
  }
  const activeChannels = new Set<ManagedContainerLinkToolBrokerChannel>()
  const capabilities: ExecEnvCapabilities =
    deps.capabilities ?? defaultCapabilitiesForHostKind(deps.descriptor.hostKind)

  return {
    envId: deps.descriptor.envId,
    lease: deps.lease,
    capabilities,
    attachment: deps.attachment,
    openChannel(
      channelName: 'tool-broker',
      opts: OpenToolBrokerChannelRequest,
    ): ManagedContainerLinkToolBrokerChannel {
      if (channelName !== 'tool-broker') {
        throw new ToolBrokerBridgeError(
          'TOOL_BROKER_UNSUPPORTED_HOST_KIND',
          `Unsupported ExecEnv channel: ${String(channelName)}`,
        )
      }
      const leaseId = opts.leaseId ?? deps.lease.leaseId
      if (leaseId !== deps.lease.leaseId) {
        throw new ToolBrokerBridgeError(
          'TOOL_BROKER_LINK_NOT_OPEN',
          `Requested leaseId "${leaseId}" does not match ExecEnvHandle lease "${deps.lease.leaseId}"`,
        )
      }
      const channelKind: ExecEnvChannelKind =
        opts.channelKind ?? deps.attachment.channelKind ?? 'ws_tunnel'
      const ch = openContainerLinkToolBrokerChannel({
        registry: deps.registry,
        uid,
        containerId,
        hostKind: deps.descriptor.hostKind,
        request: {
          ...opts,
          leaseId,
          sessionKey: opts.sessionKey ?? deps.lease.sessionKey,
          channelKind,
        },
        selfhostEnabled: deps.selfhostEnabled,
        flavorIdentity: deps.flavorIdentity,
        runtimeChannel: deps.runtimeChannel,
      })
      activeChannels.add(ch)
      const origClose = ch.close.bind(ch)
      ch.close = (reason?: string): void => {
        activeChannels.delete(ch)
        origClose(reason)
      }
      return ch
    },
    closeAllChannels(reason = 'exec_env_handle_closed'): void {
      for (const ch of [...activeChannels]) {
        activeChannels.delete(ch)
        ch.close(reason)
      }
    },
    activeChannelCount(): number {
      return activeChannels.size
    },
  }
}
