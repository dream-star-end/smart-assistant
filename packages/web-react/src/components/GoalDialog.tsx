import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { Check, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiErrorMessage } from "../lib/api";
import { groupDigits } from "../lib/utils";
import { Badge, Button, Input, Modal, Textarea, useConfirm } from "./ui";

export type GoalSetInput = {
  objective: string;
  tokenBudget: number | null;
  creditBudget: string | null;
  expectedStateRevision: number;
};

export const STATUS_LABEL: Record<GoalStateSnapshot["status"], string> = {
  active: "已启用",
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
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());
  // 「清除」是不可撤销的危险操作(清除后徽标 / 菜单状态点立刻消失):二次确认 + danger 视觉(C-05)。
  const [confirm, confirmEl] = useConfirm();
  const fieldId = useId();
  // 表单是否有未保存修改;服务端在对话框打开期间推来新版本时,有修改就不能静默覆盖(C-31)。
  const [dirty, setDirty] = useState(false);
  const [staleFromServer, setStaleFromServer] = useState(false);
  // 表单当前对应的服务端版本(goalId + stateRevision),用于判断「打开期间是否被别处改过」。
  const formRevisionRef = useRef<string>("");
  // 本对话框自己发起的动作(暂停/继续/完成)也会推高 stateRevision,那不是「别处更新」,不该弹提示。
  const selfActionRef = useRef(false);
  const serverRevision = visibleGoal ? `${visibleGoal.goalId}:${visibleGoal.stateRevision}` : "";

  const loadForm = (snapshot: GoalStateSnapshot | null) => {
    setObjective(snapshot?.objective ?? "");
    setTokenBudget(snapshot?.tokenBudget == null ? "" : String(snapshot.tokenBudget));
    setCreditBudget(snapshot?.creditBudget ?? "");
    setDirty(false);
    setStaleFromServer(false);
    formRevisionRef.current = snapshot ? `${snapshot.goalId}:${snapshot.stateRevision}` : "";
  };

  // 打开时装载一次;打开期间服务端版本变化:无修改 → 直接同步,有修改 → 只提示、不覆盖正在编辑的内容(C-31)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只对 open 翻真 / 服务端版本变化响应,表单值本身不是触发源
  useEffect(() => {
    if (!open) {
      formRevisionRef.current = "";
      selfActionRef.current = false;
      setDirty(false);
      setStaleFromServer(false);
      return;
    }
    if (formRevisionRef.current === "") {
      loadForm(visibleGoal);
      return;
    }
    if (serverRevision === formRevisionRef.current) return;
    if (selfActionRef.current) {
      // 自己的状态流转:只认下新版本号,表单内容原样保留。
      selfActionRef.current = false;
      formRevisionRef.current = serverRevision;
      if (!dirty) loadForm(visibleGoal);
      return;
    }
    if (dirty) setStaleFromServer(true);
    else loadForm(visibleGoal);
  }, [open, serverRevision]);

  useEffect(() => { if (open) setError(""); }, [open]);

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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    selfActionRef.current = true;
    // 表单校验错误原样展示;接口错误经 apiErrorMessage 统一转成用户可读文案(C-31)。
    try { await fn(); } catch (err) { selfActionRef.current = false; setError(apiErrorMessage(err, "操作失败")); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const clear = async () => {
    const ok = await confirm({
      title: "清除会话目标？",
      body: "目标与预算统计将被移除，且无法撤销。已产生的对话内容不受影响。",
      confirmText: "清除目标",
      danger: true,
    });
    if (ok !== true) return;
    await run(() => onAction("clear"));
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
    onOpenChange(false);
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
            // 「受阻」是需要处理的负向状态,用 warning 而不是 accent(C-31)。
            <Badge
              tone={
                warning || visibleGoal.status === "blocked"
                  ? "warning"
                  : visibleGoal.status === "completed"
                    ? "success"
                    : "accent"
              }
            >
              {STATUS_LABEL[visibleGoal.status]}
            </Badge>
          )}
        </span>
      }
    >
      {visibleGoal && (
        <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-hover p-2.5 text-caption text-muted tabular-nums">
          <span>Token：{groupDigits(String(visibleGoal.tokensUsed))}{visibleGoal.tokenBudget == null ? "" : ` / ${groupDigits(String(visibleGoal.tokenBudget))}`}</span>
          <span>积分：{groupDigits(visibleGoal.creditsUsed)}{visibleGoal.creditBudget == null ? "" : ` / ${groupDigits(visibleGoal.creditBudget)}`}</span>
          <span className="col-span-2">累计运行：{elapsed(displayedTimeUsed)}</span>
          {warning && <span className="col-span-2 text-warning">预算已接近或达到；这是软提醒，不会停止或阻断执行。</span>}
        </div>
      )}
      {staleFromServer && (
        <output
          data-testid="goal-stale-hint"
          className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-soft px-2.5 py-2 text-caption text-warning"
        >
          <span>目标已在别处更新。保存会覆盖服务端版本；也可以放弃本地修改重新载入。</span>
          <Button size="sm" variant="secondary" onClick={() => loadForm(visibleGoal)}>
            重新载入
          </Button>
        </output>
      )}
      <label htmlFor={`${fieldId}-objective`} className="mb-2 block text-caption text-muted">
        目标
        {/* 表单控件走 ui/Textarea(与 Input 同一外观权威),不再手写边框/焦点环(C-31)。 */}
        <Textarea
          id={`${fieldId}-objective`}
          value={objective}
          onChange={(e) => {
            setObjective(e.target.value);
            setDirty(true);
          }}
          rows={3}
          maxLength={8000}
          className="mt-1 w-full resize-y"
          placeholder="这次会话要达成什么？"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={`${fieldId}-token`} className="text-caption text-muted">Token 预算<Input id={`${fieldId}-token`} className="mt-1" inputMode="numeric" value={tokenBudget} onChange={(e) => { setTokenBudget(e.target.value); setDirty(true); }} placeholder="可选" /></label>
        <label htmlFor={`${fieldId}-credit`} className="text-caption text-muted">积分预算<Input id={`${fieldId}-credit`} className="mt-1" inputMode="numeric" value={creditBudget} onChange={(e) => { setCreditBudget(e.target.value); setDirty(true); }} placeholder="可选" /></label>
      </div>
      <p className="mt-2 text-caption text-muted">保存已启用的目标后，空闲会话会自动开始；正在执行时只更新目标。</p>
      {error && <p role="alert" className="mt-2 text-caption text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={busy} onClick={submit}>{visibleGoal && visibleGoal.status !== "completed" ? "保存" : "设置并开始"}</Button>
        {visibleGoal?.status === "active" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("pause"))}><Pause size={13} />暂停</Button>}
        {(visibleGoal?.status === "paused" || visibleGoal?.status === "blocked") && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("resume"))}><Play size={13} />继续</Button>}
        {visibleGoal && !["completed", "cleared"].includes(visibleGoal.status) && <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onAction("complete"))}><Check size={13} />完成</Button>}
        {visibleGoal && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-danger hover:text-danger"
            disabled={busy}
            onClick={() => void clear()}
          >
            <Trash2 size={13} />清除
          </Button>
        )}
      </div>
      {confirmEl}
    </Modal>
  );
}
