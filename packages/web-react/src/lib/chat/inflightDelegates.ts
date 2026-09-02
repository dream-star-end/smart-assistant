/**
 * Parent-session inflight delegate snapshot (GET /api/sessions/:id/inflight-delegates).
 *
 * Protocol `InflightDelegateSurface` is the wire read model. This module normalizes
 * it for the composer HUD and merges HTTP snapshots with the live timeline so a
 * refresh that dropped the process tree still shows running background jobs.
 */
import {
  DELEGATE_JOB_STATES,
  isDelegateTerminalState,
  type DelegateJobState,
  type InflightDelegateSurface,
} from "@openclaude/protocol";
import { bearerHeaders, callWithRefresh } from "../api";
import type { AuthSession } from "../types";
import { agentGroupRunId, type ChatMessage } from "./model";

const STATE_SET = new Set<string>(DELEGATE_JOB_STATES);

export type InflightDelegateItem = Pick<
  InflightDelegateSurface,
  "jobId" | "runId" | "agentId" | "goal" | "state" | "liveHint" | "updatedAt" | "parentSessionKey"
> & {
  /** Normalized from `foldedGroup.resultSummary` (not a top-level wire field). */
  resultSummary?: string;
  nested?: boolean;
  ownerRunId?: string;
};

export type InflightDelegatesFetchResult =
  | { ok: true; items: InflightDelegateItem[] }
  | { ok: false; notFound: boolean };

export function isTerminalDelegateState(state: string): boolean {
  return isDelegateTerminalState(state);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickResultSummary(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.resultSummary === "string" && raw.resultSummary) return raw.resultSummary;
  const folded = asRecord(raw.foldedGroup);
  if (folded && typeof folded.resultSummary === "string" && folded.resultSummary) {
    return folded.resultSummary;
  }
  return undefined;
}

export function normalizeInflightDelegateItem(raw: unknown): InflightDelegateItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (typeof o.jobId !== "string" || !o.jobId) return null;
  if (typeof o.runId !== "string" || !o.runId) return null;
  if (typeof o.agentId !== "string") return null;
  if (typeof o.goal !== "string") return null;
  if (typeof o.state !== "string" || !STATE_SET.has(o.state)) return null;
  const updatedAt =
    typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0;
  const resultSummary = pickResultSummary(o);
  const item: InflightDelegateItem = {
    jobId: o.jobId,
    runId: o.runId,
    agentId: o.agentId,
    goal: o.goal,
    state: o.state as DelegateJobState,
    liveHint: typeof o.liveHint === "string" ? o.liveHint : "",
    updatedAt,
    parentSessionKey: typeof o.parentSessionKey === "string" ? o.parentSessionKey : "",
  };
  if (resultSummary) item.resultSummary = resultSummary;
  if (o.nested === true) item.nested = true;
  if (typeof o.ownerRunId === "string" && o.ownerRunId) item.ownerRunId = o.ownerRunId;
  return item;
}

function timelineTerminalState(m: ChatMessage): DelegateJobState | null {
  if (m.role !== "agent-group") return null;
  if (!m._completed) return null;
  if (m._delegateStatus === "failed" || m._delegateStatus === "timeout" || m._isError)
    return "failed";
  return "completed";
}

function timelineResultSummary(m: ChatMessage): string | undefined {
  if (typeof m._resultPreview === "string" && m._resultPreview) return m._resultPreview;
  if (typeof m.summary === "string" && m.summary) return m.summary;
  return undefined;
}

/**
 * HTTP snapshot ∪ current timeline agent-group rows, keyed by runId.
 * A terminal timeline group wins (the card already folded); HTTP `running`
 * with no matching group still displays (refresh emptied the process tree).
 */
export function mergeInflightWithTimeline(
  items: InflightDelegateItem[],
  messages: ChatMessage[],
): InflightDelegateItem[] {
  const byRunId = new Map<string, ChatMessage>();
  const byJobId = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role !== "agent-group") continue;
    const rid = agentGroupRunId(m);
    if (rid) byRunId.set(rid, m);
    if (typeof m._delegateJobId === "string" && m._delegateJobId) {
      byJobId.set(m._delegateJobId, m);
    }
  }
  return items.map((item) => {
    const group = byRunId.get(item.runId) ?? byJobId.get(item.jobId);
    if (!group) return item;
    const terminal = timelineTerminalState(group);
    if (!terminal) return item;
    const summary = timelineResultSummary(group) ?? item.resultSummary;
    const updatedAt =
      typeof group.completedAt === "number" && group.completedAt > 0
        ? group.completedAt
        : typeof group.ts === "number" && group.ts > 0
          ? group.ts
          : item.updatedAt;
    const next: InflightDelegateItem = { ...item, state: terminal, updatedAt };
    if (summary) next.resultSummary = summary;
    return next;
  });
}

export async function fetchInflightDelegatesResult(
  sessionId: string,
  auth: AuthSession,
): Promise<InflightDelegatesFetchResult> {
  if (!sessionId) return { ok: false, notFound: false };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/inflight-delegates?limit=20`, {
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    );
    if (res.status === 404) return { ok: false, notFound: true };
    if (res.status !== 200) return { ok: false, notFound: false };
    const body = (await res.json()) as unknown;
    const rec = asRecord(body);
    const rawItems = rec && Array.isArray(rec.items) ? rec.items : [];
    const items: InflightDelegateItem[] = [];
    for (const raw of rawItems) {
      const item = normalizeInflightDelegateItem(raw);
      if (item) items.push(item);
    }
    return { ok: true, items };
  } catch {
    return { ok: false, notFound: false };
  }
}

/** 404 / non-200 / network error → null (silent). 200 → items (possibly empty). */
export async function fetchInflightDelegates(
  sessionId: string,
  auth: AuthSession,
): Promise<InflightDelegateItem[] | null> {
  const result = await fetchInflightDelegatesResult(sessionId, auth);
  return result.ok ? result.items : null;
}
