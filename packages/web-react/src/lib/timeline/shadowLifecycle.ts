/**
 * P0 shadow observer. Computes projectTimeline alongside the old merge/reset
 * path, counts identity+text diffs, and never changes the returned messages.
 *
 * Flag: OC_TIMELINE_LIFECYCLE_V1 / window.__OC_TIMELINE_LIFECYCLE_V1 /
 * VITE_OC_TIMELINE_LIFECYCLE_V1 (explicit local override), else the server
 * switch `timelineShadow` (OCV5-630). Default off. Only server-driven shadow
 * sends content-free mismatch summaries to /api/client-errors.
 */
import { type ClientFrictionSignal, reportClientFriction } from "../clientFriction";
import type { ChatMessage } from "../chat/model";
import { identityOf, lifecycleOf, projectTimeline } from "./projectLifecycle";

export type TimelineLifecycleMode = "off" | "shadow" | "read";
export type ShadowEntry = "full" | "incremental" | "live-units" | "durable-frames";

export type ShadowMismatch = {
  identity: string;
  oldKeep: boolean;
  newKeep: boolean;
  oldText?: string;
  newText?: string;
};

export type ShadowObservation = {
  entry: ShadowEntry;
  sessionId?: string;
  mismatchCount: number;
  mismatches: ShadowMismatch[];
  oldMs: number;
  newMs: number;
  diffMs: number;
  totalMs: number;
  sampled: boolean;
};

export type ShadowStats = {
  samples: number;
  byEntry: Record<ShadowEntry, {
    samples: number;
    mismatches: number;
    p95TotalMs: number;
    p95OldMs: number;
    p95NewMs: number;
    p95DiffMs: number;
  }>;
  last?: ShadowObservation;
};

type TimingSample = { entry: ShadowEntry; oldMs: number; newMs: number; diffMs: number; totalMs: number; mismatchCount: number };

const HYDRATE_SAMPLE_RATE = 0.1;
const MAX_SAMPLES = 256;
const timings: TimingSample[] = [];
const mismatchedSessions = new Set<string>();
let lastObservation: ShadowObservation | undefined;
const lastByEntry = new Map<ShadowEntry, ShadowObservation>();

declare global {
  interface Window {
    __OC_TIMELINE_LIFECYCLE_V1?: string;
    __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean;
    __timelineLifecycleShadowStats?: ShadowStats;
    __timelineLifecycleLastShadow?: ShadowObservation;
  }
}

/** Explicit local override (window / process.env / VITE); undefined when none is set. */
function readExplicitMode(): string | undefined {
  if (typeof globalThis !== "undefined") {
    const g = globalThis as typeof globalThis & {
      __OC_TIMELINE_LIFECYCLE_V1?: string;
      process?: { env?: Record<string, string | undefined> };
    };
    if (typeof g.__OC_TIMELINE_LIFECYCLE_V1 === "string") return g.__OC_TIMELINE_LIFECYCLE_V1;
    const env = g.process?.env?.OC_TIMELINE_LIFECYCLE_V1;
    if (typeof env === "string") return env;
  }
  try {
    const vite = (import.meta as { env?: Record<string, string | undefined> }).env;
    if (vite && typeof vite.VITE_OC_TIMELINE_LIFECYCLE_V1 === "string") {
      return vite.VITE_OC_TIMELINE_LIFECYCLE_V1;
    }
  } catch {
    /* import.meta may be unavailable in some test shims */
  }
  return undefined;
}

/**
 * OCV5-630 server switch (GET /api/features `timelineShadow` ← OC_TIMELINE_LIFECYCLE_SHADOW).
 * Only turns on shadow, never read; an explicit local override above still wins (including "off").
 */
let serverShadow = false;

export function setTimelineLifecycleServerShadow(on: boolean): void {
  serverShadow = on === true;
}

function normalizeMode(raw: string): TimelineLifecycleMode {
  const mode = raw.trim().toLowerCase();
  return mode === "shadow" || mode === "read" ? mode : "off";
}

export function timelineLifecycleMode(): TimelineLifecycleMode {
  const explicit = readExplicitMode();
  if (explicit !== undefined) return normalizeMode(explicit);
  return serverShadow ? "shadow" : "off";
}

/** Shadow came from the server switch, not a local override: the only case that reports. */
function serverDrivenShadow(): boolean {
  return readExplicitMode() === undefined && serverShadow;
}

function forceSample(): boolean {
  if (typeof globalThis === "undefined") return false;
  const g = globalThis as typeof globalThis & { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean };
  return g.__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE === true;
}

function shouldSample(entry: ShadowEntry, sessionId?: string): boolean {
  if (timelineLifecycleMode() !== "shadow") return false;
  if (forceSample()) return true;
  if (entry === "full" || entry === "incremental") return true;
  if (sessionId && mismatchedSessions.has(sessionId)) return true;
  return Math.random() < HYDRATE_SAMPLE_RATE;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
}

function fingerprint(row: ChatMessage): string {
  const text = `${row.text || ""}\n${typeof row.output === "string" ? row.output : ""}`;
  const children = Array.isArray(row.childBlocks) ? JSON.stringify(row.childBlocks) : "";
  return `${identityOf(row)}\t${lifecycleOf(row)}\t${text}\t${children}`;
}

function rowText(row: ChatMessage | undefined): string | undefined {
  if (!row) return undefined;
  return (row.text || (typeof row.output === "string" ? row.output : "")).slice(0, 120);
}

export function diffProjected(
  oldOutput: ChatMessage[],
  projected: ChatMessage[],
): ShadowMismatch[] {
  const oldRows = new Map<string, ChatMessage[]>();
  const newRows = new Map<string, ChatMessage[]>();
  for (const row of oldOutput) {
    const id = identityOf(row);
    const list = oldRows.get(id) ?? [];
    list.push(row);
    oldRows.set(id, list);
  }
  for (const row of projected) {
    const id = identityOf(row);
    const list = newRows.get(id) ?? [];
    list.push(row);
    newRows.set(id, list);
  }
  const ids = new Set([...oldRows.keys(), ...newRows.keys()]);
  const mismatches: ShadowMismatch[] = [];
  for (const identity of ids) {
    const oldList = oldRows.get(identity) ?? [];
    const newList = newRows.get(identity) ?? [];
    const oldFp = oldList.map(fingerprint).sort().join("\n");
    const newFp = newList.map(fingerprint).sort().join("\n");
    if (oldFp === newFp) continue;
    mismatches.push({
      identity,
      oldKeep: oldList.length > 0,
      newKeep: newList.length > 0,
      oldText: oldList.map(rowText).filter(Boolean).join("|"),
      newText: newList.map(rowText).filter(Boolean).join("|"),
    });
  }
  return mismatches;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function getShadowStats(): ShadowStats {
  const entries: ShadowEntry[] = ["full", "incremental", "live-units", "durable-frames"];
  const byEntry = {} as ShadowStats["byEntry"];
  for (const entry of entries) {
    const rows = timings.filter((row) => row.entry === entry);
    byEntry[entry] = {
      samples: rows.length,
      mismatches: rows.reduce((sum, row) => sum + row.mismatchCount, 0),
      p95TotalMs: percentile(rows.map((row) => row.totalMs), 95),
      p95OldMs: percentile(rows.map((row) => row.oldMs), 95),
      p95NewMs: percentile(rows.map((row) => row.newMs), 95),
      p95DiffMs: percentile(rows.map((row) => row.diffMs), 95),
    };
  }
  return { samples: timings.length, byEntry, last: lastObservation };
}

function publishStats(observation: ShadowObservation): void {
  lastObservation = observation;
  lastByEntry.set(observation.entry, observation);
  if (typeof globalThis !== "undefined") {
    const g = globalThis as typeof globalThis & {
      __timelineLifecycleShadowStats?: ShadowStats;
      __timelineLifecycleLastShadow?: ShadowObservation;
    };
    g.__timelineLifecycleShadowStats = getShadowStats();
    g.__timelineLifecycleLastShadow = observation;
  }
  if (observation.mismatchCount > 0 && typeof console !== "undefined") {
    console.warn("lifecycle_shadow_mismatch", {
      sessionId: observation.sessionId,
      entry: observation.entry,
      mismatchCount: observation.mismatchCount,
      identities: observation.mismatches.slice(0, 8).map((row) => ({
        identity: row.identity,
        oldKeep: row.oldKeep,
        newKeep: row.newKeep,
      })),
    });
  }
}

export function lastShadowFor(entry: ShadowEntry): ShadowObservation | undefined {
  return lastByEntry.get(entry);
}

// ── OCV5-630 content-free report (only when the server switch turned shadow on) ──
// One bounded product-friction event per sampled observation. client-errors is
// rate limited per IP (30 req/min) and shared with real error reports, so this
// stays far below it whatever the session count: at most one report every
// 30 s per page (≤2/min), at most one per session × entry × outcome per
// 5 minutes, and at most 40 per page. Never identities or text: only the
// entry, the mismatch shape counts and the total time.
const REPORT_WINDOW_MS = 5 * 60_000;
const MIN_REPORT_GAP_MS = 30_000;
const PAGE_REPORT_CAP = 40;
const COUNT_CAP = 9_999;
const lastReportAt = new Map<string, number>();
let lastAnyReportAt: number | undefined;
let pageReports = 0;
let reporter: (signal: ClientFrictionSignal) => void = (signal) => {
  reportClientFriction(signal);
};

export function shadowReportSignal(observation: ShadowObservation): ClientFrictionSignal {
  const mismatch = observation.mismatchCount > 0;
  const cap = (n: number) => Math.min(COUNT_CAP, n);
  const oldOnly = cap(observation.mismatches.filter((row) => row.oldKeep && !row.newKeep).length);
  const newOnly = cap(observation.mismatches.filter((row) => row.newKeep && !row.oldKeep).length);
  const changed = cap(observation.mismatches.filter((row) => row.oldKeep && row.newKeep).length);
  return {
    surface: "chat",
    stage: "timeline_shadow",
    code: mismatch ? "TIMELINE_SHADOW_MISMATCH" : "TIMELINE_SHADOW_MATCH",
    outcome: mismatch ? "failed" : "succeeded",
    latencyMs: Math.max(0, Math.round(observation.totalMs)),
    path: observation.entry.replace(/-/g, "_"),
    reason: mismatch ? `old${oldOnly}_new${newOnly}_diff${changed}` : "none",
    ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
  };
}

function maybeReport(observation: ShadowObservation): void {
  if (!observation.sampled || !serverDrivenShadow()) return;
  const key = `${observation.sessionId ?? "-"}|${observation.entry}|${observation.mismatchCount > 0 ? "m" : "ok"}`;
  const now = Date.now();
  const last = lastReportAt.get(key);
  if (last !== undefined && now - last < REPORT_WINDOW_MS) return;
  if (lastAnyReportAt !== undefined && now - lastAnyReportAt < MIN_REPORT_GAP_MS) return;
  if (pageReports >= PAGE_REPORT_CAP) return;
  lastReportAt.set(key, now);
  lastAnyReportAt = now;
  pageReports += 1;
  try {
    reporter(shadowReportSignal(observation));
  } catch {
    /* telemetry never affects the timeline */
  }
}

export function setShadowReporterForTests(fn: ((signal: ClientFrictionSignal) => void) | null): void {
  reporter = fn ?? ((signal) => {
    reportClientFriction(signal);
  });
}

export function resetShadowStatsForTests(): void {
  timings.length = 0;
  mismatchedSessions.clear();
  lastObservation = undefined;
  lastByEntry.clear();
  lastReportAt.clear();
  lastAnyReportAt = undefined;
  pageReports = 0;
  serverShadow = false;
  setShadowReporterForTests(null);
}

export function observeTimelineShadow(opts: {
  entry: ShadowEntry;
  input: ChatMessage[];
  oldOutput: ChatMessage[];
  sessionId?: string;
  oldMs?: number;
}): ShadowObservation | null {
  if (timelineLifecycleMode() !== "shadow") return null;
  if (!shouldSample(opts.entry, opts.sessionId)) {
    return { ...emptyObservation(opts.entry, opts.sessionId), sampled: false };
  }
  const t0 = nowMs();
  const projected = projectTimeline(opts.input);
  const t1 = nowMs();
  const mismatches = diffProjected(opts.oldOutput, projected);
  const t2 = nowMs();
  const oldMs = opts.oldMs ?? 0;
  const newMs = t1 - t0;
  const diffMs = t2 - t1;
  const observation: ShadowObservation = {
    entry: opts.entry,
    sessionId: opts.sessionId,
    mismatchCount: mismatches.length,
    mismatches,
    oldMs,
    newMs,
    diffMs,
    totalMs: oldMs + newMs + diffMs,
    sampled: true,
  };
  timings.push({
    entry: opts.entry,
    oldMs,
    newMs,
    diffMs,
    totalMs: observation.totalMs,
    mismatchCount: observation.mismatchCount,
  });
  if (timings.length > MAX_SAMPLES) timings.shift();
  if (observation.mismatchCount > 0 && opts.sessionId) mismatchedSessions.add(opts.sessionId);
  publishStats(observation);
  maybeReport(observation);
  return observation;
}

function emptyObservation(entry: ShadowEntry, sessionId?: string): ShadowObservation {
  return {
    entry,
    sessionId,
    mismatchCount: 0,
    mismatches: [],
    oldMs: 0,
    newMs: 0,
    diffMs: 0,
    totalMs: 0,
    sampled: false,
  };
}
