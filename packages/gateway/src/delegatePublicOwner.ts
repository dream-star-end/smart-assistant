import { getConsumedAuthorityUserId, type TurnExecutionDescriptor } from './modelAuthority.js'

type Root = { sessionKey: string; userId?: string; agentId: string; channel: string; peerId: string }
type Witness = Readonly<{ userId: string; physical: string }>
const physicalIdentity = (root: Root) => JSON.stringify([root.sessionKey, root.userId, root.agentId, root.channel, root.peerId])

/** Per-Gateway actual-object binding, never a default-user or session-key alias.
 * Restored roots do not receive a witness from persisted retry source metadata. */
export class DelegatePublicOwnerBindings {
  private readonly roots = new WeakMap<Root, Witness>()

  bind(root: Root, descriptor: TurnExecutionDescriptor | undefined): void {
    const userId = getConsumedAuthorityUserId(descriptor)
    if (!userId) return
    if (root.channel !== 'webchat' || !root.userId?.trim() || !root.peerId ||
        root.sessionKey !== `agent:${root.agentId}:webchat:dm:${root.peerId}`) return
    const physical = physicalIdentity(root), current = this.roots.get(root)
    if (current && (current.userId !== userId || current.physical !== physical)) {
      throw new Error('delegate public owner binding changed')
    }
    if (!current) this.roots.set(root, Object.freeze({ userId, physical }))
  }

  get(root: Root): string | undefined {
    const witness = this.roots.get(root)
    if (witness && witness.physical !== physicalIdentity(root)) throw new Error('delegate public owner identity changed')
    return witness?.userId
  }
}
