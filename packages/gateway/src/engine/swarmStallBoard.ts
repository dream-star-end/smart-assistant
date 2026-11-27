import type { SwarmBoardPost, SwarmMemberSnapshot } from '@openclaude/protocol'

export function mentionMatchesWorker(mention: string, workerName: string): boolean {
  const m = mention.toLowerCase()
  const w = workerName.toLowerCase()
  if (!m || m === 'all' || m.startsWith('#')) return false
  if (m === w) return true
  return w.startsWith(`${m}-`) && /^\d+$/.test(w.slice(m.length + 1))
}

interface PeerRequest {
  readonly post: SwarmBoardPost
  readonly sender: SwarmMemberSnapshot
  readonly recipient: SwarmMemberSnapshot
}

function answersPeerRequest(reply: SwarmBoardPost, request: PeerRequest): boolean {
  if (reply.seq <= request.post.seq || (reply.channel ?? 'main') !== (request.post.channel ?? 'main')) return false
  if (reply.agent.trim().toLowerCase() !== request.recipient.name.toLowerCase()) return false
  if (reply.mentions.length === 0) return true
  // A new worker → verifier request is not an acknowledgement of an older verifier reply.
  if (request.sender.role === 'verifier' && request.recipient.role === 'worker') return false
  return reply.mentions.length === 1 && reply.mentions[0] === request.sender.name.toLowerCase()
}

/**
 * Infer narrow peer receipts from the current sequence-ordered board tail.
 * A mention or read cursor alone is not acceptance. A receipt is not also
 * a new request, which would otherwise absorb later unrelated posts.
 */
export function findPeerHandoffs(
  posts: readonly SwarmBoardPost[],
  liveWorkers: readonly SwarmMemberSnapshot[],
): { coveredSeqs: ReadonlySet<number>; receiptSeq: number | undefined } {
  const coveredSeqs = new Set<number>()
  const pending: PeerRequest[] = []
  const workers = new Map(liveWorkers.map((member) => [member.name.toLowerCase(), member]))
  let receiptSeq: number | undefined
  for (const post of posts) {
    const repliesTo = pending.filter((request) => !coveredSeqs.has(request.post.seq) && answersPeerRequest(post, request))
    const latest = repliesTo.at(-1)
    if (latest) {
      for (const request of repliesTo) {
        if (request.sender === latest.sender) coveredSeqs.add(request.post.seq)
      }
      coveredSeqs.add(post.seq)
      receiptSeq = post.seq
      continue
    }

    const sender = workers.get(post.agent.trim().toLowerCase())
    const mention = post.mentions[0]
    if (!sender || post.mentions.length !== 1 || !mention) continue
    const recipients = liveWorkers.filter((member) => mentionMatchesWorker(mention, member.name))
    const recipient = recipients[0]
    if (recipients.length === 1 && recipient && recipient !== sender) pending.push({ post, sender, recipient })
  }
  return { coveredSeqs, receiptSeq }
}

const PARKED_WAIT_ACTIVITIES = new Set(['等待讨论板消息', '已完成本轮思考'])

/**
 * True when a live member is parked waiting for board activity rather than
 * actively executing tools or thinking.
 *
 * Note: in native Antigravity transcripts, a member currently blocked inside
 * `swarm_wait` shows `status: 'working'` with `activity: '等待讨论板消息'`.
 * Treating that state as effectively waiting prevents deadlocked `swarm_wait`
 * pairs from looking permanently busy.
 */
export function isMemberEffectivelyWaiting(member: SwarmMemberSnapshot): boolean {
  if (member.status === 'killed') return false
  if (member.status === 'waiting' || member.status === 'stopped') return true
  if (typeof member.waitingOnBoard === 'boolean') return member.waitingOnBoard
  return (
    member.status === 'working' &&
    typeof member.activity === 'string' &&
    PARKED_WAIT_ACTIVITIES.has(member.activity)
  )
}

export function classifyWork(liveCoreMembers: readonly SwarmMemberSnapshot[]) {
  const workingMembers: string[] = []
  const waitingMembers: string[] = []
  for (const m of liveCoreMembers) {
    if (isMemberEffectivelyWaiting(m)) waitingMembers.push(m.name)
    else workingMembers.push(m.name)
  }
  return { workingMembers, waitingMembers }
}
