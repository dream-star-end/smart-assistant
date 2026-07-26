import {
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  Clock,
  PauseCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorMessage } from "../../lib/api";
import {
  buildSchedule,
  cronHuman,
  SCHEDULE_MODE_LABELS,
  type ScheduleMode,
  scheduleToPreset,
  WEEKDAY_OPTIONS,
} from "../../lib/cron";
import type { AuthSession, CronJob } from "../../lib/types";
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
  PanelHeader,
  Select,
  Switch,
  Textarea,
  TimeAgo,
  Toolbar,
  Tooltip,
  useConfirm,
  useToast,
} from "../ui";

/** 送达方式。hint 常驻在表单里 —— 「仅记录」这个词用户无从判断结果去了哪里。 */
const DELIVER_OPTIONS = [
  {
    value: "webchat",
    label: "网页对话",
    hint: "结果会作为一条新消息出现在网页对话里。",
  },
  {
    value: "telegram",
    label: "Telegram",
    hint: "结果推送到你绑定的 Telegram —— 需先在「设置 → 偏好」里打开 Telegram 通知。",
  },
  { value: "local", label: "仅记录", hint: "只写进智能体的记录，不会主动通知你。" },
] as const;

const DELIVER_SELECT = DELIVER_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

const WEEKDAY_SELECT = WEEKDAY_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

/**
 * 时区/计时口径说明**常驻**（按 mode 换措辞）。改造前它只在 daily/weekly/advanced 下出现，
 * 切到「某时一次」时凭空消失 —— 而那一档恰恰是唯一读设备本地时钟的，最需要解释。
 */
const MODE_HINT: Record<ScheduleMode, string> = {
  daily: "按北京时间（服务时区）执行。",
  weekly: "按北京时间（服务时区）执行。",
  advanced: "按北京时间（服务时区）执行。",
  once: "按你设备的本地时间选择，保存时自动换算成北京时间。",
  after: "从现在开始计时。",
};

/** 未填完 ≠ 填错：这两句走 faint 引导语气，不进 danger。 */
const INCOMPLETE_HINT: Partial<Record<ScheduleMode, string>> = {
  once: "选择日期时间后即可创建。",
  advanced: "填写 Cron 表达式后即可创建。",
};

const CRON_EXAMPLES = [
  { cron: "*/30 * * * *", label: "每 30 分钟" },
  { cron: "0 9 1 * *", label: "每月 1 号 9:00" },
  { cron: "0 18 * * 5", label: "每周五 18:00" },
];

/** 空态预设：把「我该写什么」一并解决，点一下就是填好的表单。 */
const QUICK_PRESETS: { chip: string; seed: FormSeed }[] = [
  {
    chip: "每天 9:00 日报",
    seed: {
      mode: "daily",
      time: "09:00",
      label: "每日早报",
      prompt: "汇总我昨天的进展与今天要做的事，简明推送给我。",
    },
  },
  {
    chip: "每周一 10:00 周报",
    seed: {
      mode: "weekly",
      time: "10:00",
      weekday: 1,
      label: "每周汇总",
      prompt: "汇总本周进展、风险与下周计划，整理成周报推送给我。",
    },
  },
  {
    chip: "每 30 分钟检查一次",
    seed: {
      mode: "advanced",
      cron: "*/30 * * * *",
      label: "定时检查",
      prompt: "检查一次我关注的更新，有变化再告诉我。",
    },
  },
];

/**
 * 任务的三态。改造前「停用」与「一次性已跑完」都是一个灰开关，用户从没关过它却发现
 * 开关是关的，界面上也没有「已完成」的说法 —— 只能猜是不是出错了。
 */
type JobStatus = "active" | "paused" | "done";

function jobStatus(job: CronJob): JobStatus {
  if (job.enabled !== false) return "active";
  // 一次性任务触发后由后端自动停用（cron.ts）：跑过 = 已完成，不是被人按停的。
  if (job.oneshot && job.lastRunAt) return "done";
  return "paused";
}

const STATUS_META = {
  active: { label: "启用中", tone: "success", icon: Clock, chip: "bg-success-soft text-success" },
  paused: { label: "已停用", tone: "neutral", icon: PauseCircle, chip: "bg-hover text-faint" },
  done: { label: "已完成", tone: "accent", icon: CheckCircle2, chip: "bg-accent-soft text-accent" },
} as const satisfies Record<
  JobStatus,
  { label: string; tone: "success" | "neutral" | "accent"; icon: typeof Clock; chip: string }
>;

function jobTitle(job: CronJob): string {
  return job.label || job.prompt || "未命名任务";
}

/** 读屏 aria-label / 确认弹窗标题统一截断口径 —— 无标题任务会把整段 prompt 塞进标题。 */
function shortTitle(s: string, max = 20): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function deliverLabel(v: string): string {
  return DELIVER_OPTIONS.find((o) => o.value === v)?.label || v;
}

/** 表单预填种子：空态预设 chip 与「再跑一次」共用。 */
type FormSeed = {
  mode?: ScheduleMode;
  time?: string;
  weekday?: number;
  minutes?: number;
  at?: string;
  cron?: string;
  label?: string;
  prompt?: string;
  deliver?: string;
};

/**
 * 定时任务中心：列出 / 启停 / 编辑 / 删除 / 新建 cron 任务（经容器代理 /api/cron*）。
 * 编辑走 PUT /api/cron/:id，schedule/prompt/label/deliver/oneshot 全量可改
 *（gateway updateJob 已支持；label 空串 = 清空标题）。
 *
 * ── 写路径为什么不再 refresh() 整表 ─────────────────────────────────────
 * 改造前启停/删除/新建/保存四条写路径共用一条 `setReload(n+1)`，useEffect 立刻
 * setLoading(true)，整张列表塌回居中 spinner：点一下开关，所有任务消失几秒再回来，
 * 滚动位置与展开中的编辑表单一并丢失，成功了也没有任何回执。
 * 现在：**乐观更新 + 局部替换 + Toast**，`loading` 只服务首屏（jobs === null）；
 * 写成功后 `reconcile()` 在后台静默重拉（不动 loading）只为回填后端算的 nextRunAt。
 */
export function CronPanel({ auth }: { auth: AuthSession }) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  /** 顶层 Alert 只承载「整表加载失败」；写操作的失败一律回到发起它的容器（行 → toast / 表单 → 内联）。 */
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createSeed, setCreateSeed] = useState<FormSeed | null>(null);
  const [editSeed, setEditSeed] = useState<FormSeed | null>(null);
  /** 表单实例身份：换种子（预设 chip / 再跑一次）必须重挂表单才能吃到新初值。 */
  const [formNonce, setFormNonce] = useState(0);
  /** 请求飞行中的行：该行的开关/删除禁用，防连点重复发 PUT。 */
  const [pending, setPending] = useState<string[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showRest, setShowRest] = useState(false);
  const [confirmDialog, confirmDialogEl] = useConfirm();
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => {
    // 每次挂载都置回 true —— StrictMode 下 ref 跨「卸载再挂载」保留，只在 cleanup 置 false 会永久失效。
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    api
      .listCron(auth)
      .then((j) => {
        if (alive) setJobs(j);
      })
      .catch((e) => {
        if (alive) setErr(apiErrorMessage(e, "加载定时任务失败"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  /** 首屏重试：唯一还会把面板塌回骨架的入口（此时本来也没有内容可保留）。 */
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  /**
   * 后台对账：写成功后静默重拉，只为回填 nextRunAt（后端算的，前端无法乐观推导）。
   * 刻意不动 loading、不报错 —— 界面上已是乐观值，对账失败下次进面板自然纠正。
   */
  const reconcile = useCallback(async () => {
    try {
      const fresh = await api.listCron(auth);
      if (mounted.current) setJobs(fresh);
    } catch {
      /* 静默 */
    }
  }, [auth]);

  const markPending = useCallback((id: string, on: boolean) => {
    setPending((cur) =>
      on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id),
    );
  }, []);

  const patchJob = useCallback((id: string, patch: Partial<CronJob>) => {
    setJobs((cur) => cur?.map((j) => (j.id === id ? { ...j, ...patch } : j)) ?? cur);
  }, []);

  const toggle = useCallback(
    async (job: CronJob) => {
      const next = job.enabled === false;
      const name = shortTitle(jobTitle(job));
      markPending(job.id, true);
      // 乐观：先落态，失败再回滚 —— 开关必须立刻响应，不能等一次网络往返。
      patchJob(job.id, { enabled: next, nextRunAt: next ? undefined : null });
      try {
        await api.updateCron(auth, job.id, { enabled: next });
        toast(next ? `已启用「${name}」` : `已停用「${name}」`, "success");
        // 停用会让该行落到折叠分组里；行会「消失」，所以顺手把分组展开。
        if (!next) setShowRest(true);
        void reconcile();
      } catch (e) {
        patchJob(job.id, { enabled: job.enabled, nextRunAt: job.nextRunAt });
        toast(apiErrorMessage(e, "操作失败"), "error");
      } finally {
        if (mounted.current) markPending(job.id, false);
      }
    },
    [auth, markPending, patchJob, reconcile, toast],
  );

  const remove = useCallback(
    async (job: CronJob) => {
      const name = shortTitle(jobTitle(job));
      const ok = await confirmDialog({
        title: `删除定时任务「${name}」？`,
        body: "删除后该任务不再执行，且无法恢复。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      markPending(job.id, true);
      try {
        await api.deleteCron(auth, job.id);
        setJobs((cur) => cur?.filter((j) => j.id !== job.id) ?? cur);
        setEditingId((cur) => (cur === job.id ? null : cur));
        toast(`已删除「${name}」`, "success");
      } catch (e) {
        toast(apiErrorMessage(e, "删除失败"), "error");
      } finally {
        if (mounted.current) markPending(job.id, false);
      }
    },
    [auth, confirmDialog, markPending, toast],
  );

  const startCreate = useCallback((seed?: FormSeed) => {
    setCreateSeed(seed ?? null);
    setEditingId(null);
    setCreating(true);
    setFormNonce((n) => n + 1);
  }, []);

  const startEdit = useCallback((job: CronJob, seed?: FormSeed) => {
    setCreating(false);
    setEditSeed(seed ?? null);
    // 再点一次铅笔 = 收起；带种子进来（再跑一次）则强制展开并重挂表单。
    setEditingId((cur) => (cur === job.id && !seed ? null : job.id));
    setFormNonce((n) => n + 1);
  }, []);

  const handleCreated = useCallback(
    (saved: CronJob | null) => {
      setCreating(false);
      setCreateSeed(null);
      // 后端按创建顺序返回（gateway listJobs 直读 yaml 顺序），故追加到末尾即与对账结果一致。
      if (saved) {
        setJobs((cur) => (cur ? [...cur, saved] : [saved]));
        setHighlightId(saved.id);
      }
      toast("已创建定时任务", "success");
      void reconcile();
    },
    [reconcile, toast],
  );

  const handleUpdated = useCallback(
    (saved: CronJob) => {
      setEditingId(null);
      setEditSeed(null);
      patchJob(saved.id, saved);
      toast("已保存修改", "success");
      void reconcile();
    },
    [patchJob, reconcile, toast],
  );

  const total = jobs?.length ?? 0;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!jobs) return [];
    if (!q) return jobs;
    return jobs.filter((j) =>
      `${j.label ?? ""} ${j.prompt ?? ""} ${cronHuman(j.schedule)} ${j.schedule ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [jobs, query]);
  const activeJobs = filtered.filter((j) => jobStatus(j) === "active");
  const restJobs = filtered.filter((j) => jobStatus(j) !== "active");
  // 没有进行中的任务时强制展开，否则整张列表看起来是空的。
  const restOpen = showRest || activeJobs.length === 0;

  const renderJob = (job: CronJob) => {
    const status = jobStatus(job);
    const meta = STATUS_META[status];
    const StatusIcon = meta.icon;
    const title = jobTitle(job);
    const name = shortTitle(title);
    const rowBusy = pending.includes(job.id);
    const human = job.schedule ? cronHuman(job.schedule) : "";
    // 翻得出中文就只显示中文，裸 cron 收进 Tooltip；翻不出来时原串本身才是唯一信息。
    const translated = !!human && human !== job.schedule;
    return (
      <li key={job.id}>
        <Card
          padding="none"
          tone={status === "active" ? "default" : "sunken"}
          className={cn("overflow-hidden", job.id === highlightId && "animate-in")}
        >
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3.5 py-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                meta.chip,
              )}
            >
              <StatusIcon size={15} />
            </span>
            <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-section font-medium text-fg">{title}</span>
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>
              </div>
              {/* 二级：这个任务什么时候跑 —— 一眼要看到的就这一行。 */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-fg">
                {human &&
                  (translated ? (
                    <Tooltip content={`Cron：${job.schedule}`}>
                      <span className="cursor-default">{human}</span>
                    </Tooltip>
                  ) : (
                    <code className="font-mono">{human}</code>
                  ))}
                {status === "active" && job.nextRunAt ? (
                  <span className="text-muted">
                    {/* nextRunAt 是未来时刻,但它会过期:调度器落后、容器没起、任务卡住时,
                        后端回填的这个值可能已经落在过去。此时若照常渲染相对时间,用户会看到
                        「下次 2 小时前」这种自相矛盾的话。过期一律说「即将执行」——
                        它既诚实(确实该跑了还没跑)又不制造困惑。 */}
                    {new Date(job.nextRunAt).getTime() <= Date.now() ? (
                      "即将执行"
                    ) : (
                      <>
                        下次 <TimeAgo value={job.nextRunAt} />
                      </>
                    )}
                  </span>
                ) : null}
              </div>
              {/* 三级：属性与历史。 */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-faint">
                {job.oneshot && status !== "done" && <Badge size="sm">一次性</Badge>}
                {job.deliver && (
                  <Badge size="sm" tone="accent">
                    {deliverLabel(job.deliver)}
                  </Badge>
                )}
                {job.lastRunAt ? (
                  <span>
                    上次 <TimeAgo value={job.lastRunAt} />
                  </span>
                ) : (
                  <span>尚未执行过</span>
                )}
              </div>
              {job.label && job.prompt && job.prompt !== job.label && (
                <p className="line-clamp-2 text-meta text-muted">{job.prompt}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
              {status === "done" ? (
                // 已完成的一次性任务：把开关拨回去毫无意义（那个时刻已经过去），
                // 给一条真出口 —— 打开编辑表单并切到「某时一次」，选个新时间即可重跑。
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => startEdit(job, { mode: "once", at: "" })}
                >
                  <RotateCcw size={13} />
                  再跑一次
                </Button>
              ) : (
                <Switch
                  checked={status === "active"}
                  disabled={rowBusy}
                  onCheckedChange={() => toggle(job)}
                  aria-label={`启用「${name}」`}
                />
              )}
              <IconButton
                size="sm"
                shape="square"
                variant="muted"
                aria-label={`编辑「${name}」`}
                onClick={() => startEdit(job)}
                className={cn(editingId === job.id && "bg-accent-soft text-accent")}
              >
                <Pencil size={14} />
              </IconButton>
              <IconButton
                size="sm"
                shape="square"
                variant="danger"
                aria-label={`删除「${name}」`}
                disabled={rowBusy}
                onClick={() => remove(job)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
          {editingId === job.id && (
            <div className="border-t border-border">
              <CronForm
                key={`edit-${job.id}-${formNonce}`}
                auth={auth}
                job={job}
                seed={editSeed}
                onCancel={() => setEditingId(null)}
                onSaved={(saved) => saved && handleUpdated(saved)}
              />
            </div>
          )}
        </Card>
      </li>
    );
  };

  return (
    <div className="flex flex-col">
      {confirmDialogEl}
      <PanelHeader
        title="定时任务"
        hint="让智能体到点主动干活，并把结果按你选的方式推送。"
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (creating ? setCreating(false) : startCreate())}
          >
            {creating ? <X size={14} /> : <Plus size={14} />}
            {creating ? "取消" : "新建"}
          </Button>
        }
      />

      {creating && (
        <div className="px-4 pb-3">
          <Card tone="sunken">
            <CronForm
              key={`create-${formNonce}`}
              auth={auth}
              seed={createSeed}
              onCancel={() => setCreating(false)}
              onSaved={handleCreated}
            />
          </Card>
        </div>
      )}

      {err && jobs === null && (
        <div className="px-4 pb-2">
          <Alert
            tone="danger"
            density="compact"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      )}

      {loading && jobs === null ? (
        <div className="px-4 pb-4">
          <ListSkeleton rows={3} />
        </div>
      ) : err && jobs === null ? null : total === 0 ? (
        <EmptyState
          icon={Clock}
          title="还没有定时任务"
          hint="到点让智能体自动跑一件事，并把结果推给你。也可以在对话里直接说「每天 9 点推送…」。"
          action={
            <div className="flex flex-col items-center gap-2.5">
              <Button variant="primary" size="sm" onClick={() => startCreate()}>
                <Plus size={14} />
                创建第一个定时任务
              </Button>
              <div className="flex flex-wrap justify-center gap-1.5">
                {QUICK_PRESETS.map((p) => (
                  <Button
                    key={p.chip}
                    variant="subtle"
                    size="sm"
                    shape="pill"
                    onClick={() => startCreate(p.seed)}
                  >
                    {p.chip}
                  </Button>
                ))}
              </div>
            </div>
          }
        />
      ) : (
        <>
          {total > 8 && (
            <Toolbar
              count={filtered.length}
              search={query}
              onSearchChange={setQuery}
              searchPlaceholder="搜索任务标题 / 指令"
              debounceMs={150}
            />
          )}
          {/* 有工具条时才补上顶部留白;没有时由 PanelHeader 的 py-3 提供节奏。 */}
          <ul className={cn("flex flex-col gap-2 px-4 pb-4", total > 8 && "pt-3")}>
            {filtered.length === 0 ? (
              <li className="flex flex-col items-center gap-2 py-8 text-meta text-muted">
                <span>没有匹配「{query.trim()}」的任务</span>
                <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                  清除筛选
                </Button>
              </li>
            ) : (
              <>
                {activeJobs.map(renderJob)}
                {restJobs.length > 0 && (
                  <li>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-1.5 px-2 text-faint"
                      aria-expanded={restOpen}
                      onClick={() => setShowRest((v) => !v)}
                    >
                      <ChevronRight
                        size={14}
                        aria-hidden="true"
                        className={cn("transition-transform", restOpen && "rotate-90")}
                      />
                      已停用 / 已完成 · {restJobs.length}
                    </Button>
                  </li>
                )}
                {restOpen && restJobs.map(renderJob)}
              </>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * 新建 / 编辑共用表单。编辑态（传入 job）：预填全部字段；schedule 能还原成
 * 每天/每周 预设就还原，否则落高级 cron（并给出解释与「改用友好模式」出口）。
 * 送达方式与一次性属性同样可改；把一次性改回重复时若任务已因触发被自动停用，
 * 会随保存一并重新启用。
 *
 * 失败一律**内联**报在本表单底部（发起它的容器内）：改造前错误被扔到面板顶部的
 * 顶层 Alert 里，列表一长就在视口之外，用户只会觉得「点了没反应」。
 */
function CronForm({
  auth,
  job,
  seed,
  onCancel,
  onSaved,
}: {
  auth: AuthSession;
  job?: CronJob;
  seed?: FormSeed | null;
  onCancel: () => void;
  /** 创建时后端可能不回显 job（此时给 null，由调用方走后台对账补齐）。 */
  onSaved: (saved: CronJob | null) => void;
}) {
  const editing = !!job;
  const preset = editing ? scheduleToPreset(job?.schedule) : null;
  /** 编辑态且还原不出友好预设（一次性/复杂 cron）：要给解释，不能把人直接扔进裸表达式。 */
  const unrestorable = editing && !preset;

  const [mode, setMode] = useState<ScheduleMode>(
    seed?.mode ?? (editing ? (preset?.mode ?? "advanced") : "daily"),
  );
  const [time, setTime] = useState(seed?.time ?? preset?.time ?? "09:00");
  const [weekday, setWeekday] = useState(
    seed?.weekday ?? (preset?.mode === "weekly" ? preset.weekday : 1),
  );
  const [minutes, setMinutes] = useState(seed?.minutes ?? 10);
  const [at, setAt] = useState(seed?.at ?? "");
  const [cron, setCron] = useState(seed?.cron ?? job?.schedule ?? "0 9 * * *");
  const [advOneshot, setAdvOneshot] = useState(editing ? !!job?.oneshot : false);
  const [label, setLabel] = useState(seed?.label ?? job?.label ?? "");
  const [prompt, setPrompt] = useState(seed?.prompt ?? job?.prompt ?? "");
  const [deliver, setDeliver] = useState(seed?.deliver ?? job?.deliver ?? "webchat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 还没填 ≠ 填错：这两种状态以前共用同一个灰色文本槽，切到「某时一次」还没输入
  // 就先弹「请选择日期时间」，把引导写成了报错。
  const incomplete = (mode === "once" && !at.trim()) || (mode === "advanced" && !cron.trim());

  // 实时把当前表单解析成 { 人类可读, cron, 是否一次性 }；非法时给出原因。
  const preview = useMemo(() => {
    try {
      const built = buildSchedule(mode, { time, weekday, minutes, at, cron, oneshot: advOneshot });
      const human = cronHuman(built.schedule);
      return {
        ok: true as const,
        schedule: built.schedule,
        human,
        oneshot: built.oneshot,
        // cronHuman 解析不了就原样回退 —— 这时预览与用户刚敲的一字不差，看起来像「已确认」，
        // 实际是解析失败，必须换成 warning 语气点破。
        unparsed: human.trim() === built.schedule.trim(),
      };
    } catch (e) {
      return { ok: false as const, msg: (e as Error).message };
    }
  }, [mode, time, weekday, minutes, at, cron, advOneshot]);

  /** 排程非法时错误贴在**出错的那个控件**下（Field.error 自动接 aria-invalid/describedby）。 */
  const scheduleError = !incomplete && !preview.ok ? preview.msg : undefined;
  const canSubmit = prompt.trim().length > 0 && preview.ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const text = prompt.trim();
    if (!text) return setError("请填写内容 / 指令");
    if (!preview.ok) return setError(preview.msg);
    setBusy(true);
    setError(null);
    try {
      if (editing && job) {
        const nextLabel = label.trim();
        const patch: Record<string, unknown> = {
          schedule: preview.schedule,
          prompt: text,
          label: nextLabel,
          deliver,
          oneshot: preview.oneshot,
        };
        // 停用中的一次性任务两种重新启用场景：
        //  ① 改回重复 —— 它多半是触发后被后端自动停用的（既有行为）；
        //  ② 已跑完（有 lastRunAt）又改了时间 —— 用户就是要它再跑一次，
        //     不重新启用的话保存完仍是停用态，新时间永远不会到达，界面上却看不出异常。
        const reEnable =
          job.enabled === false && !!job.oneshot && (!preview.oneshot || !!job.lastRunAt);
        if (reEnable) patch.enabled = true;
        await api.updateCron(auth, job.id, patch);
        onSaved({
          ...job,
          schedule: preview.schedule,
          prompt: text,
          label: nextLabel,
          deliver,
          oneshot: preview.oneshot,
          enabled: reEnable ? true : job.enabled,
          // 排程变了，旧的 nextRunAt 一定是错的；由调用方的后台对账回填。
          nextRunAt: undefined,
        });
      } else {
        const res = await api.createCron(auth, {
          schedule: preview.schedule,
          prompt: text,
          label: label.trim() || undefined,
          deliver,
          oneshot: preview.oneshot,
        });
        onSaved(res.job ?? null);
      }
    } catch (e) {
      setError(apiErrorMessage(e, editing ? "保存失败" : "创建失败"));
    } finally {
      setBusy(false);
    }
  };

  const deliverHint = DELIVER_OPTIONS.find((o) => o.value === deliver)?.hint;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3.5">
      {/* 飞行中锁住输入：否则用户在请求途中改了字段，不知道存进去的是哪一版。 */}
      <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <Field label="时间" className="w-36">
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as ScheduleMode)}
              options={SCHEDULE_MODE_LABELS}
              inputSize="sm"
            />
          </Field>
          {(mode === "daily" || mode === "weekly") && (
            <Field label="几点" className="w-32" error={scheduleError}>
              <Input
                type="time"
                inputSize="sm"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </Field>
          )}
          {mode === "weekly" && (
            <Field label="星期" className="w-32">
              <Select
                value={String(weekday)}
                onValueChange={(v) => setWeekday(Number(v))}
                options={WEEKDAY_SELECT}
                inputSize="sm"
              />
            </Field>
          )}
          {mode === "after" && (
            <Field label="分钟后" className="w-28" error={scheduleError}>
              <Input
                type="number"
                min={1}
                inputSize="sm"
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </Field>
          )}
          {mode === "once" && (
            <Field label="日期时间" className="w-52" error={scheduleError}>
              <Input
                type="datetime-local"
                inputSize="sm"
                value={at}
                onChange={(e) => setAt(e.target.value)}
              />
            </Field>
          )}
          {mode === "advanced" && (
            <>
              <Field
                label="Cron 表达式"
                className="w-44"
                hint="分 时 日 月 周"
                error={scheduleError}
              >
                <Input
                  inputSize="sm"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 9 * * 1"
                  className="font-mono"
                />
              </Field>
              {/* 不用 <label> 包 Switch:Radix Switch 是 <button>,label 的点击转发对它无效
                  (点文字不会切换,是假的可点区),名字由 aria-label 承载即可。 */}
              <span className="flex select-none items-center gap-2 self-end pb-2 text-body text-fg">
                <Switch checked={advOneshot} onCheckedChange={setAdvOneshot} aria-label="一次性" />
                一次性
              </span>
            </>
          )}
        </div>

        <p className="text-caption text-faint">{MODE_HINT[mode]}</p>

        {mode === "advanced" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption text-faint">示例</span>
            {CRON_EXAMPLES.map((ex) => (
              <Button
                key={ex.cron}
                variant="subtle"
                size="sm"
                shape="pill"
                onClick={() => setCron(ex.cron)}
              >
                {ex.label}
              </Button>
            ))}
          </div>
        )}

        {unrestorable && mode === "advanced" && (
          <Alert
            tone="info"
            density="compact"
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (job?.oneshot) {
                    setMode("once");
                    setAt("");
                  } else {
                    setMode("daily");
                  }
                }}
              >
                改用友好模式
              </Button>
            }
          >
            这个任务按具体日期或复杂规则创建，只能用 Cron 表达式展示。
          </Alert>
        )}

        <Field label="标题（可选）">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="周报提醒" />
        </Field>
        <Field label="内容 / 指令" required>
          <Textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="到点要智能体做什么，例如：汇总本周进展并推送给我"
            className="resize-y"
          />
        </Field>
        <Field label="送达方式" hint={deliverHint}>
          <Select
            value={deliver}
            onValueChange={setDeliver}
            options={DELIVER_SELECT}
            inputSize="sm"
            className="sm:w-52"
          />
        </Field>
      </fieldset>

      {/* <output>(隐含 role=status)+ aria-live:改排程时读屏用户能听到预览变化。
          用 <output> 而非 p[role=status] 是跟随仓内既有写法(ListSkeleton / AuthGate)。 */}
      <output aria-live="polite" className="flex items-start gap-1.5 text-caption">
        {incomplete ? (
          <span className="text-faint">{INCOMPLETE_HINT[mode]}</span>
        ) : preview.ok ? (
          <>
            <CalendarCheck
              size={12}
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0", preview.unparsed ? "text-warning" : "text-faint")}
            />
            <span className={preview.unparsed ? "text-warning" : "text-faint"}>
              {preview.unparsed ? (
                <>
                  无法解析成自然语言，请确认这是你要的表达式：
                  <span className="font-mono font-medium text-fg">{preview.human}</span>
                </>
              ) : (
                <>
                  {editing ? "将改为：" : "将创建："}
                  <span className="font-medium text-fg">{preview.human}</span> ·{" "}
                  {preview.oneshot ? "只跑一次" : "重复执行"}
                </>
              )}
            </span>
          </>
        ) : null}
      </output>

      {error && (
        <Alert tone="danger" density="compact" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!canSubmit}>
          {editing ? "保存修改" : "创建任务"}
        </Button>
      </div>
    </form>
  );
}
