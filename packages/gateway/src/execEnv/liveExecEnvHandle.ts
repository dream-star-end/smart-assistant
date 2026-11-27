/**
 * OCV5-915 P3-2 — Live `ExecEnvHandle` implementation (`rt-exec-env` rank 0).
 *
 * Implements L0 `ExecEnvHandle` with live `openChannel('tool-broker', opts)` over an injected
 * `FrameLinkLike` opener so local-docker, compute-pool-docker, and desktop-virtual hosts expose
 * one uniform multiplexed ToolBroker channel surface with tracked teardown (Q4).
 */
import {
  ToolBrokerTransportError,
  openExecEnvToolBrokerChannel,
  type ContainerLinkToolBrokerClient,
  type ExecEnvAttachmentDigest,
  type ExecEnvCapabilities,
  type ExecEnvHandle,
  type ExecEnvHostKind,
  type ExecEnvLease,
  type FrameLinkLike,
  type OpenToolBrokerChannelRequest,
} from '@openclaude/protocol/exec-env'

export interface OpenExecEnvFrameLinkContext {
  readonly envId: string
  readonly hostKind: ExecEnvHostKind
  readonly leaseId: string
  readonly sessionKey: string
  readonly channelId?: string
}

export type OpenExecEnvFrameLinkFn = (ctx: OpenExecEnvFrameLinkContext) => FrameLinkLike

export interface LiveExecEnvHandleOptions {
  readonly envId: string
  readonly lease: ExecEnvLease
  readonly capabilities: ExecEnvCapabilities
  readonly attachment: ExecEnvAttachmentDigest
  readonly openFrameLink: OpenExecEnvFrameLinkFn
}

export interface LiveExecEnvHandle extends ExecEnvHandle {
  openChannel(
    channelName: 'tool-broker',
    opts: OpenToolBrokerChannelRequest,
  ): ContainerLinkToolBrokerClient
  readonly openChannelCount: number
  activeChannelCount(): number
  closeAllChannels(reason?: string): void
}

export function createLiveExecEnvHandle(opts: LiveExecEnvHandleOptions): LiveExecEnvHandle {
  const activeChannels = new Set<ContainerLinkToolBrokerClient>()

  const handle: LiveExecEnvHandle = {
    envId: opts.envId,
    lease: opts.lease,
    capabilities: opts.capabilities,
    attachment: opts.attachment,

    get openChannelCount(): number {
      return activeChannels.size
    },

    activeChannelCount(): number {
      return activeChannels.size
    },

    openChannel(
      channelName: 'tool-broker',
      req: OpenToolBrokerChannelRequest,
    ): ContainerLinkToolBrokerClient {
      if (channelName !== 'tool-broker') {
        throw new ToolBrokerTransportError(
          'UNSUPPORTED_CHANNEL_NAME',
          `Unsupported ExecEnv channel "${String(channelName)}"`,
        )
      }
      const leaseId = req.leaseId ?? opts.lease.leaseId
      if (leaseId !== opts.lease.leaseId) {
        throw new ToolBrokerTransportError(
          'EXEC_LEASE_MISMATCH',
          `Requested leaseId "${leaseId}" does not match ExecEnvHandle lease "${opts.lease.leaseId}"`,
        )
      }
      const sessionKey = req.sessionKey ?? opts.lease.sessionKey
      const link = opts.openFrameLink({
        envId: opts.envId,
        hostKind: opts.capabilities.hostKind,
        leaseId,
        sessionKey,
        ...(req.channelId === undefined ? {} : { channelId: req.channelId }),
      })
      const client = openExecEnvToolBrokerChannel('tool-broker', {
        link,
        hostKind: opts.capabilities.hostKind,
        leaseId,
        fencingToken: req.fencingToken,
        ...(req.brainGen === undefined ? {} : { brainGen: req.brainGen }),
        sessionKey,
        ...(req.channelKind === undefined ? {} : { channelKind: req.channelKind }),
        ...(req.channelId === undefined ? {} : { channelId: req.channelId }),
        ...(req.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: req.requestTimeoutMs }),
      })
      activeChannels.add(client)
      const rawClose = client.close.bind(client)
      client.close = (reason?: string): void => {
        activeChannels.delete(client)
        rawClose(reason)
      }
      return client
    },

    closeAllChannels(reason = 'exec_env_handle_closed'): void {
      for (const client of [...activeChannels]) {
        client.close(reason)
      }
      activeChannels.clear()
    },
  }

  return handle
}
