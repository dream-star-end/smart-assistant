/**
 * OpenViking P1 (B1): the gateway-only authority behind the context façade.
 *
 * In-process only. Nothing here is written to disk or handed to an engine/CLI
 * process: the model shares uid 1000 with the gateway, so no file it can reach
 * proves authority, and every CLI caller stays `cli_lease_blocked`.
 *
 * - turnId (A2): a fresh random id per submit, taken under the turn lock;
 *   rotated when the logical turn aborts.
 * - authorityEpoch (A3): boot nonce + per-agent generation + per-turn sequence.
 *   The agent generation advances on an identity alias change. Project binding
 *   and prompt privacy are frozen at turn start, so a turn stop (which retires
 *   the sequence) is what makes a rebind or privacy change unreplayable.
 * - revoke (A4): an authority is current only while its turn, turnId and epoch
 *   still match; `revoked` is re-evaluated on every read. The v1 policy file
 *   lifecycle (deny then unlink) is untouched.
 * - companion (A5): this registry is the companion record. There is no CLI
 *   reader yet, so there is no file.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_MEMORY_SEARCH_POLICY,
  paths,
  type GatewayContextAuthority,
  type IdentityCompatAssets,
  type MemoryTurnPolicyDecision,
} from '@openclaude/storage'

/** One façade read must finish inside this window; turn liveness is checked separately. */
export const CONTEXT_AUTHORITY_READ_TTL_MS = 120_000

export interface ContextTurnInput {
  sessionId: string
  agentId: string
  chatProjectId: string | null
  memoryPolicy: MemoryTurnPolicyDecision
  promptPrivacyFingerprint: string | undefined
  /** IdentityCompatRuntimeContext of this turn's admission. */
  identity?: { assets?: IdentityCompatAssets; fingerprint?: string }
}

export interface ContextTurnHandle {
  readonly turnId: string
  rotate(): void
  end(): void
}

export interface ContextTurnSummary {
  sessionId: string
  startedAt: number
  chatProjectId: string | null
  memoryPolicy: Readonly<MemoryTurnPolicyDecision>
}

interface TurnState {
  readonly sessionId: string
  readonly agentId: string
  readonly seq: number
  readonly startedAt: number
  readonly chatProjectId: string | null
  readonly memoryPolicy: Readonly<MemoryTurnPolicyDecision>
  readonly policyFingerprint: string
  readonly identityAssets: IdentityCompatAssets | undefined
  turnId: string
  ended: boolean
}

interface AgentState {
  generation: number
  identityFingerprint: string | undefined
}

export interface ContextAuthorityRegistryDeps {
  now?: () => number
  randomId?: () => string
  domainId?: string
  root?: string
}

function fingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export class ContextAuthorityRegistry {
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly boot: string
  private readonly domainId: string
  private readonly root: string
  private readonly agents = new Map<string, AgentState>()
  private readonly turns = new Map<string, TurnState>()
  private seq = 0

  constructor(deps: ContextAuthorityRegistryDeps = {}) {
    this.now = deps.now ?? Date.now
    this.randomId = deps.randomId ?? randomUUID
    this.boot = this.randomId()
    this.domainId = deps.domainId ?? (process.env.OC_USER_ID?.trim() || 'default')
    this.root = deps.root ?? paths.home
  }

  private agent(agentId: string): AgentState {
    let state = this.agents.get(agentId)
    if (!state) {
      state = { generation: 0, identityFingerprint: undefined }
      this.agents.set(agentId, state)
    }
    return state
  }

  /** Identity alias registration changed: every authority of this agent is retired. */
  bumpAgent(agentId: string): void {
    this.agent(agentId).generation += 1
  }

  /** Call under the turn lock, after the turn's memory policy and privacy are frozen. */
  beginTurn(input: ContextTurnInput): ContextTurnHandle {
    const agent = this.agent(input.agentId)
    const identityFingerprint = input.identity?.fingerprint
    if (agent.identityFingerprint !== undefined && agent.identityFingerprint !== identityFingerprint) {
      agent.generation += 1
    }
    agent.identityFingerprint = identityFingerprint
    const memoryPolicy = Object.freeze({ ...input.memoryPolicy })
    const turn: TurnState = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      seq: ++this.seq,
      startedAt: this.now(),
      chatProjectId: input.chatProjectId,
      memoryPolicy,
      policyFingerprint: fingerprint([memoryPolicy.allowed, memoryPolicy.reason, input.promptPrivacyFingerprint ?? null]),
      identityAssets: input.identity?.assets,
      turnId: this.randomId(),
      ended: false,
    }
    this.turns.set(input.sessionId, turn)
    return {
      get turnId() { return turn.turnId },
      rotate: () => { if (!turn.ended) turn.turnId = this.randomId() },
      end: () => {
        turn.ended = true
        if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId)
      },
    }
  }

  private epoch(agentId: string, scope: string): string {
    return `${this.boot}:${this.agent(agentId).generation}:${scope}`
  }

  /** A fresh authority for the session's live turn, or null when no turn is live. */
  mintTurn(sessionId: string): { authority: GatewayContextAuthority; identityAssets?: IdentityCompatAssets } | null {
    const turn = this.turns.get(sessionId)
    if (!turn || turn.ended) return null
    const turnId = turn.turnId
    const authorityEpoch = this.epoch(turn.agentId, `t${turn.seq}`)
    const authority = this.build({
      effectiveAgentId: turn.agentId,
      sessionId,
      turnId,
      authorityEpoch,
      memoryPolicy: turn.memoryPolicy,
      policyFingerprint: turn.policyFingerprint,
    }, () => this.turns.get(sessionId) === turn && !turn.ended && turn.turnId === turnId
      && this.epoch(turn.agentId, `t${turn.seq}`) === authorityEpoch)
    return turn.identityAssets ? { authority, identityAssets: turn.identityAssets } : { authority }
  }

  /**
   * The owner's own management view (MemoryPanel). Gateway HTTP auth already
   * admitted the request; the panel reads only what it can already list.
   */
  mintPanel(agentId: string): GatewayContextAuthority {
    const authorityEpoch = this.epoch(agentId, 'panel')
    const memoryPolicy = Object.freeze({ ...DEFAULT_MEMORY_SEARCH_POLICY })
    return this.build({
      effectiveAgentId: agentId,
      sessionId: `panel:${agentId}`,
      turnId: this.randomId(),
      authorityEpoch,
      memoryPolicy,
      policyFingerprint: fingerprint([memoryPolicy.allowed, memoryPolicy.reason, 'panel']),
    }, () => this.epoch(agentId, 'panel') === authorityEpoch)
  }

  activeTurns(agentId: string): ContextTurnSummary[] {
    return [...this.turns.values()]
      .filter((turn) => turn.agentId === agentId && !turn.ended)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((turn) => ({
        sessionId: turn.sessionId,
        startedAt: turn.startedAt,
        chatProjectId: turn.chatProjectId,
        memoryPolicy: turn.memoryPolicy,
      }))
  }

  private build(fields: Pick<GatewayContextAuthority,
    'effectiveAgentId' | 'sessionId' | 'turnId' | 'authorityEpoch' | 'memoryPolicy' | 'policyFingerprint'>,
  current: () => boolean): GatewayContextAuthority {
    return Object.freeze({
      runtime: 'gateway' as const,
      domainId: this.domainId,
      boardProjectId: null,
      contextVersion: null,
      // No formal root is configured on the gateway yet; legacy paths stay authoritative.
      mode: 'legacy' as const,
      root: this.root,
      expiresAt: this.now() + CONTEXT_AUTHORITY_READ_TTL_MS,
      ...fields,
      get revoked() { return !current() },
    })
  }
}

export const contextAuthorities = new ContextAuthorityRegistry()
