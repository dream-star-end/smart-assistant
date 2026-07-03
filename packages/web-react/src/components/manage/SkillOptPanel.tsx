/**
 * SkillOpt 面板 —— 单个技能展开区里的「评测」与「训练优化」两个分区。
 *
 * 成本红线(boss):任何消耗积分的动作(运行评测/启动训练/评论重训)必须
 * 先弹成本确认(线路+费率来源+估算区间+红字提示),运行中/结束后按实际用量
 * 折算实报(与计费同公式;以账单为准)。绝不静默扣费。
 */
import {
  Check,
  ChevronRight,
  FlaskConical,
  GraduationCap,
  Loader2,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  creditsForUsage,
  estimateEvalRunCredits,
  estimateTrainRunCredits,
  fmtCreditRange,
  fmtCredits,
  type ModelRates,
} from "../../lib/skillRunCost";
import type {
  AuthSession,
  SkillDraftDetail,
  SkillDraftSummary,
  SkillEvalRun,
  SkillEvalsFile,
  SkillRunUsage,
  SkillTrainRun,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Badge, Button, Spinner, Textarea, useConfirm } from "../ui";

/** 训练/评测锁定的线路(与 gateway SKILL_TRAIN_DEFAULT_MODEL 一致)。 */
export const SKILL_RUN_MODEL = "deepseek-v4-pro";

const POLL_MS = 3000;

function usePollingRun<T>(
  fetcher: (() => Promise<T>) | null,
  isActive: (r: T) => boolean,
): [T | null, (r: T | null) => void] {
  const [run, setRun] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (!fetcher) return;
    let alive = true;
    const tick = () =>
      fetcher()
        .then((r) => {
          if (!alive) return;
          setRun(r);
          if (!isActive(r) && timer.current) {
            clearInterval(timer.current);
            timer.current = null;
          }
        })
        .catch(() => {});
    tick();
    timer.current = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [fetcher, isActive]);
  return [run, setRun];
}

/** 成本确认对话框正文(所有消耗积分的动作共用同一形态)。 */
function CostBody({
  lines,
  range,
  rates,
  extra,
}: {
  lines: string[];
  range: string;
  rates: ModelRates | null;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <ul className="list-disc pl-4 text-muted">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p>
        预计消耗:<span className="font-medium text-fg">{range}</span>
        {rates && (
          <span className="text-faint">
            (按 {rates.displayName} 公开费率估算,实际以账单为准)
          </span>
        )}
      </p>
      {extra}
      <p className="font-medium text-danger">本操作将消耗你的积分,确认后立即开始。</p>
    </div>
  );
}

/** 实际用量 → "tokens + 折算积分" 实报行。 */
function UsageLine({ usage, rates, label }: { usage?: SkillRunUsage; rates: ModelRates | null; label?: string }) {
  if (!usage || usage.turns === 0) return null;
  const credits = rates ? creditsForUsage(usage, rates) : null;
  return (
    <p className="text-[11.5px] text-faint">
      {label ?? "本次消耗"}:输入 {usage.inputTokens.toLocaleString()} / 输出{" "}
      {usage.outputTokens.toLocaleString()} tokens({usage.turns} 轮)
      {credits !== null && (
        <>
          ,折算约 <span className="font-medium text-muted">{fmtCredits(credits)} 积分</span>
          (实际扣费以账单为准)
        </>
      )}
    </p>
  );
}

const ARM_LABEL: Record<string, string> = { with: "有技能", without: "无技能", draft: "草稿版" };

// ── 评测分区 ─────────────────────────────────────────────────────────────────

export function SkillEvalSection({
  auth,
  skillName,
  rates,
}: {
  auth: AuthSession;
  skillName: string;
  rates: ModelRates | null;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [cases, setCases] = useState<Array<{ id: string; prompt: string; assertions: string }>>([]);
  const [autoRegression, setAutoRegression] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [lastRun, setLastRun] = useState<{ finishedAt: number; benchmark: SkillEvalRun["benchmark"]; usage: SkillRunUsage } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    api
      .getSkillEvals(auth, skillName)
      .then((r) => {
        setWritable(r.writable);
        setAutoRegression(r.evals?.autoRegression === true);
        setCases(
          (r.evals?.cases ?? []).map((c) => ({
            id: c.id,
            prompt: c.prompt,
            assertions: c.assertions.join("\n"),
          })),
        );
        setLastRun(r.lastRun as typeof lastRun);
        if (r.parseErrors?.length) setErr(`evals.json 解析失败:${r.parseErrors.join(";")}`);
        setDirty(false);
      })
      .catch((e) => setErr((e as Error).message || "加载评测用例失败"))
      .finally(() => setLoading(false));
  }, [auth, skillName]);
  useEffect(load, [load]);

  const buildFile = (auto: boolean): SkillEvalsFile => ({
    version: 1,
    cases: cases.map((c, i) => ({
      id: c.id.trim() || `case-${i + 1}`,
      prompt: c.prompt.trim(),
      assertions: c.assertions
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean),
    })),
    ...(auto ? { autoRegression: true } : {}),
  });

  const save = async (auto = autoRegression) => {
    setSaving(true);
    setErr(null);
    try {
      await api.putSkillEvals(auth, skillName, buildFile(auto));
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 运行评测:成本确认 → start → 轮询。
  const startRun = async () => {
    const n = cases.length;
    if (n === 0) return setErr("请先添加至少 1 个评测用例");
    if (dirty) return setErr("有未保存的用例修改,先保存再运行");
    const range = rates ? fmtCreditRange(estimateEvalRunCredits(n, 2, rates)) : "少量";
    const ok = await confirmDialog({
      title: `运行评测(${n} 个用例)?`,
      body: (
        <CostBody
          lines={[
            `线路:${rates?.displayName ?? SKILL_RUN_MODEL}(平台锁定)`,
            `${n} 个用例 × 2 组对照(有技能 / 无技能)+ 每用例 1 次评分`,
            "全部在隔离会话中运行,不影响你的正常对话与技能库",
          ]}
          range={range}
          rates={rates}
        />
      ),
      confirmText: "开始评测",
    });
    if (!ok) return;
    try {
      const r = await api.startSkillEvalRun(auth, skillName, { mode: "baseline" });
      setRunId(r.runId);
    } catch (e) {
      setErr((e as Error).message || "启动评测失败");
    }
  };

  const evalFetcher = useCallback(
    () => (runId ? api.getSkillEvalRun(auth, runId) : Promise.reject(new Error("no run"))),
    [auth, runId],
  );
  const isActive = useCallback(
    (r: SkillEvalRun) => r.status === "queued" || r.status === "running" || r.status === "grading",
    [],
  );
  const [run] = usePollingRun(runId ? evalFetcher : null, isActive);
  useEffect(() => {
    if (run && run.status === "done") load();
  }, [run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自动回归 opt-in:显式确认成本后写回 evals.json。
  const toggleAutoRegression = async () => {
    if (!autoRegression) {
      const perDay = rates ? fmtCreditRange(estimateEvalRunCredits(Math.max(1, cases.length), 2, rates)) : "少量";
      const ok = await confirmDialog({
        title: "开启每日自动回归?",
        body: (
          <CostBody
            lines={[
              "平台每天自动跑一次本技能的评测,通过率下降时推送提醒到对话",
              `每天约消耗:${perDay}`,
              "不会自动改动技能内容,更不会自动开训练 —— 只提醒",
            ]}
            range={perDay + " / 天"}
            rates={rates}
          />
        ),
        confirmText: "开启并接受每日消耗",
      });
      if (!ok) return;
      setAutoRegression(true);
      await save(true);
    } else {
      setAutoRegression(false);
      await save(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 py-4 text-[12.5px] text-faint">
        <Spinner size={14} /> 加载评测…
      </div>
    );

  const running = run && isActive(run);

  return (
    <div className="flex flex-col gap-3">
      {confirmDialogEl}
      {err && <Alert tone="danger">{err}</Alert>}

      {/* 用例编辑 */}
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-muted">评测用例({cases.length}/5)</span>
        <div className="flex items-center gap-1.5">
          {writable && (
            <Button
              variant="ghost"
              size="sm"
              disabled={cases.length >= 5}
              onClick={() => {
                setCases((cs) => [...cs, { id: `case-${cs.length + 1}`, prompt: "", assertions: "" }]);
                setDirty(true);
              }}
            >
              <Plus size={13} /> 加用例
            </Button>
          )}
          {writable && (
            <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={() => save()}>
              {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <Check size={13} /> : null}
              {saved ? "已保存" : "保存用例"}
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={startRun} disabled={!!running || cases.length === 0}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            运行评测
          </Button>
        </div>
      </div>
      {cases.length === 0 ? (
        <p className="text-[12px] text-faint">
          还没有评测用例。用例 = 一个真实任务 + 几条可判定的验收断言;它是「这个技能到底有没有用」的
          唯一事实标准。{writable ? "点「加用例」开始。" : ""}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {cases.map((c, i) => (
            <li key={i} className="rounded-lg border border-border bg-bg p-2.5">
              <div className="mb-1 flex items-center gap-2">
                <input
                  value={c.id}
                  disabled={!writable}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCases((cs) => cs.map((x, j) => (j === i ? { ...x, id: v } : x)));
                    setDirty(true);
                  }}
                  className="w-40 rounded border border-border bg-surface px-2 py-1 font-mono text-[11.5px] text-fg outline-none focus:border-accent"
                  placeholder="case-id"
                />
                {writable && (
                  <button
                    type="button"
                    onClick={() => {
                      setCases((cs) => cs.filter((_, j) => j !== i));
                      setDirty(true);
                    }}
                    aria-label="删除用例"
                    className="ml-auto flex size-6 items-center justify-center rounded text-faint hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <Textarea
                value={c.prompt}
                disabled={!writable}
                onChange={(e) => {
                  const v = e.target.value;
                  setCases((cs) => cs.map((x, j) => (j === i ? { ...x, prompt: v } : x)));
                  setDirty(true);
                }}
                rows={2}
                placeholder="任务(真实措辞,含必要上下文)…"
                className="mb-1.5 text-[12.5px]"
              />
              <Textarea
                value={c.assertions}
                disabled={!writable}
                onChange={(e) => {
                  const v = e.target.value;
                  setCases((cs) => cs.map((x, j) => (j === i ? { ...x, assertions: v } : x)));
                  setDirty(true);
                }}
                rows={3}
                placeholder={"验收断言,每行一条,例如:\n输出为英文且信息无遗漏\n保留原文数字与单位"}
                className="font-mono text-[12px]"
              />
            </li>
          ))}
        </ul>
      )}

      {/* 运行进度 / 结果 */}
      {run && (
        <div className="rounded-lg border border-border bg-bg p-3">
          {running ? (
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <Spinner size={14} />
              {run.status === "grading" ? "评分中" : "评测中"}({run.progress.done}/{run.progress.total} 组)…
            </div>
          ) : run.status === "failed" ? (
            <Alert tone="danger">评测失败:{run.error}</Alert>
          ) : (
            <EvalResultView run={run} rates={rates} />
          )}
          <div className="mt-1.5">
            <UsageLine usage={run.usage} rates={rates} label={running ? "已消耗" : "本次消耗"} />
          </div>
        </div>
      )}

      {/* 上次结果(无进行中 run 时) */}
      {!run && lastRun?.benchmark && (
        <div className="rounded-lg border border-border bg-bg p-3">
          <p className="text-[12.5px] font-medium text-fg">上次评测:{lastRun.benchmark.verdict}</p>
          <UsageLine usage={lastRun.usage} rates={rates} label="上次消耗" />
        </div>
      )}

      {/* P3:自动回归 opt-in */}
      {writable && cases.length > 0 && (
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <input type="checkbox" checked={autoRegression} onChange={toggleAutoRegression} />
          每日自动回归(明确知晓每日消耗,失败推送提醒;默认关闭)
        </label>
      )}
    </div>
  );
}

function EvalResultView({ run, rates }: { run: SkillEvalRun; rates: ModelRates | null }) {
  const [openCase, setOpenCase] = useState<string | null>(null);
  const b = run.benchmark;
  if (!b) return <p className="text-[12.5px] text-muted">评测完成,但没有可用结果。</p>;
  const pct = (x?: number) => `${Math.round((x ?? 0) * 100)}%`;
  const armsShown = run.mode === "draft" ? (["with", "draft"] as const) : (["without", "with"] as const);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium text-fg">{b.verdict}</p>
      <div className="flex flex-wrap gap-1.5">
        {armsShown.map((arm) => (
          <Badge key={arm} tone={arm === "without" ? "neutral" : "accent"}>
            {ARM_LABEL[arm]} 通过率 {pct(b.passRate[arm])}
            {b.counts[arm] ? `(${b.counts[arm]?.passed}/${b.counts[arm]?.total})` : ""}
          </Badge>
        ))}
        {b.preference && (
          <Badge tone="info">
            盲测偏好 草稿{b.preference.draft} : 现版{b.preference.current} : 平{b.preference.tie}
          </Badge>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {run.cases.map((c) => {
          const rs = run.results.filter((r) => r.caseId === c.id);
          const open = openCase === c.id;
          return (
            <li key={c.id} className="rounded border border-border">
              <button
                type="button"
                onClick={() => setOpenCase(open ? null : c.id)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-muted hover:bg-hover"
              >
                <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate font-mono">{c.id}</span>
                {rs.map((r) => (
                  <span key={r.arm} className="text-[11px] text-faint">
                    {ARM_LABEL[r.arm]}{" "}
                    {r.error ? "✗错" : `${r.assertions.filter((a) => a.passed).length}/${r.assertions.length}`}
                  </span>
                ))}
              </button>
              {open && (
                <div className="border-t border-border px-2.5 py-2 text-[12px]">
                  {rs.map((r) => (
                    <div key={r.arm} className="mb-2">
                      <p className="mb-0.5 font-medium text-fg">{ARM_LABEL[r.arm]}</p>
                      {r.error ? (
                        <p className="text-danger">{r.error}</p>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {r.assertions.map((a, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              {a.passed ? (
                                <Check size={13} className="mt-0.5 shrink-0 text-success" />
                              ) : (
                                <X size={13} className="mt-0.5 shrink-0 text-danger" />
                              )}
                              <span className="min-w-0">
                                <span className="text-fg">{a.text}</span>
                                {a.evidence && <span className="block text-[11px] text-faint">{a.evidence}</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 训练分区 ─────────────────────────────────────────────────────────────────

export function SkillTrainSection({
  auth,
  skillName,
  rates,
}: {
  auth: AuthSession;
  skillName: string;
  rates: ModelRates | null;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();

  const trainFetcher = useCallback(
    () => (runId ? api.getSkillTrainRun(auth, runId) : Promise.reject(new Error("no run"))),
    [auth, runId],
  );
  const isActive = useCallback(
    (r: SkillTrainRun) => r.status === "queued" || r.status === "running",
    [],
  );
  const [run, setRun] = usePollingRun(runId ? trainFetcher : null, isActive);

  const start = async () => {
    const trainRange = rates ? estimateTrainRunCredits(rates) : null;
    const evalRange = rates ? estimateEvalRunCredits(3, 2, rates) : null;
    const total = trainRange && evalRange
      ? fmtCreditRange({ low: trainRange.low, high: trainRange.high + evalRange.high })
      : "视会话量而定";
    const ok = await confirmDialog({
      title: `训练优化「${skillName}」?`,
      body: (
        <CostBody
          lines={[
            `线路:${rates?.displayName ?? SKILL_RUN_MODEL}(平台锁定,最高思考档)`,
            "自动复盘你近期的真实会话,给这个技能起草改进(只产草稿,合并前不会改动技能)",
            "草稿产出后自动跑评测门:草稿 vs 现版实测对比,给出「是否值得合并」的量化结论",
          ]}
          range={total}
          rates={rates}
          extra={
            <p className="text-[12px] text-faint">
              含训练 + 草稿评测两部分;若技能还没有评测用例,训练会一并提议用例(随草稿确认)。
            </p>
          }
        />
      ),
      confirmText: "开始训练(接受消耗)",
    });
    if (!ok) return;
    setErr(null);
    try {
      const r = await api.startSkillTrain(auth, skillName, { autoEval: true });
      setRunId(r.runId);
    } catch (e) {
      setErr((e as Error).message || "启动训练失败");
    }
  };

  const discard = async () => {
    if (!runId) return;
    const ok = await confirmDialog({ title: "放弃本次训练与全部草稿?", confirmText: "放弃", danger: true });
    if (!ok) return;
    await api.discardSkillTrainRun(auth, runId).catch(() => {});
    setRunId(null);
    setRun(null);
  };

  const PHASE_LABEL: Record<string, string> = {
    queued: "排队中",
    scanning_sessions: "复盘近期会话",
    evaluating: "分析现有技能",
    drafting: "起草改进",
    diff_ready: "草稿就绪",
    done: "完成",
    failed: "失败",
  };

  return (
    <div className="flex flex-col gap-3">
      {confirmDialogEl}
      {err && <Alert tone="danger">{err}</Alert>}

      {!run && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-muted">
            系统复盘你近期的真实使用,起草这个技能的改进;草稿先过评测门(草稿 vs 现版实测),
            再由你决定是否合并 —— 技能库永远不会被自动改动。
          </p>
          <Button variant="primary" size="sm" onClick={start} className="shrink-0">
            <GraduationCap size={14} /> 训练优化
          </Button>
        </div>
      )}

      {run && (
        <div className="rounded-lg border border-border bg-bg p-3">
          <div className="flex items-center gap-2">
            {isActive(run) ? <Spinner size={14} /> : run.status === "failed" ? <X size={14} className="text-danger" /> : <Check size={14} className="text-success" />}
            <span className="text-[12.5px] font-medium text-fg">
              {PHASE_LABEL[run.phase] ?? run.phase}
              {isActive(run) && `(已 ${run.toolCalls} 步)`}
            </span>
            <span className="ml-auto flex gap-1.5">
              {(run.status === "diff_ready" || isActive(run)) && (
                <Button variant="ghost" size="sm" onClick={discard}>
                  放弃
                </Button>
              )}
            </span>
          </div>
          <div className="mt-1">
            <UsageLine usage={run.usage} rates={rates} label={isActive(run) ? "已消耗" : "训练消耗"} />
          </div>
          {run.status === "failed" && <Alert tone="danger" className="mt-2">{run.error}</Alert>}
          {run.status === "discarded" && (
            <p className="mt-2 text-[12px] text-faint">本次训练没有产出可用草稿(或已放弃)。</p>
          )}
          {run.status === "merged" && (
            <Alert tone="success" className="mt-2">已合并到技能库。</Alert>
          )}
          {run.status === "diff_ready" && (
            <TrainDraftView
              auth={auth}
              run={run}
              rates={rates}
              onMergedOrDiscarded={() => {
                setRunId(null);
                setRun(null);
              }}
              confirmDialog={confirmDialog}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TrainDraftView({
  auth,
  run,
  rates,
  onMergedOrDiscarded,
  confirmDialog,
}: {
  auth: AuthSession;
  run: SkillTrainRun;
  rates: ModelRates | null;
  onMergedOrDiscarded: () => void;
  confirmDialog: (opts: { title: string; body?: ReactNode; confirmText?: string; danger?: boolean }) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<SkillDraftSummary[]>([]);
  const [detail, setDetail] = useState<SkillDraftDetail | null>(null);
  const [showOld, setShowOld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .listSkillDrafts(auth, run.runId)
      .then(async (ds) => {
        if (!alive) return;
        setDrafts(ds);
        if (ds[0]) {
          const d = await api.getSkillDraft(auth, run.runId, ds[0].name);
          if (alive) setDetail(d);
        }
      })
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [auth, run.runId]);

  // 评测门结果(evalRunId 轮询到 done)
  const evalFetcher = useCallback(
    () => (run.evalRunId ? api.getSkillEvalRun(auth, run.evalRunId) : Promise.reject(new Error("none"))),
    [auth, run.evalRunId],
  );
  const evalActive = useCallback(
    (r: SkillEvalRun) => r.status === "queued" || r.status === "running" || r.status === "grading",
    [],
  );
  const [evalRun] = usePollingRun(run.evalRunId ? evalFetcher : null, evalActive);

  const merge = async () => {
    const evalNote = evalRun?.benchmark?.verdict
      ? `评测门结论:${evalRun.benchmark.verdict}`
      : "本草稿未经评测(无用例或评测未完成)。";
    const ok = await confirmDialog({
      title: "合并草稿到技能库?",
      body: <p className="text-[12.5px] text-muted">{evalNote} 合并会覆盖现版(旧版自动存入历史,可回滚)。</p>,
      confirmText: "合并",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.mergeSkillTrainRun(auth, run.runId);
      if (!r.ok) setErr(r.results.map((x) => x.error).filter(Boolean).join("; ") || "合并失败");
      else onMergedOrDiscarded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendComment = async () => {
    const c = comment.trim();
    if (!c || !detail) return;
    const range = rates ? fmtCreditRange(estimateTrainRunCredits(rates)) : "少量";
    const ok = await confirmDialog({
      title: "按评论修订草稿?",
      body: (
        <CostBody
          lines={["继续同一训练会话修订草稿(修订后可再次评测/合并)"]}
          range={range}
          rates={rates}
        />
      ),
      confirmText: "修订(接受消耗)",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.commentSkillDraft(auth, run.runId, detail.draft.record.name, c);
      setComment("");
      setErr("已提交修订,训练会话重新运行中 —— 稍后回来看新草稿。");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!detail)
    return err ? (
      <Alert tone="danger" className="mt-2">{err}</Alert>
    ) : (
      <div className="mt-2 flex items-center gap-2 text-[12px] text-faint">
        <Spinner size={13} /> 加载草稿…
      </div>
    );

  const d = detail.draft;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      {err && <Alert tone={err.startsWith("已提交") ? "info" : "danger"}>{err}</Alert>}
      <div className="flex flex-wrap items-center gap-1.5">
        <FlaskConical size={14} className="text-accent" />
        <span className="text-[13px] font-medium text-fg">草稿:{d.record.name}</span>
        <Badge tone="accent">{d.record.op === "create" ? "新建" : d.record.op === "update" ? "更新" : "删除"}</Badge>
        {drafts.length > 1 && <Badge tone="neutral">共 {drafts.length} 份草稿</Badge>}
        {d.evalsJson && <Badge tone="info">附带评测用例</Badge>}
        {evalRun &&
          (evalActive(evalRun) ? (
            <Badge tone="warning">
              <Loader2 size={11} className="animate-spin" /> 评测门运行中
            </Badge>
          ) : evalRun.benchmark ? (
            <Badge tone={evalRun.benchmark.verdict.startsWith("草稿更差") ? "danger" : evalRun.benchmark.verdict.startsWith("草稿更好") ? "success" : "info"}>
              {evalRun.benchmark.verdict}
            </Badge>
          ) : null)}
      </div>
      {d.record.rationale && <p className="text-[12px] text-muted">理由:{d.record.rationale}</p>}

      <div>
        <button
          type="button"
          onClick={() => setShowOld((v) => !v)}
          className="mb-1 text-[11.5px] text-accent hover:underline"
        >
          {showOld ? "收起现版对照" : "展开现版对照"}
        </button>
        {showOld && (
          <pre className="mb-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-code px-2.5 py-2 font-mono text-[11.5px] text-muted">
            {detail.current?.body || "(现版不存在 —— 新建技能)"}
          </pre>
        )}
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-code px-2.5 py-2 font-mono text-[12px] text-fg">
          {d.body}
        </pre>
      </div>

      {evalRun && !evalActive(evalRun) && evalRun.benchmark && (
        <div className="rounded border border-border bg-surface p-2.5">
          <EvalResultView run={evalRun} rates={rates} />
          <UsageLine usage={evalRun.usage} rates={rates} label="评测门消耗" />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={merge} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} 合并到技能库
        </Button>
        <span className="text-[11.5px] text-faint">或对草稿留评论并修订:</span>
      </div>
      <div className="flex gap-2">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="例:步骤 3 缺了鉴权说明,补上;删掉第 5 条空话"
          className="text-[12.5px]"
        />
        <Button variant="secondary" size="sm" onClick={sendComment} disabled={busy || !comment.trim()} className="self-end">
          修订
        </Button>
      </div>
    </div>
  );
}
