/**
 * Unified Event Schema for OpenClaude gateway.
 *
 * All gateway events are defined here using TypeBox for:
 *   1. TypeScript type inference (compile-time)
 *   2. Runtime validation (via TypeCompiler)
 *   3. Schema versioning (SCHEMA_VERSION field)
 *
 * Categories:
 *   - cron.*       Scheduled task lifecycle
 *   - webhook.*    External webhook delivery
 *   - task.*       Task CRUD
 *   - agent.*      Inter-agent delegation
 *   - session.*    Session lifecycle
 *   - turn.*       Per-turn completion with usage
 *   - tool.*       Tool invocation tracking
 *   - memory.*     Memory read/write hits
 *   - verification.* Plan/output verification results
 */
import { type Static, Type } from '@sinclair/typebox'

// ── Schema version ──────────────────────────────
// Bump when adding/removing fields or event types.
export const EVENTS_SCHEMA_VERSION = 1

// ── Common base fields ──────────────────────────
// Every event carries these for join-ability.
export const EventBase = Type.Object({
  id: Type.String({ description: 'Unique event ID (UUID v4)' }),
  type: Type.String({ description: 'Discriminator, e.g. "turn.completed"' }),
  timestamp: Type.Number({ description: 'Unix epoch ms' }),
  agentId: Type.String(),
  sessionKey: Type.Optional(Type.String({ description: 'Matches sessions_meta.id and sessionKey in gateway' })),
  schemaVersion: Type.Literal(EVENTS_SCHEMA_VERSION),
})
export type EventBase = Static<typeof EventBase>

// ── Cron ────────────────────────────────────────
export const CronFiredEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('cron.fired'),
    jobId: Type.String(),
    output: Type.String(),
    label: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.String()),
  }),
])
export type CronFiredEvent = Static<typeof CronFiredEvent>

// ── Webhook ─────────────────────────────────────
export const WebhookReceivedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('webhook.received'),
    webhookId: Type.String(),
    payload: Type.Unknown(),
  }),
])
export type WebhookReceivedEvent = Static<typeof WebhookReceivedEvent>

// ── Task ────────────────────────────────────────
export const TaskCreatedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('task.created'),
    taskId: Type.String(),
    schedule: Type.Optional(Type.String()),
    prompt: Type.String(),
    oneshot: Type.Optional(Type.Boolean()),
    source: Type.Union([
      Type.Literal('user'),
      Type.Literal('agent'),
      Type.Literal('cron-bridge'),
    ]),
  }),
])
export type TaskCreatedEvent = Static<typeof TaskCreatedEvent>

export const TaskDeletedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('task.deleted'),
    taskId: Type.String(),
  }),
])
export type TaskDeletedEvent = Static<typeof TaskDeletedEvent>

// ── Agent ───────────────────────────────────────
export const AgentDelegatedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('agent.delegated'),
    sourceAgentId: Type.String(),
    targetAgentId: Type.String(),
    goal: Type.String(),
    sessionKey: Type.String(),
  }),
])
export type AgentDelegatedEvent = Static<typeof AgentDelegatedEvent>

export const AgentCompletedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('agent.completed'),
    sessionKey: Type.String(),
    output: Type.String(),
    error: Type.Optional(Type.String()),
    durationMs: Type.Optional(Type.Number()),
  }),
])
export type AgentCompletedEvent = Static<typeof AgentCompletedEvent>

// ── Session ─────────────────────────────────────
export const SessionCrashedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('session.crashed'),
    sessionKey: Type.String(),
    peerId: Type.String(),
    ccbSessionId: Type.Union([Type.String(), Type.Null()]),
  }),
])
export type SessionCrashedEvent = Static<typeof SessionCrashedEvent>

// ── Turn (NEW) ──────────────────────────────────
// Emitted after each API turn completes. Carries usage for cost tracking.
export const UsageInfo = Type.Object({
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  cacheReadTokens: Type.Optional(Type.Number()),
  cacheCreationTokens: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
})
export type UsageInfo = Static<typeof UsageInfo>

export const TurnCompletedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('turn.completed'),
    sessionKey: Type.String(),
    turnIndex: Type.Number(),
    usage: UsageInfo,
    toolCalls: Type.Number({ description: 'Number of tool calls in this turn' }),
    durationMs: Type.Number(),
  }),
])
export type TurnCompletedEvent = Static<typeof TurnCompletedEvent>

// ── Tool (NEW) ──────────────────────────────────
// Emitted for each tool invocation.
export const ToolCalledEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('tool.called'),
    sessionKey: Type.String(),
    turnIndex: Type.Number(),
    toolName: Type.String(),
    durationMs: Type.Number(),
    isError: Type.Boolean(),
    inputPreview: Type.Optional(Type.String({ maxLength: 500 })),
    outputPreview: Type.Optional(Type.String({ maxLength: 500 })),
  }),
])
export type ToolCalledEvent = Static<typeof ToolCalledEvent>

// ── Memory (NEW) ────────────────────────────────
// Emitted when memory is read or written.
export const MemoryHitEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('memory.hit'),
    operation: Type.Union([
      Type.Literal('read'),
      Type.Literal('write'),
      Type.Literal('search'),
    ]),
    memoryType: Type.Union([
      Type.Literal('core'),
      Type.Literal('recall'),
      Type.Literal('archival'),
    ]),
    key: Type.Optional(Type.String()),
    hitCount: Type.Optional(Type.Number()),
  }),
])
export type MemoryHitEvent = Static<typeof MemoryHitEvent>

// ── Verification (NEW) ──────────────────────────
// Emitted after automated verification of a plan/output.
export const VerificationResultEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('verification.result'),
    sessionKey: Type.String(),
    target: Type.Union([
      Type.Literal('plan'),
      Type.Literal('code'),
      Type.Literal('output'),
    ]),
    passed: Type.Boolean(),
    evidence: Type.Array(
      Type.Object({
        check: Type.String(),
        passed: Type.Boolean(),
        detail: Type.Optional(Type.String()),
      }),
    ),
  }),
])
export type VerificationResultEvent = Static<typeof VerificationResultEvent>

// ── Cost (NEW) ──────────────────────────────────
// Aggregated cost event for budget enforcement.
export const CostRecordedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('cost.recorded'),
    sessionKey: Type.String(),
    turnIndex: Type.Number(),
    usage: UsageInfo,
    sessionTotalCostUsd: Type.Number(),
  }),
])
export type CostRecordedEvent = Static<typeof CostRecordedEvent>

// ── Workflow (P2) ──────────────────────────────
// Emitted on workflow state transitions.
export const WorkflowTransitionedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('workflow.transitioned'),
    workflowId: Type.String(),
    workflowName: Type.String(),
    fromStatus: Type.String(),
    toStatus: Type.String(),
    stepIndex: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
  }),
])
export type WorkflowTransitionedEvent = Static<typeof WorkflowTransitionedEvent>

// Emitted on workflow step state transitions.
export const WorkflowStepTransitionedEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('workflow.step_transitioned'),
    workflowId: Type.String(),
    stepIndex: Type.Number(),
    stepName: Type.String(),
    fromStatus: Type.String(),
    toStatus: Type.String(),
    error: Type.Optional(Type.String()),
  }),
])
export type WorkflowStepTransitionedEvent = Static<typeof WorkflowStepTransitionedEvent>

// Emitted when an approval request is created or resolved.
export const ApprovalEvent = Type.Intersect([
  EventBase,
  Type.Object({
    type: Type.Literal('workflow.approval'),
    approvalId: Type.String(),
    workflowId: Type.String(),
    stepIndex: Type.Number(),
    action: Type.Union([
      Type.Literal('requested'),
      Type.Literal('approved'),
      Type.Literal('rejected'),
      Type.Literal('expired'),
    ]),
    resolvedBy: Type.Optional(Type.String()),
  }),
])
export type ApprovalEvent = Static<typeof ApprovalEvent>

// ── Union of all events ─────────────────────────
export const GatewayEvent = Type.Union([
  CronFiredEvent,
  WebhookReceivedEvent,
  TaskCreatedEvent,
  TaskDeletedEvent,
  AgentDelegatedEvent,
  AgentCompletedEvent,
  SessionCrashedEvent,
  TurnCompletedEvent,
  ToolCalledEvent,
  MemoryHitEvent,
  VerificationResultEvent,
  CostRecordedEvent,
  WorkflowTransitionedEvent,
  WorkflowStepTransitionedEvent,
  ApprovalEvent,
])
export type GatewayEvent = Static<typeof GatewayEvent>

// ── Event type string union ─────────────────────
export type GatewayEventType = GatewayEvent['type']

export const GATEWAY_EVENT_TYPES = [
  'cron.fired',
  'webhook.received',
  'task.created',
  'task.deleted',
  'agent.delegated',
  'agent.completed',
  'session.crashed',
  'turn.completed',
  'tool.called',
  'memory.hit',
  'verification.result',
  'cost.recorded',
  'workflow.transitioned',
  'workflow.step_transitioned',
  'workflow.approval',
] as const satisfies readonly GatewayEventType[]
