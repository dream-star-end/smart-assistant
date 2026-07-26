/**
 * SkillOpt 面板 —— 技能工作台(SkillEditor)里的「评测」与「训练优化」两个分区。
 *
 * 成本红线(boss):任何消耗积分的动作(运行评测/启动训练/评论重训)必须
 * 先弹成本确认(模型+费率来源+估算区间+红字提示),运行中/结束后按实际用量
 * 折算实报(与计费同公式;以账单为准)。绝不静默扣费。
 *
 * ── 2026-07-26 呈现层改造(功能语义不变) ──────────────────────────────────
 * 1. 本分区从「技能列表行手风琴」迁进技能工作台弹窗(4xl 宽 / 88vh 高)。工具条
 *    因此不再需要挤进 296px:改成标题与操作分两行 + flex-wrap,窄屏不再撑破面板。
 * 2. **合并草稿(已扣积分)成功后零反馈**是本区最贵的缺陷:成功回调把整块 UI 卸载,
 *    原先写好的 <Alert tone="success"> 是永远渲染不到的死代码,且技能正文缓存不失效。
 *    现在:Toast(离开当前上下文)+ 留在原地的 mergedNotice + onSkillChanged 让外层
 *    失效正文缓存。两处不可达分支(merged / discarded)已删除。
 * 3. 长流程给出真实进度:训练=五阶段步骤条 + 已运行时长,评测=Progress + 组数;
 *    两处状态容器挂 aria-live,读屏用户能听到阶段变化。成本确认框补「开始后无法中止」。
 * 4. 草稿对照从「两块各自滚动的代码堆」改为**行级 diff**(单栏、增删着色、未变更折叠),
 *    多份草稿可逐份切换审阅,合并确认框列出全部将写入项并标注未查看项。
 * 5. 成功消息不再走 err 通道靠字符串前缀判色;扣费开关换 Switch 原语并在保存失败时回滚。
 */
import {
  Check,
  ChevronRight,
  FlaskConical,
  GraduationCap,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api, apiErrorMessage } from "../../lib/api";
import {
  creditsForUsage,
  estimateEvalRunCredits,
  estimateTrainRunCredits,
  fmtCreditRange,
  fmtCredits,
  type ModelRates,
} from "../../lib/skillRunCost";
import { pickResumableTrainRun } from "../../lib/skillTrainReentry";
import type {
  AuthSession,
  SkillDraftDetail,
  SkillDraftSummary,
  SkillEvalGenJob,
  SkillEvalRun,
  SkillEvalsFile,
  SkillRunUsage,
  SkillTrainRun,
} from "../../lib/types";
import { cn } from "../../lib/utils";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  ListSkeleton,
  Progress,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  Textarea,
  useConfirm,
  useToast,
} from "../ui";

/** 训练/评测锁定的模型(与 gateway SKILL_TRAIN_DEFAULT_MODEL 一致)。 */
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

/** 秒级自刷新(仅在有活跃 run 时起定时器)——「已运行 N 分」不自刷新就是一句谎话。 */
function useTicker(active: boolean, ms = 1000) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
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
    <div className="flex flex-col gap-2 text-body">
      <ul className="list-disc pl-4 text-muted">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p>
        预计消耗:<span className="font-medium text-fg">{range}</span>
        {rates && (
          <span className="text-muted">
            (按 {rates.displayName} 公开费率估算,实际以账单为准)
          </span>
        )}
      </p>
      {extra}
      <p className="font-medium text-danger">本操作将消耗你的积分,确认后立即开始。</p>
    </div>
  );
}

/**
 * 实际用量 → "tokens + 折算积分" 实报行。
 * 计费实报是本区最该被读懂的文案,故不用 text-faint(全站最低对比度)。
 */
function UsageLine({ usage, rates, label }: { usage?: SkillRunUsage; rates: ModelRates | null; label?: string }) {
  if (!usage || usage.turns === 0) return null;
  const credits = rates ? creditsForUsage(usage, rates) : null;
  return (
    <p className="text-meta text-muted">
      {label ?? "本次消耗"}:输入 {usage.inputTokens.toLocaleString()} / 输出{" "}
      {usage.outputTokens.toLocaleString()} tokens({usage.turns} 轮)
      {credits !== null && (
        <>
          ,折算约 <span className="font-medium text-fg">{fmtCredits(credits)} 积分</span>
          (实际扣费以账单为准)
        </>
      )}
    </p>
  );
}

const ARM_LABEL: Record<string, string> = { with: "有技能", without: "无技能", draft: "草稿版" };
const OP_LABEL: Record<string, string> = { create: "新建", update: "更新", delete: "删除" };

/** AI 生成端点错误 → 友好中文(409/403/404 单独措辞,其余回原始信息)。 */
function genErrMessage(e: unknown): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 409) return "该技能有评测或生成任务在进行中,请稍后再试";
  if (status === 403) return "只有你自建的技能才能生成评测用例";
  if (status === 404) return "技能不存在或已删除";
  return apiErrorMessage(e, "AI 生成用例失败");
}

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
  // AI 生成 job:genRunId 非空即"生成中";done 后把草稿灌进上面的 cases 编辑器(dirty),
  // draftBanner 提示用户审阅后保存。生成绝不落库,保存仍走既有 PUT。
  const [genRunId, setGenRunId] = useState<string | null>(null);
  const [draftBanner, setDraftBanner] = useState(false);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();
  const autoId = useId();

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
        setDraftBanner(false);
      })
      .catch((e) => setErr(apiErrorMessage(e, "加载评测用例失败")))
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

  /** 返回是否成功 —— 扣费开关要据此决定回滚,不能只 setErr 了事。 */
  const save = async (auto = autoRegression): Promise<boolean> => {
    setSaving(true);
    setErr(null);
    try {
      await api.putSkillEvals(auth, skillName, buildFile(auto));
      setDirty(false);
      setDraftBanner(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      return true;
    } catch (e) {
      setErr(apiErrorMessage(e, "保存失败"));
      return false;
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
            `模型:${rates?.displayName ?? SKILL_RUN_MODEL}(平台锁定)`,
            `${n} 个用例 × 2 组对照(有技能 / 无技能)+ 每用例 1 次评分`,
            "全部在隔离会话中运行,不影响你的正常对话与技能库",
            "开始后无法中止,请先确认用例无误",
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
      setErr(apiErrorMessage(e, "启动评测失败"));
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

  // ── AI 生成用例:成本确认 → POST → 3s 轮询 → done 灌进编辑器(追加,dirty) ──
  const generating = !!genRunId;
  const genFetcher = useCallback(
    () => (genRunId ? api.getSkillEvalGen(auth, genRunId) : Promise.reject(new Error("no gen"))),
    [auth, genRunId],
  );
  const genActive = useCallback((g: SkillEvalGenJob) => g.status === "running", []);
  const [genRun, setGenRun] = usePollingRun(genRunId ? genFetcher : null, genActive);
  useEffect(() => {
    if (!genRun || genRun.status === "running") return; // 进行中:继续轮询,别清 job。
    if (genRun.status === "done") {
      const drafted = (genRun.cases ?? []).map((c) => ({
        id: c.id,
        prompt: c.prompt,
        assertions: c.assertions.join("\n"),
      }));
      // 灌进现有编辑器 state(唯一编辑权威;不旁路造第二份草稿 state)。已有用例=追加,
      // 尊重 5 条上限(与「加用例」同一不变量),超出部分裁掉。
      setCases((prev) => {
        const room = Math.max(0, 5 - prev.length);
        return room > 0 ? [...prev, ...drafted.slice(0, room)] : prev;
      });
      setDirty(true);
      setDraftBanner(true);
    } else {
      // failed:提示失败原因(note)。
      setErr(genRun.note ? `AI 生成用例失败:${genRun.note}` : "AI 生成用例失败");
    }
    // 仅终态(done/failed)清 job、停止轮询。
    setGenRunId(null);
    setGenRun(null);
  }, [genRun?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // 成本确认弹窗对齐评测确认框;单次一个对话轮次,无 rates 估算 → 固定保守区间文案。
  const startGenerate = async () => {
    const hasCases = cases.length > 0;
    const ok = await confirmDialog({
      title: hasCases ? "AI 补充生成评测用例?" : "AI 生成评测用例?",
      body: (
        <CostBody
          lines={[
            `模型:${rates?.displayName ?? SKILL_RUN_MODEL}(平台锁定)`,
            "单次一个对话轮次:AI 读技能内容 + 你的真实使用记录起草用例",
            hasCases
              ? "在现有用例基础上补充不重复的新场景(灌入编辑器,保存前不写入技能库)"
              : "起草 3~5 个用例灌入下方编辑器,你审阅/修改后保存才写入技能库",
          ]}
          range="约 1~3 积分(一个对话轮次)"
          rates={null}
        />
      ),
      confirmText: hasCases ? "补充生成(接受消耗)" : "生成(接受消耗)",
    });
    if (!ok) return;
    setErr(null);
    try {
      const r = await api.generateSkillEvals(auth, skillName);
      setGenRunId(r.runId);
    } catch (e) {
      setErr(genErrMessage(e));
    }
  };

  const perDay = rates
    ? fmtCreditRange(estimateEvalRunCredits(Math.max(1, cases.length), 2, rates))
    : "少量积分";

  // 自动回归 opt-in:显式确认成本后写回 evals.json。
  // 保存失败必须回滚开关显示态 —— 否则界面写着「已开启」而服务端根本没写入,
  // 用户会以为自己每天在被扣费(或以为已开而其实没开)。
  const toggleAutoRegression = async () => {
    const next = !autoRegression;
    if (next) {
      const ok = await confirmDialog({
        title: "开启每日自动回归?",
        body: (
          <CostBody
            lines={[
              "平台每天自动跑一次本技能的评测,通过率下降时推送提醒到对话",
              `每天约消耗:${perDay}`,
              "不会自动改动技能内容,更不会自动开训练 —— 只提醒",
            ]}
            range={`${perDay} / 天`}
            rates={rates}
          />
        ),
        confirmText: "开启并接受每日消耗",
      });
      if (!ok) return;
    }
    const prev = autoRegression;
    setAutoRegression(next);
    const ok = await save(next);
    if (!ok) {
      setAutoRegression(prev);
      toast(next ? "开启失败,已保持关闭" : "关闭失败,已保持开启", "error");
      return;
    }
    toast(next ? "已开启每日自动回归" : "已关闭每日自动回归", "success");
  };

  if (loading)
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-44 rounded-md" />
        </div>
        <ListSkeleton rows={2} />
      </div>
    );

  const running = run && isActive(run);
  const runPct = run?.progress.total ? (run.progress.done / run.progress.total) * 100 : 0;

  return (
    <div className="flex flex-col gap-3">
      {confirmDialogEl}
      {err && (
        <Alert tone="danger" density="compact" onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {draftBanner && (
        <Alert tone="info" density="compact">
          AI 草稿已生成,请审阅修改后保存
        </Alert>
      )}

      {/* 用例编辑:标题与操作分两行(窄屏),操作可换行 —— 4 个按钮曾横向撑破整个管理中心。 */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-meta font-medium text-muted">评测用例</span>
          <Badge tone="neutral" size="sm">
            {cases.length}/5
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
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
          {/* 已有用例态:次级「补充生成」;生成中/评测中禁用(后端亦 409 排他)。 */}
          {writable && cases.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              loading={generating}
              onClick={startGenerate}
              disabled={!!running || cases.length >= 5}
            >
              {generating ? null : <Sparkles size={13} />}
              补充生成
            </Button>
          )}
          {writable && (
            <Button variant="secondary" size="sm" loading={saving} disabled={!dirty} onClick={() => save()}>
              {saved && !saving ? <Check size={13} /> : null}
              {saved ? "已保存" : "保存用例"}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={!!running}
            onClick={startRun}
            disabled={cases.length === 0 || generating}
            className="max-md:w-full"
          >
            {running ? null : <Play size={13} />}
            运行评测
          </Button>
        </div>
      </div>

      {/* 生成中进度(禁用运行评测与再次生成期间的可见反馈)。 */}
      {generating && (
        <Card tone="sunken" padding="sm" aria-live="polite" aria-atomic="true">
          <p className="flex items-center gap-2 text-body text-muted">
            <Spinner size={14} /> AI 正在起草评测用例…(约一个对话轮次,请稍候)
          </p>
        </Card>
      )}
      {cases.length === 0 ? (
        <Card tone="sunken" padding="none" className="border-dashed">
          <EmptyState
            icon={FlaskConical}
            title="还没有评测用例"
            hint="用例 = 一个真实任务 + 几条可判定的验收断言;它是「这个技能到底有没有用」的唯一事实标准。"
            action={
              writable ? (
                <div className="flex flex-col items-center gap-2">
                  <Button variant="primary" size="sm" loading={generating} disabled={!!running} onClick={startGenerate}>
                    {generating ? null : <Sparkles size={13} />}
                    AI 生成用例
                  </Button>
                  <p className="max-w-[19rem] text-meta text-muted">
                    从技能内容和你的真实使用记录起草,生成后可编辑;也可点上方「加用例」手动写。
                  </p>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {cases.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 用例可增删且 id 可为空,下标是此处唯一稳定键
            <li key={i}>
              <Card tone="sunken" padding="sm" className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={c.id}
                    disabled={!writable}
                    inputSize="sm"
                    aria-label={`用例 ${i + 1} 的 ID`}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCases((cs) => cs.map((x, j) => (j === i ? { ...x, id: v } : x)));
                      setDirty(true);
                    }}
                    className="w-full font-mono md:w-44"
                    placeholder="case-id"
                  />
                  {writable && (
                    <IconButton
                      variant="danger"
                      size="sm"
                      shape="square"
                      className="ml-auto"
                      aria-label={`删除用例 ${c.id || i + 1}`}
                      onClick={() => {
                        setCases((cs) => cs.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </div>
                <Field label="任务">
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
                  />
                </Field>
                <Field label="验收断言" hint="每行一条,例如:输出为英文且信息无遗漏 / 保留原文数字与单位">
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
                    className="font-mono"
                  />
                </Field>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* 运行进度 / 结果 */}
      {run && (
        <Card tone="sunken" padding="sm" className="flex flex-col gap-2">
          {running ? (
            <div className="flex flex-col gap-1.5" aria-live="polite" aria-atomic="true">
              <Progress
                value={runPct}
                size="sm"
                aria-label="评测进度"
                aria-valuetext={`${run.progress.done} / ${run.progress.total} 组`}
              />
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-muted">
                <Spinner size={14} />
                {run.status === "grading" ? "评分中" : "评测中"}({run.progress.done}/{run.progress.total} 组)…
                <span className="text-meta text-muted">本次运行不可中止</span>
              </p>
            </div>
          ) : run.status === "failed" ? (
            <Alert tone="danger" density="compact">
              评测失败:{run.error}
            </Alert>
          ) : (
            <EvalResultView run={run} rates={rates} />
          )}
          <UsageLine usage={run.usage} rates={rates} label={running ? "已消耗" : "本次消耗"} />
        </Card>
      )}

      {/* 上次结果(无进行中 run 时) */}
      {!run && lastRun?.benchmark && (
        <Card tone="sunken" padding="sm" className="flex flex-col gap-1">
          <p className="text-body font-medium text-fg">上次评测:{lastRun.benchmark.verdict}</p>
          <UsageLine usage={lastRun.usage} rates={rates} label="上次消耗" />
        </Card>
      )}

      {/* P3:自动回归 opt-in(每日持续扣费,故 label 必须写清代价) */}
      {writable && cases.length > 0 && (
        <Card tone="sunken" padding="sm" className="flex items-start gap-3">
          <Switch
            id={autoId}
            checked={autoRegression}
            disabled={saving}
            onCheckedChange={() => void toggleAutoRegression()}
          />
          <label htmlFor={autoId} className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-body font-medium text-fg">每日自动回归</span>
            <span className="block text-meta text-muted">
              每天约消耗 {perDay},通过率下降时推送提醒;默认关闭。
            </span>
          </label>
        </Card>
      )}
    </div>
  );
}

function EvalResultView({ run, rates }: { run: SkillEvalRun; rates: ModelRates | null }) {
  const [openCase, setOpenCase] = useState<string | null>(null);
  const idBase = useId();
  const b = run.benchmark;
  if (!b) return <p className="text-body text-muted">评测完成,但没有可用结果。</p>;
  const pct = (x?: number) => `${Math.round((x ?? 0) * 100)}%`;
  const armsShown = run.mode === "draft" ? (["with", "draft"] as const) : (["without", "with"] as const);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-fg">{b.verdict}</p>
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
          const panelId = `${idBase}-case-${c.id}`;
          return (
            <li key={c.id} className="rounded-md border border-border">
              <button
                type="button"
                onClick={() => setOpenCase(open ? null : c.id)}
                aria-expanded={open}
                aria-controls={panelId}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-meta text-muted outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
              >
                <ChevronRight size={13} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
                <span className="min-w-0 flex-1 truncate font-mono">{c.id}</span>
                {rs.map((r) => (
                  <span key={r.arm} className="shrink-0 text-caption text-muted">
                    {ARM_LABEL[r.arm]}{" "}
                    {r.error ? "✗错" : `${r.assertions.filter((a) => a.passed).length}/${r.assertions.length}`}
                  </span>
                ))}
              </button>
              {open && (
                <div id={panelId} className="border-t border-border px-2.5 py-2 text-meta">
                  {rs.map((r) => (
                    <div key={r.arm} className="mb-2">
                      <p className="mb-0.5 font-medium text-fg">{ARM_LABEL[r.arm]}</p>
                      {r.error ? (
                        <p className="text-danger">{r.error}</p>
                      ) : (
                        <ul className="flex flex-col gap-0.5">
                          {r.assertions.map((a, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: 断言无稳定 id,顺序即身份
                            <li key={i} className="flex items-start gap-1.5">
                              {a.passed ? (
                                <Check size={13} className="mt-0.5 shrink-0 text-success" />
                              ) : (
                                <X size={13} className="mt-0.5 shrink-0 text-danger" />
                              )}
                              <span className="min-w-0">
                                <span className="text-fg">{a.text}</span>
                                {a.evidence && <span className="block text-caption text-muted">{a.evidence}</span>}
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

/** 训练阶段顺序(与 gateway 的 phase 取值一致);未知 phase 不参与步骤条着色。 */
const TRAIN_PHASES = ["queued", "scanning_sessions", "evaluating", "drafting", "diff_ready"] as const;

const PHASE_LABEL: Record<string, string> = {
  queued: "排队中",
  scanning_sessions: "复盘近期会话",
  evaluating: "分析现有技能",
  drafting: "起草改进",
  diff_ready: "草稿就绪",
  done: "完成",
  failed: "失败",
};

/** 五阶段步骤条 —— 分钟级流程必须让用户看出「走到哪、还剩几步」。 */
function PhaseSteps({ phase }: { phase: string }) {
  const idx = TRAIN_PHASES.indexOf(phase as (typeof TRAIN_PHASES)[number]);
  return (
    <ol className="flex shrink-0 items-center gap-1" aria-hidden="true">
      {TRAIN_PHASES.map((p, i) => (
        <li
          key={p}
          className={cn(
            "size-1.5 rounded-full",
            idx >= 0 && i < idx && "bg-accent",
            idx >= 0 && i === idx && "animate-pulse bg-accent",
            (idx < 0 || i > idx) && "bg-border-strong",
          )}
        />
      ))}
    </ol>
  );
}

export function SkillTrainSection({
  auth,
  skillName,
  rates,
  onSkillChanged,
}: {
  auth: AuthSession;
  skillName: string;
  rates: ModelRates | null;
  /** 合并成功后通知外层:技能正文已变,缓存必须失效(否则「花了积分没生效」)。 */
  onSkillChanged?: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // 刷新/服务重启后找回未处理草稿时的提示条（info，非报错）。
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  // P3:启动响应带 feedbackRefs>0 → 提示本次训练命中了用户差评过的真实失败案例。
  const [feedbackNotice, setFeedbackNotice] = useState<string | null>(null);
  // 合并成功后留在原地的成功说明(Toast 会消失,这条告诉用户「接下来去哪看」)。
  const [mergedNotice, setMergedNotice] = useState<string | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();

  const trainFetcher = useCallback(
    () => (runId ? api.getSkillTrainRun(auth, runId) : Promise.reject(new Error("no run"))),
    [auth, runId],
  );
  const isActive = useCallback(
    (r: SkillTrainRun) => r.status === "queued" || r.status === "running",
    [],
  );
  const [run, setRun] = usePollingRun(runId ? trainFetcher : null, isActive);
  useTicker(!!run && isActive(run));

  // 挂载时从「全部训练 run」里找回本技能未完成/有草稿的 run（runId 原本只存
  // 组件 state，刷新即失联）。active → 恢复轮询；diff_ready → 恢复 diff 入口 + 提示。
  // 只补「找回入口」，不改成本披露/合并/放弃流程本身。
  useEffect(() => {
    let alive = true;
    api
      .listSkillTrainRuns(auth)
      .then((runs) => {
        if (!alive) return;
        const picked = pickResumableTrainRun(runs, skillName);
        if (!picked) return;
        setRunId(picked.run.runId);
        setRun(picked.run); // 立即渲染入口，轮询首拍会刷新为权威态。
        if (picked.kind === "draft") {
          setResumeNotice(
            "发现一个未处理的训练草稿（可能因页面刷新或服务重启中断），可继续查看差异并决定合并/放弃",
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth, skillName, setRun]);

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
            `模型:${rates?.displayName ?? SKILL_RUN_MODEL}(平台锁定,最高思考档)`,
            "AI 复盘你近期的真实会话,给这个技能起草改进(只产草稿,合并前不会改动技能)",
            "草稿产出后自动跑评测门:草稿 vs 现版实测对比,给出「是否值得合并」的量化结论",
            "开始后无法中止(可随时放弃草稿,但已产生的消耗不退)",
          ]}
          range={total}
          rates={rates}
          extra={
            <p className="text-meta text-muted">
              含训练 + 草稿评测两部分;若技能还没有评测用例,训练会一并提议用例(随草稿确认)。
            </p>
          }
        />
      ),
      confirmText: "开始训练(接受消耗)",
    });
    if (!ok) return;
    setErr(null);
    setResumeNotice(null);
    setFeedbackNotice(null);
    setMergedNotice(null);
    try {
      const r = await api.startSkillTrain(auth, skillName, { autoEval: true });
      setRunId(r.runId);
      // 旧后端不返回 feedbackRefs → undefined,不渲染提示(容错)。
      if (typeof r.feedbackRefs === "number" && r.feedbackRefs > 0) {
        setFeedbackNotice(
          `已找到 ${r.feedbackRefs} 条你差评过的真实使用记录,本次训练将优先分析这些失败案例`,
        );
      }
    } catch (e) {
      setErr(apiErrorMessage(e, "启动训练失败"));
    }
  };

  const discard = async () => {
    if (!runId) return;
    const ok = await confirmDialog({ title: "放弃本次训练与全部草稿?", confirmText: "放弃", danger: true });
    if (!ok) return;
    await api.discardSkillTrainRun(auth, runId).catch(() => {});
    setRunId(null);
    setRun(null);
    setResumeNotice(null);
    setFeedbackNotice(null);
    toast("已放弃本次训练草稿", "info");
  };

  return (
    <div className="flex flex-col gap-3">
      {confirmDialogEl}
      {err && (
        <Alert tone="danger" density="compact" onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}
      {resumeNotice && (
        <Alert tone="info" density="compact" onDismiss={() => setResumeNotice(null)}>
          {resumeNotice}
        </Alert>
      )}
      {feedbackNotice && (
        <Alert tone="info" density="compact" onDismiss={() => setFeedbackNotice(null)}>
          {feedbackNotice}
        </Alert>
      )}

      {!run && (
        <>
          {mergedNotice && (
            <Alert tone="success" density="compact" onDismiss={() => setMergedNotice(null)}>
              {mergedNotice}
            </Alert>
          )}
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-start md:justify-between">
            <p className="text-meta leading-relaxed text-muted">
              AI 复盘你近期的真实使用,起草这个技能的改进;草稿先过评测门(草稿 vs 现版实测),
              再由你决定是否合并 —— 技能库永远不会被自动改动。
            </p>
            <Button variant="primary" size="sm" onClick={start} className="shrink-0 max-md:w-full">
              <GraduationCap size={14} /> 训练优化
            </Button>
          </div>
        </>
      )}

      {run && (
        <Card tone="sunken" padding="sm" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2" aria-live="polite" aria-atomic="true">
            {isActive(run) ? (
              <Spinner size={14} />
            ) : run.status === "failed" ? (
              <X size={14} className="shrink-0 text-danger" />
            ) : (
              <Check size={14} className="shrink-0 text-success" />
            )}
            <span className="text-body font-medium text-fg">
              {PHASE_LABEL[run.phase] ?? run.phase}
              {isActive(run) && `(已 ${run.toolCalls} 步)`}
            </span>
            <PhaseSteps phase={run.phase} />
            {isActive(run) && (
              <span className="text-meta text-muted">
                已运行 {fmtElapsed(Date.now() - run.startedAt)} · 不可中止
              </span>
            )}
            {(run.status === "diff_ready" || isActive(run)) && (
              <Button variant="ghost" size="sm" className="ms-auto" onClick={discard}>
                放弃
              </Button>
            )}
          </div>
          {run.summary && !isActive(run) && <p className="text-meta text-muted">{run.summary}</p>}
          <UsageLine usage={run.usage} rates={rates} label={isActive(run) ? "已消耗" : "训练消耗"} />
          {run.status === "failed" && (
            <Alert tone="danger" density="compact">
              {run.error}
            </Alert>
          )}
          {run.status === "diff_ready" && (
            <TrainDraftView
              auth={auth}
              run={run}
              rates={rates}
              onMerged={() => {
                setRunId(null);
                setRun(null);
                setResumeNotice(null);
                setFeedbackNotice(null);
                setMergedNotice(
                  "已合并到技能库,可在「正文」页签查看新版本;旧版已存入「历史」,可随时回滚。",
                );
                toast("已合并到技能库", "success");
                onSkillChanged?.();
              }}
              confirmDialog={confirmDialog}
            />
          )}
        </Card>
      )}
    </div>
  );
}

// ── 草稿审阅(行级 diff) ─────────────────────────────────────────────────────

type DiffLine = { type: "same" | "add" | "del"; text: string };

/** LCS 单元格预算:超出就不做 diff(退回并排原文),避免超大 SKILL.md 卡住主线程。 */
const DIFF_CELL_BUDGET = 400_000;
/** 连续未变更行超过这个数就折叠 —— 审阅关心的是变化,不是原文全文。 */
const CONTEXT_FOLD_MIN = 8;

/** 行级 LCS diff。返回 null = 体量超预算,调用方退回「现版 / 草稿」并排原文。 */
export function diffLines(oldText: string, newText: string): DiffLine[] | null {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  if (n * m > DIFF_CELL_BUDGET) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function DraftDiff({ current, draft }: { current: string; draft: string }) {
  const lines = useMemo(() => diffLines(current, draft), [current, draft]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  // 连续同类行成组:未变更的长段落可折叠。
  const groups = useMemo(() => {
    if (!lines) return null;
    const out: Array<{ same: boolean; lines: DiffLine[] }> = [];
    for (const l of lines) {
      const same = l.type === "same";
      const tail = out[out.length - 1];
      if (tail && tail.same === same) tail.lines.push(l);
      else out.push({ same, lines: [l] });
    }
    return out;
  }, [lines]);

  if (!lines || !groups) {
    // 体量超预算:退回并排原文(md+ 左右两栏),仍然默认展开、仍然一屏可比。
    return (
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-muted">现版</span>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-code px-2.5 py-2 font-mono text-meta text-muted">
            {current || "(空)"}
          </pre>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-caption font-medium text-muted">草稿</span>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-code px-2.5 py-2 font-mono text-meta text-fg">
            {draft || "(空)"}
          </pre>
        </div>
      </div>
    );
  }

  const added = lines.filter((l) => l.type === "add").length;
  const removed = lines.filter((l) => l.type === "del").length;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="success" size="sm">
          +{added} 行
        </Badge>
        <Badge tone="danger" size="sm">
          -{removed} 行
        </Badge>
        {added === 0 && removed === 0 && <span className="text-caption text-muted">正文没有变化</span>}
      </div>
      <div className="overflow-hidden rounded-md bg-code py-1 font-mono text-meta leading-relaxed">
        {groups.map((g, gi) =>
          g.same && g.lines.length > CONTEXT_FOLD_MIN && !expanded.has(gi) ? (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: 分组由 diff 结果顺序决定,下标即身份
              key={gi}
              type="button"
              onClick={() =>
                setExpanded((cur) => {
                  const next = new Set(cur);
                  next.add(gi);
                  return next;
                })
              }
              className="block w-full px-2.5 py-1 text-left text-caption text-accent outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
            >
              … {g.lines.length} 行未变更(点击展开)
            </button>
          ) : (
            g.lines.map((l, li) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: diff 行无稳定 id,位置即身份
                key={`${gi}-${li}`}
                className={cn(
                  "whitespace-pre-wrap break-words px-2.5",
                  l.type === "add" && "bg-success-soft text-success",
                  l.type === "del" && "bg-danger-soft text-danger",
                  l.type === "same" && "text-muted",
                )}
              >
                <span aria-hidden="true" className="select-none opacity-70">
                  {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                </span>
                {l.text || " "}
              </div>
            ))
          ),
        )}
      </div>
    </div>
  );
}

function TrainDraftView({
  auth,
  run,
  rates,
  onMerged,
  confirmDialog,
}: {
  auth: AuthSession;
  run: SkillTrainRun;
  rates: ModelRates | null;
  onMerged: () => void;
  confirmDialog: (opts: { title: string; body?: ReactNode; confirmText?: string; danger?: boolean }) => Promise<boolean>;
}) {
  const [drafts, setDrafts] = useState<SkillDraftSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
  const [detail, setDetail] = useState<SkillDraftDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [showDiff, setShowDiff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    api
      .listSkillDrafts(auth, run.runId)
      .then((ds) => {
        if (!alive) return;
        setDrafts(ds);
        setSelected(ds[0]?.name ?? null);
        if (!ds[0]) setDetailLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(apiErrorMessage(e, "加载草稿失败"));
        setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, run.runId]);

  // 逐份拉详情:多份草稿现在可切换审阅(此前只拉第一份,却整 run 合并全部)。
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setDetailLoading(true);
    api
      .getSkillDraft(auth, run.runId, selected)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setViewed((cur) => {
          if (cur.has(selected)) return cur;
          const next = new Set(cur);
          next.add(selected);
          return next;
        });
      })
      .catch((e) => alive && setErr(apiErrorMessage(e, "加载草稿失败")))
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, run.runId, selected]);

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

  const unviewed = drafts.filter((d) => !viewed.has(d.name));

  const merge = async () => {
    const evalNote = evalRun?.benchmark?.verdict
      ? `评测门结论:${evalRun.benchmark.verdict}`
      : "本草稿未经评测(无用例或评测未完成)。";
    const ok = await confirmDialog({
      title: "合并草稿到技能库?",
      body: (
        <div className="flex flex-col gap-2 text-body">
          <p className="text-muted">{evalNote} 合并会覆盖现版(旧版自动存入历史,可回滚)。</p>
          <p className="font-medium text-fg">本次将合并 {drafts.length} 项:</p>
          <ul className="list-disc pl-4 text-muted">
            {drafts.map((d) => (
              <li key={d.name}>
                {d.name}（{OP_LABEL[d.op] ?? d.op}）
                {!viewed.has(d.name) && <span className="text-warning"> · 你还没查看</span>}
              </li>
            ))}
          </ul>
          {unviewed.length > 0 && (
            <p className="font-medium text-warning">其中 {unviewed.length} 项你还没查看。</p>
          )}
        </div>
      ),
      confirmText: "合并",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.mergeSkillTrainRun(auth, run.runId);
      if (!r.ok) setErr(r.results.map((x) => x.error).filter(Boolean).join("; ") || "合并失败");
      else onMerged();
    } catch (e) {
      setErr(apiErrorMessage(e, "合并失败"));
    } finally {
      setBusy(false);
    }
  };

  const sendComment = async () => {
    const c = comment.trim();
    if (!c || !detail) return;
    const range = rates ? fmtCreditRange(estimateTrainRunCredits(rates)) : "少量";
    const ok = await confirmDialog({
      title: "让 AI 按评论修订草稿?",
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
    setErr(null);
    try {
      await api.commentSkillDraft(auth, run.runId, detail.draft.record.name, c);
      setComment("");
      // 成功不再塞进 err 通道靠字符串前缀判色 —— 瞬时提示走 Toast,不挂死在版面上。
      toast("已提交修订,训练会话重新运行中,稍后回来看新草稿", "success");
    } catch (e) {
      setErr(apiErrorMessage(e, "提交修订失败"));
    } finally {
      setBusy(false);
    }
  };

  if (!detail)
    return (
      <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
        {err && (
          <Alert tone="danger" density="compact">
            {err}
          </Alert>
        )}
        {detailLoading && !err && (
          <>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-24 rounded-md" />
          </>
        )}
        {!detailLoading && !err && <p className="text-meta text-muted">本次训练没有产出可用草稿。</p>}
      </div>
    );

  const d = detail.draft;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
      {err && (
        <Alert tone="danger" density="compact" onDismiss={() => setErr(null)}>
          {err}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <FlaskConical size={14} className="shrink-0 text-accent" />
        <span className="text-body font-medium text-fg">草稿:{d.record.name}</span>
        <Badge tone="accent">{OP_LABEL[d.record.op] ?? d.record.op}</Badge>
        {drafts.length > 1 && <Badge tone="neutral">共 {drafts.length} 份草稿</Badge>}
        {d.evalsJson && <Badge tone="info">附带评测用例</Badge>}
        {evalRun &&
          (evalActive(evalRun) ? (
            <Badge tone="warning">
              <Spinner size={11} /> 评测门运行中
            </Badge>
          ) : evalRun.benchmark ? (
            <Badge tone={evalRun.benchmark.verdict.startsWith("草稿更差") ? "danger" : evalRun.benchmark.verdict.startsWith("草稿更好") ? "success" : "info"}>
              {evalRun.benchmark.verdict}
            </Badge>
          ) : null)}
      </div>

      {/* 多份草稿:逐份切换审阅。「看一份、合三份」是这块此前最危险的信息缺口。 */}
      {drafts.length > 1 && (
        <Tabs
          aria-label="切换草稿"
          layout="grid"
          value={selected ?? drafts[0].name}
          onValueChange={setSelected}
          items={drafts.map((x) => ({
            value: x.name,
            label: `${viewed.has(x.name) ? "✓ " : ""}${x.name} · ${OP_LABEL[x.op] ?? x.op}`,
          }))}
        />
      )}

      {d.record.rationale && <p className="text-meta text-muted">理由:{d.record.rationale}</p>}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption font-medium text-muted">
            {detail.current ? "与现版的差异" : "新建技能正文"}
          </span>
          {detail.current && (
            <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? "收起对照" : "展开对照"}
            </Button>
          )}
        </div>
        {detailLoading ? (
          <Skeleton className="h-40 rounded-md" />
        ) : detail.current ? (
          showDiff && <DraftDiff current={detail.current.body ?? ""} draft={d.body} />
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-code px-2.5 py-2 font-mono text-meta text-fg">
            {d.body}
          </pre>
        )}
      </div>

      {evalRun && !evalActive(evalRun) && evalRun.benchmark && (
        <Card padding="sm" className="flex flex-col gap-2">
          <EvalResultView run={evalRun} rates={rates} />
          <UsageLine usage={evalRun.usage} rates={rates} label="评测门消耗" />
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" loading={busy} onClick={merge} className="max-md:w-full">
          {busy ? null : <Check size={13} />} 合并到技能库
        </Button>
        {unviewed.length > 0 && (
          <span className="text-meta text-warning">还有 {unviewed.length} 份草稿未查看</span>
        )}
      </div>
      <Field label="对草稿留评论让 AI 修订" hint="修订会继续同一训练会话,需再次确认消耗。">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={2}
          placeholder="例:步骤 3 缺了鉴权说明,补上;删掉第 5 条空话"
        />
      </Field>
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        onClick={sendComment}
        disabled={!comment.trim()}
        className="self-start max-md:w-full"
      >
        提交修订
      </Button>
    </div>
  );
}
