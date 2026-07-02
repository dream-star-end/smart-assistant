import { Clock, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
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
import { Alert, Button, EmptyState, PanelHeader, Spinner, Switch, useConfirm } from "../ui";

const DELIVER_OPTIONS = [
  { value: "webchat", label: "网页对话" },
  { value: "telegram", label: "Telegram" },
  { value: "local", label: "仅记录" },
];

/**
 * 定时任务中心：列出 / 启停 / 编辑 / 删除 / 新建 cron 任务（经容器代理 /api/cron*）。
 * 编辑走 PUT /api/cron/:id，schedule/prompt/label/deliver/oneshot 全量可改
 *（gateway updateJob 已支持；label 空串 = 清空标题）。
 */
export function CronPanel({ auth }: { auth: AuthSession }) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDialog, confirmDialogEl] = useConfirm();

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
        if (alive) setErr((e as Error).message || "加载定时任务失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, reload]);

  const refresh = useCallback(() => setReload((n) => n + 1), []);

  const toggle = useCallback(
    async (job: CronJob) => {
      try {
        await api.updateCron(auth, job.id, { enabled: !job.enabled });
        refresh();
      } catch (e) {
        setErr((e as Error).message || "操作失败");
      }
    },
    [auth, refresh],
  );

  const remove = useCallback(
    async (job: CronJob) => {
      const ok = await confirmDialog({
        title: `删除定时任务「${job.label || job.prompt || job.id}」?`,
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteCron(auth, job.id);
        refresh();
      } catch (e) {
        setErr((e as Error).message || "删除失败");
      }
    },
    [auth, refresh, confirmDialog],
  );

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
            onClick={() => {
              setCreating((v) => !v);
              setEditingId(null);
            }}
          >
            {creating ? <X size={14} /> : <Plus size={14} />}
            {creating ? "取消" : "新建"}
          </Button>
        }
      />

      {creating && (
        <CronForm
          auth={auth}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
          onError={setErr}
        />
      )}

      {err && (
        <div className="px-5 pb-2">
          <Alert tone="danger" className="text-[12.5px]">
            {err}
          </Alert>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-faint">
          <Spinner /> 加载定时任务…
        </div>
      ) : !jobs || jobs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="还没有定时任务"
          hint="在对话里说「每天 9 点推送…」即可自动创建，或点右上「新建」。"
        />
      ) : (
        <ul className="flex flex-col gap-1.5 px-4 pb-4">
          {jobs.map((job) => (
            <li key={job.id} className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className="flex items-start gap-3 px-3.5 py-3">
                <Clock size={16} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium text-fg">
                    {job.label || job.prompt || "（无标题）"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
                    {job.schedule && <span className="text-muted">{cronHuman(job.schedule)}</span>}
                    {job.oneshot && <span>· 一次性</span>}
                    {job.deliver && <span>· {deliverLabel(job.deliver)}</span>}
                    {job.nextRunAt && <span>· 下次 {fmtTime(job.nextRunAt)}</span>}
                    {job.lastRunAt && <span>· 上次 {fmtTime(job.lastRunAt)}</span>}
                    {job.schedule && <code className="font-mono text-faint">{job.schedule}</code>}
                  </div>
                  {job.label && job.prompt && job.prompt !== job.label && (
                    <div className="mt-1 line-clamp-2 text-[12px] text-muted">{job.prompt}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch checked={job.enabled !== false} onCheckedChange={() => toggle(job)} aria-label="启用" />
                  <button
                    onClick={() => {
                      setEditingId((cur) => (cur === job.id ? null : job.id));
                      setCreating(false);
                    }}
                    aria-label={`编辑 ${job.label || job.id}`}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      editingId === job.id
                        ? "bg-accent-soft text-accent"
                        : "text-faint hover:bg-hover hover:text-fg",
                    )}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => remove(job)}
                    aria-label="删除"
                    className="flex size-7 items-center justify-center rounded-md text-faint outline-none hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {editingId === job.id && (
                <div className="border-t border-border">
                  <CronForm
                    auth={auth}
                    job={job}
                    onDone={() => {
                      setEditingId(null);
                      refresh();
                    }}
                    onError={setErr}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 新建 / 编辑共用表单。编辑态（传入 job）：预填全部字段；schedule 能还原成
 * 每天/每周 预设就还原，否则落高级 cron。送达方式与一次性属性同样可改；
 * 把一次性改回重复时若任务已因触发被自动停用，会随保存一并重新启用。
 */
function CronForm({
  auth,
  job,
  onDone,
  onError,
}: {
  auth: AuthSession;
  job?: CronJob;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const editing = !!job;
  const preset = editing ? scheduleToPreset(job?.schedule) : null;
  const modeOptions = SCHEDULE_MODE_LABELS;

  const [mode, setMode] = useState<ScheduleMode>(
    editing ? (preset?.mode ?? "advanced") : "daily",
  );
  const [time, setTime] = useState(preset?.time ?? "09:00");
  const [weekday, setWeekday] = useState(preset?.mode === "weekly" ? preset.weekday : 1);
  const [minutes, setMinutes] = useState(10);
  const [at, setAt] = useState("");
  const [cron, setCron] = useState(job?.schedule || "0 9 * * *");
  const [advOneshot, setAdvOneshot] = useState(editing ? !!job?.oneshot : false);
  const [label, setLabel] = useState(job?.label ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [deliver, setDeliver] = useState(job?.deliver || "webchat");
  const [busy, setBusy] = useState(false);

  // 实时把当前表单解析成 { 人类可读, cron, 是否一次性 }；非法时给出原因。
  const preview = (() => {
    try {
      const built = buildSchedule(mode, { time, weekday, minutes, at, cron, oneshot: advOneshot });
      return { ok: true as const, human: cronHuman(built.schedule), oneshot: built.oneshot };
    } catch (e) {
      return { ok: false as const, msg: (e as Error).message };
    }
  })();

  const submit = useCallback(async () => {
    if (!prompt.trim()) return onError("请填写内容 / 指令");
    let built: ReturnType<typeof buildSchedule>;
    try {
      built = buildSchedule(mode, { time, weekday, minutes, at, cron, oneshot: advOneshot });
    } catch (e) {
      return onError((e as Error).message);
    }
    setBusy(true);
    try {
      if (editing && job) {
        const patch: Record<string, unknown> = {
          schedule: built.schedule,
          prompt: prompt.trim(),
          label: label.trim(),
          deliver,
          oneshot: built.oneshot,
        };
        // 一次性→重复：任务可能已因触发被自动停用，随保存重新启用。
        if (job.oneshot && !built.oneshot && job.enabled === false) patch.enabled = true;
        await api.updateCron(auth, job.id, patch);
      } else {
        await api.createCron(auth, {
          schedule: built.schedule,
          prompt: prompt.trim(),
          label: label.trim() || undefined,
          deliver,
          oneshot: built.oneshot,
        });
      }
      onDone();
    } catch (e) {
      onError((e as Error).message || (editing ? "保存失败" : "创建失败"));
    } finally {
      setBusy(false);
    }
  }, [auth, editing, job, mode, time, weekday, minutes, at, cron, advOneshot, prompt, label, deliver, onDone, onError]);

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 px-4 py-3.5",
        !editing && "mx-4 mb-3 rounded-xl border border-border bg-bg",
      )}
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2.5">
        <Field label="时间">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ScheduleMode)}
            className={cn(inputCls, "w-auto")}
          >
            {modeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {(mode === "daily" || mode === "weekly") && (
          <Field label="几点">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(inputCls, "w-auto")} />
          </Field>
        )}
        {mode === "weekly" && (
          <Field label="星期">
            <select
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
              className={cn(inputCls, "w-auto")}
            >
              {WEEKDAY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {mode === "after" && (
          <Field label="分钟后">
            <input
              type="number"
              min={1}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className={cn(inputCls, "w-24")}
            />
          </Field>
        )}
        {mode === "once" && (
          <Field label="日期时间">
            <input
              type="datetime-local"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className={cn(inputCls, "w-auto")}
            />
          </Field>
        )}
        {mode === "advanced" && (
          <>
            <Field label="Cron 表达式">
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 9 * * 1"
                className={cn(inputCls, "w-40 font-mono")}
              />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-[13px] text-fg">
              <Switch checked={advOneshot} onCheckedChange={setAdvOneshot} aria-label="一次性" /> 一次性
            </label>
          </>
        )}
      </div>
      {(mode === "daily" || mode === "weekly" || mode === "advanced") && (
        <p className="-mt-0.5 text-[11px] text-faint">时间按服务时区（北京时间）解释。</p>
      )}

      <Field label="标题（可选）">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="周报提醒" className={inputCls} />
      </Field>
      <Field label="内容 / 指令">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="到点要智能体做什么，例如：汇总本周进展并推送给我"
          className={cn(inputCls, "min-h-[60px] resize-y")}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Field label="送达" inline>
          <select value={deliver} onChange={(e) => setDeliver(e.target.value)} className={cn(inputCls, "w-auto")}>
            {DELIVER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <span className="min-w-0 text-[11.5px] text-faint">
          {preview.ok ? (
            <>
              {editing ? "将改为：" : "将创建："}
              <span className="text-muted">{preview.human}</span> · {preview.oneshot ? "一次性" : "重复"}
            </>
          ) : (
            preview.msg
          )}
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={busy || !prompt.trim() || !preview.ok}
          className="ml-auto"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {editing ? "保存修改" : "创建任务"}
        </Button>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring";

function Field({ label, inline, children }: { label: string; inline?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("gap-1", inline ? "flex items-center gap-2" : "flex flex-col")}>
      <span className="text-[12px] text-faint">{label}</span>
      {children}
    </label>
  );
}

function deliverLabel(v: string): string {
  return DELIVER_OPTIONS.find((o) => o.value === v)?.label || v;
}

function fmtTime(t: string | number): string {
  try {
    const d = new Date(typeof t === "number" ? t : t);
    if (Number.isNaN(d.getTime())) return String(t);
    return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(t);
  }
}
