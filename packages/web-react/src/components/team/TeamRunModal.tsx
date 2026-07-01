import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, CheckCircle2, Loader2, Play, RotateCcw, Square, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AGENTS } from "../../lib/agents";
import { api } from "../../lib/api";
import type { AuthSession, TeamDelegation, TeamRun, TeamRunStatus } from "../../lib/types";
import { Alert, Button, Spinner } from "../ui";

// finalize_required = 队长 turn 已结束但未 submit_team_final，前端无动作可推进它，
// 不纳入 active（否则永久空转轮询）；到达即停轮询并显示告警（Codex 审）。
const ACTIVE_STATUSES = new Set<TeamRunStatus>([
  "pending",
  "running",
  "waiting_review",
  "finalizing",
]);

function agentName(id: string): string {
  return AGENTS.find((a) => a.id === id)?.name ?? id;
}

const RUN_STATUS_LABEL: Record<TeamRunStatus, string> = {
  pending: "准备中",
  running: "运行中",
  waiting_review: "等待复核",
  finalize_required: "待提交最终答案",
  finalizing: "收尾中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function runStatusCls(s: TeamRunStatus): string {
  if (s === "completed") return "bg-success-soft text-success";
  if (s === "failed" || s === "interrupted") return "bg-danger-soft text-danger";
  if (s === "waiting_review" || s === "finalize_required") return "bg-accent-soft text-accent";
  return "bg-accent-soft text-accent";
}

function fmtDuration(start?: number | null, end?: number | null): string {
  if (!start) return "";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * 发起并观察一次团队运行。两阶段：
 *  ① 未发起 → 输入目标 → api.createTeamRun。
 *  ② 已发起 → 轮询 api.getTeamRun 读 run + delegations 账本（durable 真相源，
 *     不依赖聊天 transcript；与后端"可观测性走 run 表"的架构一致）。
 */
export function TeamRunModal({
  open,
  auth,
  teamId,
  teamName,
  originPeerId,
  onClose,
}: {
  open: boolean;
  auth: AuthSession | null;
  teamId: string | null;
  teamName?: string;
  /** 发起用户会话的 peerId（origin 路由；队长输出直播回该连接，账本走轮询不依赖它）。 */
  originPeerId?: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-float focus:outline-none data-[state=open]:animate-in"
        >
          <div className="flex items-center justify-between px-5 py-4">
            <Dialog.Title className="text-[15px] font-semibold text-fg">
              团队运行{teamName ? ` · ${teamName}` : ""}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="关闭"
                className="flex size-8 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            {!auth || !teamId ? (
              <p className="py-10 text-center text-[13px] text-faint">请先登录并选择团队。</p>
            ) : (
              <TeamRunBody key={teamId} auth={auth} teamId={teamId} originPeerId={originPeerId} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TeamRunBody({
  auth,
  teamId,
  originPeerId,
}: {
  auth: AuthSession;
  teamId: string;
  originPeerId?: string;
}) {
  const [goal, setGoal] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [parentRunId, setParentRunId] = useState<string | undefined>(undefined);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const launch = useCallback(async () => {
    setErr(null);
    if (!goal.trim()) return setErr("请填写团队要完成的目标");
    setLaunching(true);
    try {
      const res = await api.createTeamRun(auth, teamId, {
        goal: goal.trim(),
        origin: { channel: "webchat", peerId: originPeerId || "web-team-run", peerKind: "dm" },
        ...(parentRunId ? { parentRunId } : {}),
      });
      setRunId(res.teamRunId);
    } catch (e) {
      setErr((e as Error).message || "发起失败");
    } finally {
      setLaunching(false);
    }
  }, [auth, teamId, goal, originPeerId, parentRunId]);

  if (runId)
    return (
      <TeamRunLedger
        auth={auth}
        runId={runId}
        goal={goal}
        onRegen={() => {
          // 用同一目标重开：runId 指向本次作为 parent，回到发起态（goal 保留）。
          setParentRunId(runId);
          setRunId(null);
        }}
      />
    );

  return (
    <div className="flex flex-col gap-3 py-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-muted">交给团队的目标</span>
        <textarea
          className="min-h-[96px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="例如：调研 2024 年国内新能源车出海政策，产出一份带数据的分析简报"
          autoFocus
        />
      </label>
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end">
        <Button size="sm" onClick={launch} disabled={launching}>
          {launching ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              发起中…
            </>
          ) : (
            <>
              <Play size={14} />
              发起团队运行
            </>
          )}
        </Button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-faint">
        发起后队长会拆解目标、按策略并行委派成员，服务端硬强制并发上限与强制复核。下方账本实时更新。
      </p>
    </div>
  );
}

function TeamRunLedger({
  auth,
  runId,
  goal,
  onRegen,
}: {
  auth: AuthSession;
  runId: string;
  goal: string;
  onRegen: () => void;
}) {
  const [run, setRun] = useState<TeamRun | null>(null);
  const [delegations, setDelegations] = useState<TeamDelegation[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await api.getTeamRun(auth, runId);
        if (!alive) return;
        setRun(res.run);
        setDelegations(res.delegations);
        setErr(null);
        if (ACTIVE_STATUSES.has(res.run.status)) {
          timerRef.current = setTimeout(poll, 2000);
        }
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message || "读取运行状态失败");
        timerRef.current = setTimeout(poll, 4000);
      }
    };
    poll();
    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [auth, runId]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await api.stopTeamRun(auth, runId);
    } catch {
      // 忽略：下一次轮询会反映真实状态
    } finally {
      setStopping(false);
    }
  }, [auth, runId]);

  const active = run ? ACTIVE_STATUSES.has(run.status) : true;

  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2">
        {run && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${runStatusCls(run.status)}`}
          >
            {active && <Loader2 size={11} className="animate-spin" />}
            {RUN_STATUS_LABEL[run.status]}
          </span>
        )}
        {run && (
          <span className="text-[11.5px] text-faint">
            并发上限 {run.maxParallel}
            {run.reviewRequired ? " · 强制复核" : ""}
          </span>
        )}
        {active && (
          <button
            onClick={stop}
            disabled={stopping}
            className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted outline-none transition-colors hover:border-danger hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Square size={11} />
            {stopping ? "停止中…" : "停止"}
          </button>
        )}
      </div>

      <div className="rounded-lg border border-border px-3 py-2.5">
        <p className="text-[11px] font-medium text-faint">目标</p>
        <p className="mt-0.5 whitespace-pre-wrap text-[13px] text-fg">{run?.userGoal || goal}</p>
      </div>

      {err && <Alert>{err}</Alert>}

      <div className="flex flex-col gap-1.5">
        <p className="text-[12px] font-medium text-muted">委派账本（{delegations.length}）</p>
        {!run ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : delegations.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-faint">
            {active ? "队长正在拆解目标，尚未委派…" : "本次运行没有产生委派。"}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {delegations.map((d) => (
              <li
                key={d.delegationId}
                className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5"
              >
                <span className="mt-0.5 shrink-0">{delegationIcon(d.status)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[12.5px] font-medium text-fg">
                      {agentName(d.memberAgentId)}
                    </p>
                    {d.status === "rejected" && d.rejectReason && (
                      <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger">
                        {rejectLabel(d.rejectReason)}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-faint">
                      {d.status === "queued" ? "排队中" : fmtDuration(d.startedAt, d.completedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted">{d.goal}</p>
                  {d.error && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-danger">{d.error}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {run?.finalAcceptedAt && (
        <div className="rounded-lg border border-success/40 bg-success-soft px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-success">
            <CheckCircle2 size={14} />
            团队已交付最终答案
          </p>
          {run.finalContentRef && (
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg">
              {run.finalContentRef}
            </p>
          )}
        </div>
      )}
      {run?.status === "finalize_required" && (
        <Alert>队长已结束但未提交最终答案（未走 submit_team_final），本次运行未正式收尾。</Alert>
      )}
      {!active && (
        <div className="flex justify-end pt-1">
          <Button variant="secondary" size="sm" onClick={onRegen}>
            <RotateCcw size={13} />
            用同一目标重新运行
          </Button>
        </div>
      )}
    </div>
  );
}

function delegationIcon(status: TeamDelegation["status"]) {
  if (status === "completed") return <CheckCircle2 size={15} className="text-success" />;
  if (status === "failed") return <XCircle size={15} className="text-danger" />;
  if (status === "rejected") return <AlertTriangle size={15} className="text-danger" />;
  return <Loader2 size={15} className="animate-spin text-accent" />;
}

function rejectLabel(reason: string): string {
  if (reason === "maxParallel") return "撞并发上限";
  if (reason === "not_member") return "非团队成员";
  if (reason === "memory") return "内存不足";
  if (reason === "depth") return "嵌套过深";
  if (reason === "timeout") return "排队超时";
  return reason;
}
