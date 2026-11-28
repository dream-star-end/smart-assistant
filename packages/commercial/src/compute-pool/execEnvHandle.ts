/**
 * OCV5-915 P3-2 — Compute-pool `ExecEnvHandle` adapter (`compute-pool` L3).
 *
 * Attaches a live `ExecEnvHandle` (`openChannel('tool-broker', opts)`) to
 * `local-docker`, `compute-pool-docker`, and `desktop-virtual` descriptors
 * via an injected `FrameLinkLike` opener.
 *
 * Architecture invariants:
 * - Imports ONLY L0 `@openclaude/protocol/exec-env` (ZERO `gateway-runtime` L3 imports!).
 * - Zero `process.env`, zero `syncIo`, zero `emptyCatch`, zero `typeEscape`, zero `export *`.
 */
import {
  defaultCapabilitiesForHostKind,
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

export { defaultCapabilitiesForHostKind }

export interface ComputePoolContainerDescriptor {
  readonly envId: string
  readonly hostKind: ExecEnvHostKind
  readonly hostId?: string
  readonly containerDbId?: number
  readonly containerInternalId?: string
  readonly boundIp?: string
  readonly uid?: bigint | string
}

export interface ComputePoolExecEnvHandle extends ExecEnvHandle {
  readonly descriptor: ComputePoolContainerDescriptor
  openChannel(
    channelName: 'tool-broker',
    opts: OpenToolBrokerChannelRequest,
  ): ContainerLinkToolBrokerClient
  closeAllChannels(reason?: string): void
  activeChannelCount(): number
}

export type ComputePoolFrameLinkOpener = (
  request: OpenToolBrokerChannelRequest,
  descriptor: ComputePoolContainerDescriptor,
) => FrameLinkLike

export interface AttachComputePoolExecEnvHandleInput {
  readonly descriptor: ComputePoolContainerDescriptor
  readonly lease: ExecEnvLease
  readonly attachment: ExecEnvAttachmentDigest
  readonly capabilities?: ExecEnvCapabilities
  readonly openFrameLink: ComputePoolFrameLinkOpener
}

export function attachComputePoolExecEnvHandle(
  input: AttachComputePoolExecEnvHandleInput,
): ComputePoolExecEnvHandle {
  const capabilities =
    input.capabilities ?? defaultCapabilitiesForHostKind(input.descriptor.hostKind)
  const activeChannels = new Set<ContainerLinkToolBrokerClient>()

  return {
    envId: input.descriptor.envId,
    descriptor: input.descriptor,
    lease: input.lease,
    capabilities,
    attachment: input.attachment,

    openChannel(
      channelName: 'tool-broker',
      opts: OpenToolBrokerChannelRequest,
    ): ContainerLinkToolBrokerClient {
      if (channelName !== 'tool-broker') {
        throw new Error(`Unsupported ExecEnv channel: ${String(channelName)}`)
      }
      const leaseId = opts.leaseId ?? input.lease.leaseId
      if (leaseId !== input.lease.leaseId) {
        throw new Error(
          `Requested leaseId "${leaseId}" does not match ExecEnvHandle lease "${input.lease.leaseId}"`,
        )
      }
      const channelKind: ExecEnvChannelKind =
        opts.channelKind ?? input.attachment.channelKind ?? 'ws_tunnel'
      const normalizedReq: OpenToolBrokerChannelRequest = {
        ...opts,
        leaseId,
        sessionKey: opts.sessionKey ?? input.lease.sessionKey,
        channelKind,
      }
      const link = input.openFrameLink(normalizedReq, input.descriptor)
      const channel = openExecEnvToolBrokerChannel('tool-broker', {
        ...normalizedReq,
        leaseId,
        link,
        hostKind: input.descriptor.hostKind,
      })
      activeChannels.add(channel)
      const origClose = channel.close.bind(channel)
      channel.close = (reason?: string): void => {
        activeChannels.delete(channel)
        origClose(reason)
      }
      return channel
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
