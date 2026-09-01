import type { Pool } from "pg";

import { controlPlaneIdentity } from "../admin/observabilityIdentity.js";
import type { QueryRunner } from "../db/queries.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";

export type FirstVisibleKind = "thinking" | "text" | "tool" | "agent" | "other";
export type ResponseMilestoneKind = "thinking" | "text";

export type ResponseVisibilityMilestones = {
  traceId: string;
  sessionId: string | null;
  hasThinking: boolean;
  hasText: boolean;
  isFinal: boolean;
};

/** Per-turn response milestones. Unlike first-visible, thinking and text are
 * independent clocks: a plan/tool frame must not prevent either from being recorded. */
export function extractResponseVisibilityMilestones(raw: unknown): ResponseVisibilityMilestones | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const frame = raw as {
    type?: unknown;
    traceId?: unknown;
    peer?: unknown;
    blocks?: unknown;
    isFinal?: unknown;
  };
  const traceId = String(frame.traceId ?? "");
  if (frame.type !== "outbound.message" || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  let hasThinking = false;
  let hasText = false;
  if (Array.isArray(frame.blocks)) {
    for (const block of frame.blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const typed = block as { kind?: unknown; text?: unknown };
      if (typeof typed.text !== "string" || typed.text.trim().length === 0) continue;
      if (typed.kind === "thinking") hasThinking = true;
      if (typed.kind === "text") hasText = true;
    }
  }
  const peer = frame.peer && typeof frame.peer === "object" && !Array.isArray(frame.peer)
    ? frame.peer as { id?: unknown }
    : null;
  const sessionId = typeof peer?.id === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(peer.id)
    ? peer.id
    : null;
  return { traceId, sessionId, hasThinking, hasText, isFinal: frame.isFinal === true };
}

type ResponseMilestoneStart = {
  startedAtMs: number;
  sessionId: string;
  model: string | null;
  userId: bigint;
  seen: Partial<Record<ResponseMilestoneKind, true>>;
};

export function recordTurnResponseMilestone(
  pool: Pool | undefined,
  warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined,
  input: {
    traceId: string;
    sessionId: string;
    model: string | null;
    userId: bigint;
    kind: ResponseMilestoneKind;
    latencyMs: number;
  },
): void {
  if (
    !pool ||
    !/^[0-9a-f]{32}$/.test(input.traceId) ||
    !/^[A-Za-z0-9_-]{1,96}$/.test(input.sessionId)
  ) return;
  const stage = input.kind === "thinking" ? "first_thinking_frame" : "first_text_frame";
  const code = input.kind === "thinking" ? "FIRST_THINKING_FRAME" : "FIRST_TEXT_FRAME";
  void recordProductFrictionEvent({
    correlation: input.traceId,
    userId: input.userId,
    surface: "webchat",
    stage,
    code,
    outcome: "succeeded",
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    model: input.model,
    traceId: input.traceId,
    sessionId: input.sessionId,
  }, pool as unknown as QueryRunner).catch((err) => {
    warn?.("turn response milestone record failed", { kind: input.kind, err: String(err) });
  });
}

/** Connection-local bounded tracker. Starts are created only from trusted
 * inbound turns, so outbound fan-out to other tabs cannot forge a latency. */
export class TurnResponseMilestoneTracker {
  private readonly starts = new Map<string, ResponseMilestoneStart>();

  constructor(private readonly maxEntries = 512) {}

  begin(input: {
    traceId: string;
    sessionId: string;
    model: string | null;
    userId: bigint;
    startedAtMs: number;
  }): void {
    if (
      !/^[0-9a-f]{32}$/.test(input.traceId) ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(input.sessionId) ||
      !Number.isFinite(input.startedAtMs)
    ) return;
    if (!this.starts.has(input.traceId) && this.starts.size >= this.maxEntries) {
      const oldest = this.starts.keys().next().value as string | undefined;
      if (oldest) this.starts.delete(oldest);
    }
    this.starts.set(input.traceId, {
      startedAtMs: input.startedAtMs,
      sessionId: input.sessionId,
      model: input.model,
      userId: input.userId,
      seen: {},
    });
  }

  observe(
    raw: unknown,
    pool: Pool | undefined,
    warn?: (message: string, fields?: Record<string, unknown>) => void,
    observedAtMs = Date.now(),
  ): void {
    const milestones = extractResponseVisibilityMilestones(raw);
    if (!milestones) return;
    const start = this.starts.get(milestones.traceId);
    if (!start) return;
    if (milestones.sessionId !== start.sessionId) return;
    const record = (kind: ResponseMilestoneKind): void => {
      if (start.seen[kind]) return;
      start.seen[kind] = true;
      recordTurnResponseMilestone(pool, warn, {
        traceId: milestones.traceId,
        sessionId: start.sessionId,
        model: start.model,
        userId: start.userId,
        kind,
        latencyMs: observedAtMs - start.startedAtMs,
      });
    };
    if (milestones.hasThinking) record("thinking");
    if (milestones.hasText) record("text");
    // A final-only text/thinking frame is recorded before the start is released.
    if (milestones.isFinal) this.starts.delete(milestones.traceId);
  }
}


export function extractFirstVisibleAttribution(
  raw: unknown,
): { traceId: string; kind: FirstVisibleKind } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const frame = raw as { type?: unknown; traceId?: unknown; blocks?: unknown };
  if (frame.type !== "outbound.message" || !/^[0-9a-f]{32}$/.test(String(frame.traceId ?? ""))) {
    return null;
  }
  if (!Array.isArray(frame.blocks) || frame.blocks.length === 0) return null;
  let kind: FirstVisibleKind = "other";
  for (const block of frame.blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const typed = block as { kind?: unknown; text?: unknown };
    const value = typed.kind;
    const hasText = typeof typed.text === "string" && typed.text.trim().length > 0;
    if (value === "text" && hasText) { kind = "text"; break; }
    if (value === "thinking" && hasText) kind = kind === "other" ? "thinking" : kind;
    else if (value === "tool_use" || value === "tool_result" || value === "tool_output_tail") {
      kind = "tool";
    } else if (value === "plan" || value === "goal" || value === "delegate_progress") {
      kind = "agent";
    } else if (typeof value === "string" && value.includes("agent")) kind = "agent";
  }
  if (kind === "other") return null;
  return { traceId: String(frame.traceId), kind };
}

export const TURN_FIRST_VISIBLE_RETRY_DELAYS_MS = [0, 50, 250] as const;
export const FIRST_VISIBLE_PERSIST_MAX_ROUNDS = 3;

/**
 * Bridge-side gate so a failed first_visible write is not permanently
 * suppressed. A trace is marked persisted only after UPDATE succeeds.
 * Inflight coalesces frames during one 3-attempt round; maxRounds caps
 * later-frame retries so a dead PG is not hit on every visible token.
 */
export class FirstVisiblePersistGate {
  private readonly persisted = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly failedRounds = new Map<string, number>();

  constructor(
    private readonly maxEntries = 512,
    private readonly maxRounds = FIRST_VISIBLE_PERSIST_MAX_ROUNDS,
  ) {}

  /** True iff this frame should start a persist round. */
  begin(traceId: string): boolean {
    if (this.persisted.has(traceId) || this.inflight.has(traceId)) return false;
    // Per bridge generation, 9 attempts (maxRounds=3 x 3). Reconnect / failedRounds
    // eviction re-grants budget on purpose so a recovered PG can still persist.
    if ((this.failedRounds.get(traceId) ?? 0) >= this.maxRounds) return false;
    this.inflight.add(traceId);
    return true;
  }

  settle(traceId: string, ok: boolean): void {
    this.inflight.delete(traceId);
    if (ok) {
      if (this.persisted.size >= this.maxEntries) this.persisted.clear();
      this.persisted.add(traceId);
      this.failedRounds.delete(traceId);
      return;
    }
    this.failedRounds.set(traceId, (this.failedRounds.get(traceId) ?? 0) + 1);
    if (this.failedRounds.size > this.maxEntries) {
      const oldest = this.failedRounds.keys().next().value;
      if (oldest) this.failedRounds.delete(oldest);
    }
  }
}

export function recordTurnFirstVisible(
  pool: Pool | undefined,
  warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined,
  input: { traceId: string; kind: FirstVisibleKind; dispatchId?: string | null },
  onSettled?: (ok: boolean) => void,
): void {
  if (!pool || !/^[0-9a-f]{32}$/.test(input.traceId)) {
    onSettled?.(false);
    return;
  }
  const dispatchId =
    typeof input.dispatchId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.dispatchId)
      ? input.dispatchId
      : null;
  const delays = TURN_FIRST_VISIBLE_RETRY_DELAYS_MS;
  const attempt = (index: number): void => {
    void pool
      .query(
        dispatchId
          ? `UPDATE turn_traces
                SET first_visible_at=COALESCE(first_visible_at,NOW()),
                    first_visible_kind=COALESCE(first_visible_kind,$2),
                    dispatch_id=COALESCE(dispatch_id,$3::uuid)
              WHERE trace_id=$1`
          : `UPDATE turn_traces
                SET first_visible_at=COALESCE(first_visible_at,NOW()),
                    first_visible_kind=COALESCE(first_visible_kind,$2)
              WHERE trace_id=$1`,
        dispatchId ? [input.traceId, input.kind, dispatchId] : [input.traceId, input.kind],
      )
      .then((result) => {
        if ((result.rowCount ?? 0) > 0) {
          onSettled?.(true);
          return;
        }
        scheduleRetry(index, undefined);
      })
      .catch((err) => {
        scheduleRetry(index, err);
      });
  };
  const scheduleRetry = (index: number, err: unknown | undefined): void => {
    const next = index + 1;
    if (next >= delays.length) {
      warn?.("turn first-visible record failed", {
        err: err !== undefined ? String(err) : "missed",
        traceId: input.traceId,
        attempts: next,
      });
      onSettled?.(false);
      return;
    }
    const timer = setTimeout(() => attempt(next), delays[next]);
    timer.unref?.();
  };
  attempt(0);
}

export function recordUpstreamPerformance(
  pool: Pool | undefined,
  warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined,
  input: {
    requestId: string;
    userId: bigint;
    model: string;
    ttftMs: number | null;
    streamMs: number | null;
    outcome: "success" | "error" | "aborted";
  },
): void {
  if (!pool) return;
  const version = controlPlaneIdentity();
  const ttftMs = input.ttftMs === null ? null : Math.max(0, Math.trunc(input.ttftMs));
  const streamMs = input.streamMs === null ? null : Math.max(0, Math.trunc(input.streamMs));
  void pool.query(
    `INSERT INTO turn_upstream_performance
       (request_id,user_id,dispatch_id,model,ttft_ms,stream_ms,outcome,
        control_plane_release,control_plane_commit,observed_at)
     SELECT $1,$2,j.dispatch_id,$3,$4,$5,$6,$7,$8,NOW()
       FROM request_finalize_journal j
      WHERE j.request_id=$1 AND j.user_id=$2
     ON CONFLICT (request_id) DO UPDATE SET
       dispatch_id=COALESCE(turn_upstream_performance.dispatch_id,EXCLUDED.dispatch_id),
       model=EXCLUDED.model,
       ttft_ms=EXCLUDED.ttft_ms,
       stream_ms=EXCLUDED.stream_ms,
       outcome=EXCLUDED.outcome,
       control_plane_release=EXCLUDED.control_plane_release,
       control_plane_commit=EXCLUDED.control_plane_commit,
       observed_at=EXCLUDED.observed_at`,
    [
      input.requestId,
      input.userId.toString(),
      input.model.slice(0, 128),
      ttftMs,
      streamMs,
      input.outcome,
      version.release,
      version.commit,
    ],
  ).catch((err) => warn?.("turn upstream performance record failed", { err: String(err) }));
}
