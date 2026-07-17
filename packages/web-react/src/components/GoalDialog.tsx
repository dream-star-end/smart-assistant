import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { Check, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { groupDigits } from "../lib/utils";
import { Badge, Button, Input, Modal } from "./ui";

export type GoalSetInput = {
  objective: string;
  tokenBudget: number | null;
  creditBudget: string | null;
  expectedStateRevision: number;
};

const STATUS_LABEL: Record<GoalStateSnapshot["status"], string> = {
  active: "进行中",
  paused: "已暂停",
  blocked: "受阻",
  completed: "已完成",
  cleared: "未设置",
};

function elapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}时 ${m}分` : m > 0 ? `${m}分 ${s}秒` : `${s}秒`;
}

function creditsNearBudget(used: string, budget: string | null): boolean {
  if (!budget) return false;
  try { return BigInt(used) * 5n >= BigInt(budget) * 4n; } catch { return false; }
}

function tokensNearBudget(used: number, budget: number | null): boolean {
  if (budget === null) return false;
  return BigInt(used) * 5n >= BigInt(budget) * 4n;
}

/** 会话是否有一个「可见」目标（已设置且未清除）。入口徽标/状态点的单一判定权威。 */
export function visibleGoalOf(goal: GoalStateSnapshot | null | undefined): GoalStateSnapshot | null {
  return goal && goal.status !== "cleared" ? goal : null;
}

/** 目标预算是否接近/达到软阈值（80%）。入口状态点颜色与对话框内软告警共用同一判定。 */
export function goalNearBudget(goal: GoalStateSnapshot): boolean {
  return (
    tokensNearBudget(goal.tokensUsed, goal.tokenBudget) ||
    creditsNearBudget(goal.creditsUsed, goal.creditBudget)
  );
}

/**
 * 会话目标对话框（受控）。入口已从会话头部迁至输入框「+」菜单，故此处只负责表单本体，
 * open/onOpenChange 由调用方（Composer）持有；居中 Modal 呈现，脱离原来锚定头部按钮的 Popover。
 */
export function GoalDialog({
  open,
  onOpenChange,
  goal,
  onSet,
  onAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal: GoalStateSnapshot | null | undefined;
  onSet: (input: GoalSetInput) => Promise<void>;
  onAction: (action: "pause" | "resume" | "complete" | "clear") => Promise<void>;
}) {
  const visibleGoal = visibleGoalOf(goal);
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [creditBudget, setCreditBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    setObjective(visibleGoal?.objective ?? "");
    setTokenBudget(visibleGoal?.tokenBudget == null ? "" : String(visibleGoal.tokenBudget));
    setCreditBudget(visibleGoal?.creditBudget ?? "");
    setError("");
  }, [open, visibleGoal?.goalId, visibleGoal?.stateRevision]);

  useEffect(() => {
    const now = Date.now();
    setSnapshotReceivedAt(now);
    setClock(now);
  }, [visibleGoal?.goalId, visibleGoal?.stateRevision, visibleGoal?.snapshotRevision, visibleGoal?.timeUsedSeconds]);

  useEffect(() => {
    if (!open || visibleGoal?.status !== "active") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, visibleGoal?.goalId, visibleGoal?.stateRevision, visibleGoal?.snapshotRevision, visibleGoal?.status]);

  const warning = useMemo(() => (visibleGoal ? goalNearBudget(visibleGoal) : false), [visibleGoal]);

  const displayedTimeUsed = visibleGoal
    ? visibleGoal.timeUsedSeconds +
      (visibleGoal.status === "active" ? Math.max(0, Math.floor((clock - snapshotReceivedAt) / 1_000)) : 0)
    : 0;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (err) { setError((err as Error).message || "操作失败"); }
    finally { setBusy(false); }
  };

  const submit = () => run(async () => {
    const token = tokenBudget.trim();
    const credit = creditBudget.trim();
    if (!objective.trim()) throw new Error("请输入目标");
    if (token && (!/^\d+$/.test(token) || Number(token) <= 0 || !Number.isSafeInteger(Number(token)))) {
      throw new Error("Token 预算必须是正整数");
    }
    if (credit && !/^[1-9]\d*$/.test(credit)) throw new Error("积分预算必须是正整数");
    await onSet({
      objective: objective.trim(),
      tokenBudget: token ? Number(token) : null,
      creditBudget: credit || null,
      expectedStateRevision: goal?.stateRevision ?? 0,
    });
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-md"
      title={
        <span className="flex items-center gap-2">
          会话目标
          {visibleGoal && (
            <Badge tone={warning ? "warning" : visibleGoal.status === "completed" ? "success" : "accent"}>
              {STATUS_LABEL[visibleGoal.status]}
            </Badge>
          )}
        </span>
      }
    >
      {visibleGoal && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-hover p-2.5 text-[11.5px] text-muted tabular-nums">
          <span>Token：{groupDigits(String(visibleGoal.tokensUsed))}{visibleGoal.tokenBudget == null ? "" : ` / ${groupDigits(String(visibleGoal.tokenBudget))}`}</span>
          <span>积分：{groupDigits(visibleGoal.creditsUsed)}{visibleGoal.creditBudget == null ? "" : ` / ${groupDigits(visibleGoal.creditBudget)}`}</span>
          <span className="col-span-2">累计运行：{elapsed(displayedTimeUsed)}</span>
          {warning && <span className="col-span-2 text-warning">预算已接近或达到；这是软提醒，不会停止或阻断执行。</span>}
        </div>
      )}
      <label className="mb-2 block text-[11.5px] text-muted">
        目标
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          maxLength={8000}
          className="mt-1 w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg outline-none focus:border-accent focus:ring-2 focus:ring-ring"
          placeholder="这次会话要达成什么？"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11.5px] text-muted">Token 预算<Input className="mt-1" inputMode="numeric" value={tokenBudget} onChange={(e) => setTokenBudget(e.target.value)} placeholder="可选" /></label>
        <label className="text-[11.5px] text-muted">积分预算<Input className="mt-1" inputMode="numeric" value={creditBudget} onChange={(e) => setCreditBudget(e.target.value)} placeholder="可选" /></label>
      </div>
      {error && <p className="mt-2 text-[11.5px] text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy} onClick={submit}>{visibleGoal ? "保存" : "开始目标"}</Button>
        {visibleGoal?.status === "active" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("pause"))}><Pause size={13} />暂停</Button>}
        {(visibleGoal?.status === "paused" || visibleGoal?.status === "blocked") && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("resume"))}><Play size={13} />继续</Button>}
        {visibleGoal && !["completed", "cleared"].includes(visibleGoal.status) && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("complete"))}><Check size={13} />完成</Button>}
        {visibleGoal && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => onAction("clear"))}><Trash2 size={13} />清除</Button>}
      </div>
    </Modal>
  );
}
