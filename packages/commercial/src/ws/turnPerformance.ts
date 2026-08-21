import type { Pool } from "pg";

import { controlPlaneIdentity } from "../admin/observabilityIdentity.js";

export type FirstVisibleKind = "thinking" | "text" | "tool" | "agent" | "other";

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

export function recordTurnFirstVisible(
  pool: Pool | undefined,
  warn: ((message: string, fields?: Record<string, unknown>) => void) | undefined,
  input: { traceId: string; kind: FirstVisibleKind },
): void {
  if (!pool || !/^[0-9a-f]{32}$/.test(input.traceId)) return;
  const attempt = async (remaining: number): Promise<void> => {
    try {
      const result = await pool.query(
        `UPDATE turn_traces
            SET first_visible_at=COALESCE(first_visible_at,NOW()),
                first_visible_kind=COALESCE(first_visible_kind,$2)
          WHERE trace_id=$1`,
        [input.traceId, input.kind],
      );
      if ((result.rowCount ?? 0) > 0 || remaining <= 0) return;
      const timer = setTimeout(() => { void attempt(remaining - 1); }, remaining === 2 ? 50 : 250);
      timer.unref?.();
    } catch (err) {
      warn?.("turn first-visible record failed", { err: String(err) });
    }
  };
  void attempt(2);
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
