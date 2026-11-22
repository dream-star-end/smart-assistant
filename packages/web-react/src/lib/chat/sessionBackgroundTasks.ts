/**
 * 会话相关后台任务协议层（OCV5-844）：
 *
 * - GET /api/sessions/:id/background-tasks → { delegates, museJobs, bgCommands }（404 静默降级）
 * - POST /api/sessions/:id/inflight-delegates/:jobId/cancel
 * - POST /api/sessions/:id/muse-jobs/:jobId/cancel
 * - POST /api/sessions/:id/bg-commands/:jobId/cancel
 * - POST /api/media-generation/jobs/:jobId/cancel
 * - GET /api/cron + PUT/DELETE /api/cron/:id（过滤出绑定当前会话的 origin-session 定时续跑）
 */
import type { MediaGenerationJob } from "@openclaude/protocol/mediaGeneration";
import { bearerHeaders, callWithRefresh } from "../api";
import type { AuthSession } from "../types";
import {
  normalizeInflightDelegateItem,
  type InflightDelegateItem,
} from "./inflightDelegates";

export type SessionMuseJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SessionMuseJobItem = {
  id: string;
  kind: "image" | "video";
  status: SessionMuseJobStatus;
  promptPreview: string;
  queuePosition?: number;
  queueLength?: number;
  queuedAt: number;
  startedAt?: number;
  errorCode?: string;
};

export type SessionBgCommandItem = {
  id: string;
  jobId: string;
  commandPreview: string;
  cwd?: string;
  startedAt: number;
  updatedAt: number;
};

export type SessionCronItem = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  nextRunAt: number | null;
  oneshot?: boolean;
  prompt?: string;
  resume: "origin-session";
  sourceSessionKey: string;
};

export type SessionBackgroundTasksSnapshot = {
  delegates: InflightDelegateItem[];
  museJobs: SessionMuseJobItem[];
  bgCommands: SessionBgCommandItem[];
};

export type SessionBackgroundTasksFetchResult =
  | { ok: true; snapshot: SessionBackgroundTasksSnapshot }
  | { ok: false; notFound: boolean };

const MUSE_STATUS_SET = new Set<string>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalMuseJobStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function isTerminalMediaJobStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function firstLinePreview(text: string): string {
  const nl = text.search(/\r|\n/);
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

export function formatCompactElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

export function formatCountdown(nextRunAt: number | null | undefined, now = Date.now()): string {
  if (nextRunAt == null || !Number.isFinite(nextRunAt)) return "";
  const diffMs = nextRunAt - now;
  if (diffMs <= 30_000) return "即将触发";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours} 小时 ${remMins} 分后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  return `${days} 天后`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function sessionIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (typeof sessionKey !== "string") return null;
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  const idx = trimmed.lastIndexOf(":");
  const tail = idx >= 0 ? trimmed.slice(idx + 1).trim() : trimmed;
  return tail || null;
}

export function normalizeSessionMuseJobItem(raw: unknown): SessionMuseJobItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (typeof o.id !== "string" || !o.id) return null;
  if (o.kind !== "image" && o.kind !== "video") return null;
  if (typeof o.status !== "string" || !MUSE_STATUS_SET.has(o.status)) return null;
  const queuedAt = parseTimestampMs(o.queuedAt) ?? 0;
  const startedAt = parseTimestampMs(o.startedAt) ?? undefined;
  const item: SessionMuseJobItem = {
    id: o.id,
    kind: o.kind,
    status: o.status as SessionMuseJobStatus,
    promptPreview: typeof o.promptPreview === "string" ? o.promptPreview : "",
    queuedAt,
  };
  if (typeof o.queuePosition === "number" && Number.isFinite(o.queuePosition)) {
    item.queuePosition = o.queuePosition;
  }
  if (typeof o.queueLength === "number" && Number.isFinite(o.queueLength)) {
    item.queueLength = o.queueLength;
  }
  if (startedAt !== undefined) item.startedAt = startedAt;
  if (typeof o.errorCode === "string" && o.errorCode) item.errorCode = o.errorCode;
  return item;
}

export function normalizeSessionBgCommandItem(raw: unknown): SessionBgCommandItem | null {
  const o = asRecord(raw);
  if (!o) return null;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.jobId !== "string" || !o.jobId) return null;
  const startedAt = parseTimestampMs(o.startedAt) ?? 0;
  const updatedAt = parseTimestampMs(o.updatedAt) ?? startedAt;
  const item: SessionBgCommandItem = {
    id: o.id,
    jobId: o.jobId,
    commandPreview: typeof o.commandPreview === "string" ? o.commandPreview : "",
    startedAt,
    updatedAt,
  };
  if (typeof o.cwd === "string" && o.cwd) item.cwd = o.cwd;
  return item;
}

export function filterSessionOriginCrons(
  rawJobs: readonly unknown[],
  sessionId: string,
): SessionCronItem[] {
  if (!sessionId) return [];
  const out: SessionCronItem[] = [];
  for (const raw of rawJobs) {
    const o = asRecord(raw);
    if (!o) continue;
    if (typeof o.id !== "string" || !o.id) continue;
    if (o.resume !== "origin-session") continue;
    const sourceKey =
      typeof o.sourceSessionKey === "string"
        ? o.sourceSessionKey
        : typeof o.originSessionKey === "string"
          ? o.originSessionKey
          : "";
    if (sessionIdFromSessionKey(sourceKey) !== sessionId) continue;

    const enabled = o.enabled !== false;
    const oneshot = o.oneshot === true;
    const nextRunAt = parseTimestampMs(o.nextRunAt);
    const lastRunAt = parseTimestampMs(o.lastRunAt);
    // 已触发完成的一次性续跑不再常驻胶囊
    if (oneshot && !enabled && nextRunAt === null && lastRunAt !== null) continue;

    const rawName =
      (typeof o.name === "string" && o.name.trim()) ||
      (typeof o.label === "string" && o.label.trim()) ||
      (typeof o.prompt === "string" && firstLinePreview(o.prompt)) ||
      "定时续跑";

    out.push({
      id: o.id,
      name: firstLinePreview(rawName) || "定时续跑",
      enabled,
      schedule: typeof o.schedule === "string" ? o.schedule : "",
      nextRunAt,
      oneshot,
      prompt: typeof o.prompt === "string" ? o.prompt : undefined,
      resume: "origin-session",
      sourceSessionKey: sourceKey,
    });
  }

  out.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (a.nextRunAt !== null && b.nextRunAt !== null) return a.nextRunAt - b.nextRunAt;
    if (a.nextRunAt !== null) return -1;
    if (b.nextRunAt !== null) return 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export function filterSessionMediaJobs(
  jobs: Iterable<MediaGenerationJob>,
  sessionId: string | null,
  opts: {
    dismissed: ReadonlySet<string>;
    seenLive: ReadonlySet<string>;
    now: number;
    recencyMs: number;
  },
): MediaGenerationJob[] {
  if (!sessionId) return [];
  const out: MediaGenerationJob[] = [];
  for (const job of jobs) {
    if (job.sessionId !== sessionId) continue;
    const terminal = isTerminalMediaJobStatus(job.status);
    if (terminal) {
      if (opts.dismissed.has(job.id)) continue;
      const updatedMs = parseTimestampMs(job.updatedAt) ?? parseTimestampMs(job.createdAt) ?? 0;
      if (!opts.seenLive.has(job.id) && (updatedMs <= 0 || opts.now - updatedMs > opts.recencyMs)) {
        continue;
      }
    }
    out.push(job);
  }
  out.sort((a, b) => {
    const at = isTerminalMediaJobStatus(a.status);
    const bt = isTerminalMediaJobStatus(b.status);
    if (at !== bt) return at ? 1 : -1;
    return (parseTimestampMs(b.updatedAt) ?? 0) - (parseTimestampMs(a.updatedAt) ?? 0);
  });
  return out;
}

const DISMISSED_MUSE_PREFIX = "oc_bg_muse_dismissed:";
const DISMISSED_STORAGE_CAP = 64;

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readDismissedBgMedia(
  sessionId: string | null,
  storage: Pick<Storage, "getItem"> | null = safeSessionStorage(),
): Set<string> {
  if (!sessionId || !storage) return new Set();
  try {
    const raw = storage.getItem(`${DISMISSED_MUSE_PREFIX}${sessionId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0));
  } catch {
    return new Set();
  }
}

export function writeDismissedBgMedia(
  sessionId: string | null,
  dismissed: ReadonlySet<string>,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeSessionStorage(),
): void {
  if (!sessionId || !storage) return;
  try {
    const key = `${DISMISSED_MUSE_PREFIX}${sessionId}`;
    if (dismissed.size === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify([...dismissed].slice(-DISMISSED_STORAGE_CAP)));
  } catch {
    // 隐私模式 / 配额不可用时静默退化为仅内存
  }
}

export async function fetchSessionBackgroundTasksResult(
  sessionId: string,
  auth: AuthSession,
): Promise<SessionBackgroundTasksFetchResult> {
  if (!sessionId) return { ok: false, notFound: false };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/background-tasks`, {
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    );
    if (res.status === 404) return { ok: false, notFound: true };
    if (res.status !== 200) return { ok: false, notFound: false };
    const body = asRecord(await res.json());
    const rawDelegates = body && Array.isArray(body.delegates) ? body.delegates : [];
    const rawMuse = body && Array.isArray(body.museJobs) ? body.museJobs : [];
    const rawCmds = body && Array.isArray(body.bgCommands) ? body.bgCommands : [];

    const delegates: InflightDelegateItem[] = [];
    for (const raw of rawDelegates) {
      const item = normalizeInflightDelegateItem(raw);
      if (item) delegates.push(item);
    }
    const museJobs: SessionMuseJobItem[] = [];
    for (const raw of rawMuse) {
      const item = normalizeSessionMuseJobItem(raw);
      if (item) museJobs.push(item);
    }
    const bgCommands: SessionBgCommandItem[] = [];
    for (const raw of rawCmds) {
      const item = normalizeSessionBgCommandItem(raw);
      if (item) bgCommands.push(item);
    }
    return { ok: true, snapshot: { delegates, museJobs, bgCommands } };
  } catch {
    return { ok: false, notFound: false };
  }
}

export async function cancelInflightDelegate(
  sessionId: string,
  jobId: string,
  auth: AuthSession,
): Promise<{ ok: boolean; cancelled: boolean; state?: string }> {
  if (!sessionId || !jobId) return { ok: false, cancelled: false };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/inflight-delegates/${encodeURIComponent(jobId)}/cancel`,
        {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        },
      ),
    );
    if (!res.ok) return { ok: false, cancelled: false };
    const body = asRecord(await res.json().catch(() => null));
    return {
      ok: body?.ok !== false,
      cancelled: body?.cancelled === true,
      state: typeof body?.state === "string" ? body.state : undefined,
    };
  } catch {
    return { ok: false, cancelled: false };
  }
}

export async function cancelSessionMuseJob(
  sessionId: string,
  jobId: string,
  auth: AuthSession,
): Promise<{ ok: boolean; cancelled: boolean; status?: string }> {
  if (!sessionId || !jobId) return { ok: false, cancelled: false };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/muse-jobs/${encodeURIComponent(jobId)}/cancel`,
        {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        },
      ),
    );
    if (!res.ok) return { ok: false, cancelled: false };
    const body = asRecord(await res.json().catch(() => null));
    return {
      ok: body?.ok !== false,
      cancelled: body?.cancelled === true,
      status: typeof body?.status === "string" ? body.status : undefined,
    };
  } catch {
    return { ok: false, cancelled: false };
  }
}

export async function cancelSessionBgCommand(
  sessionId: string,
  entryId: string,
  auth: AuthSession,
): Promise<{ ok: boolean; cancelled: boolean; alreadyExited?: boolean }> {
  if (!sessionId || !entryId) return { ok: false, cancelled: false };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/bg-commands/${encodeURIComponent(entryId)}/cancel`,
        {
          method: "POST",
          credentials: "include",
          headers: bearerHeaders(t),
        },
      ),
    );
    if (!res.ok) return { ok: false, cancelled: false };
    const body = asRecord(await res.json().catch(() => null));
    return {
      ok: body?.ok !== false,
      cancelled: body?.cancelled === true,
      alreadyExited: body?.alreadyExited === true,
    };
  } catch {
    return { ok: false, cancelled: false };
  }
}

export async function cancelMediaGenerationJob(
  jobId: string,
  auth: AuthSession,
): Promise<boolean> {
  if (!jobId) return false;
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(`/api/media-generation/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSessionOriginCrons(
  sessionId: string,
  auth: AuthSession,
): Promise<{ ok: boolean; items: SessionCronItem[] }> {
  if (!sessionId) return { ok: false, items: [] };
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch("/api/cron", {
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    );
    if (!res.ok) return { ok: false, items: [] };
    const body = asRecord(await res.json().catch(() => null));
    const jobs = body && Array.isArray(body.jobs) ? body.jobs : [];
    return { ok: true, items: filterSessionOriginCrons(jobs, sessionId) };
  } catch {
    return { ok: false, items: [] };
  }
}

export async function updateSessionCronEnabled(
  cronId: string,
  enabled: boolean,
  auth: AuthSession,
): Promise<boolean> {
  if (!cronId) return false;
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(`/api/cron/${encodeURIComponent(cronId)}`, {
        method: "PUT",
        credentials: "include",
        headers: bearerHeaders(t, true),
        body: JSON.stringify({ enabled }),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteSessionCronJob(
  cronId: string,
  auth: AuthSession,
): Promise<boolean> {
  if (!cronId) return false;
  try {
    const res = await callWithRefresh(auth, (t) =>
      fetch(`/api/cron/${encodeURIComponent(cronId)}`, {
        method: "DELETE",
        credentials: "include",
        headers: bearerHeaders(t),
      }),
    );
    return res.ok;
  } catch {
    return false;
  }
}
