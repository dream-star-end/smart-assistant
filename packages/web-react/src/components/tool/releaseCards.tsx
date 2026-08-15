import { AlertTriangle, Check, ChevronRight, Clock, Rocket, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui";
import type { ToolLike } from "./format";

export const RELEASE_JOB_MARKER = "OC_RELEASE_JOB_V1";
export const RELEASE_JOB_ID_RE = /^rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;

export const RELEASE_PHASE_LABELS = {
  queued: "排队中",
  acquiring_lease: "获取 lease",
  deploying: "部署中",
  smoking: "冒烟中",
  completed: "完成",
  failed: "失败",
  rolled_back: "已回滚",
} as const;

export type ReleasePhase = keyof typeof RELEASE_PHASE_LABELS;

export type ReleaseJobSnapshot = {
  id: string;
  phase: ReleasePhase;
  title: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  nextStep: string | null;
  entries: Array<{ phase: string; text: string }>;
  queueId?: string;
  deployUnit?: string | null;
};

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "rolled_back"]);

export function isReleasePhase(value: unknown): value is ReleasePhase {
  return typeof value === "string" && value in RELEASE_PHASE_LABELS;
}

export function parseReleaseJobOutput(text?: string | null): ReleaseJobSnapshot | null {
  const raw = String(text ?? "");
  const marker = raw.indexOf(RELEASE_JOB_MARKER);
  const body = marker >= 0 ? raw.slice(marker + RELEASE_JOB_MARKER.length).trim() : raw.trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (!RELEASE_JOB_ID_RE.test(String(parsed.id ?? "")) || !isReleasePhase(parsed.phase)) return null;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const row = entry as Record<string, unknown>;
          return [{ phase: String(row.phase ?? ""), text: String(row.text ?? "") }];
        })
      : [];
    return {
      id: String(parsed.id),
      phase: parsed.phase,
      title: String(
        parsed.title
          || (parsed.card && typeof parsed.card === "object"
            ? (parsed.card as { goal?: string }).goal
            : "")
          || "发布任务",
      ),
      createdAt: String(parsed.createdAt ?? parsed.startedAt ?? ""),
      finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep : null,
      entries,
      queueId: typeof parsed.queueId === "string" ? parsed.queueId : undefined,
      deployUnit: typeof parsed.deployUnit === "string" ? parsed.deployUnit : null,
    };
  } catch {
    return null;
  }
}

export function looksLikeReleaseWorkerCommand(command: string): boolean {
  return /v5-release-worker\.sh\b/.test(command);
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export function elapsedMs(job: ReleaseJobSnapshot, now = Date.now()): number {
  const start = Date.parse(job.createdAt);
  if (!Number.isFinite(start)) return 0;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Math.max(0, end - start);
}

function phaseTone(phase: ReleasePhase): "accent" | "success" | "danger" | "warning" {
  if (phase === "failed") return "danger";
  if (phase === "completed") return "success";
  if (phase === "rolled_back") return "warning";
  return "accent";
}

export async function fetchReleaseJob(id: string, fetcher: typeof fetch = fetch): Promise<ReleaseJobSnapshot | null> {
  if (!RELEASE_JOB_ID_RE.test(id)) return null;
  try {
    const res = await fetcher(`/api/v5/release-jobs/${encodeURIComponent(id)}`, { credentials: "include" });
    if (!res.ok) return null;
    return parseReleaseJobOutput(JSON.stringify(await res.json()));
  } catch {
    return null;
  }
}

export function ReleaseProgressCard({
  job,
  poll = true,
  loadJob = fetchReleaseJob,
}: {
  job: ReleaseJobSnapshot;
  poll?: boolean;
  loadJob?: (id: string) => Promise<ReleaseJobSnapshot | null>;
}) {
  const [current, setCurrent] = useState(job);
  const [now, setNow] = useState(Date.now());
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const done = TERMINAL.has(current.phase);
  const collapsed = userCollapsed ?? (done && current.phase !== "failed");

  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [done]);

  useEffect(() => {
    if (!poll || done) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await loadJob(current.id);
        if (!cancelled && next) setCurrent(next);
      } catch {
        // keep the persisted snapshot from the tool output
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [current.id, done, loadJob, poll]);

  const tone = phaseTone(current.phase);
  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          {current.phase === "failed" ? <AlertTriangle size={13} /> : current.phase === "rolled_back" ? <RotateCcw size={13} /> : <Rocket size={13} />}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{current.title || "发布任务"}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-muted">
            <Clock size={11} />
            {formatElapsed(elapsedMs(current, now))}
          </span>
          <Badge tone={tone}>{RELEASE_PHASE_LABELS[current.phase]}</Badge>
          <ChevronRight size={15} className={cn("text-faint transition-transform", !collapsed && "rotate-90")} />
        </span>
      </button>
      {!collapsed && current.entries.length > 0 && (
        <ul className="border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          {current.entries.map((entry, index) => (
            <li key={`${entry.phase}-${index}`} className="whitespace-pre-wrap break-words">
              <span className="text-faint">[{RELEASE_PHASE_LABELS[entry.phase as ReleasePhase] ?? entry.phase}]</span> {entry.text}
            </li>
          ))}
        </ul>
      )}
      {!collapsed && current.phase === "failed" && (
        <div className="space-y-1 border-t border-border px-3.5 py-2 text-[12.5px]">
          <p className="text-danger">{current.error || "发布失败"}</p>
          {current.nextStep && <p className="text-muted">下一步：{current.nextStep}</p>}
        </div>
      )}
      {collapsed && done && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          {current.phase === "failed" ? (
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <Check size={13} className="mt-0.5 shrink-0 text-success" />
          )}
          <span className="line-clamp-2">
            {current.phase === "failed"
              ? current.error || "发布失败"
              : current.phase === "rolled_back"
                ? "已按官方路径回滚"
                : "发布完成"}
          </span>
        </div>
      )}
    </div>
  );
}

export function renderReleaseJobCard(command: string, tool: ToolLike) {
  const fromOutput = parseReleaseJobOutput(typeof tool.output === "string" ? tool.output : "");
  if (fromOutput) return <ReleaseProgressCard job={fromOutput} />;
  if (looksLikeReleaseWorkerCommand(command) && tool.error) {
    return (
      <div className="rounded-lg border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[12.5px] text-danger">
        发布任务未能启动。不要改走旁路；先读报错再查 queue / lease。
      </div>
    );
  }
  return null;
}
