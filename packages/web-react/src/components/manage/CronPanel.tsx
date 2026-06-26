import { Clock, Loader2, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { AuthSession, CronJob } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Alert, Button, Spinner, Switch } from "../ui";

const DELIVER_OPTIONS = [
  { value: "webchat", label: "网页对话" },
  { value: "telegram", label: "Telegram" },
  { value: "local", label: "仅记录" },
];

/**
 * 定时任务中心：列出 / 启停 / 删除 / 新建 cron 任务（经容器代理 /api/cron*）。
 */
export function CronPanel({ auth }: { auth: AuthSession }) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(false);

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
      if (!confirm(`删除定时任务「${job.label || job.prompt || job.id}」？`)) return;
      try {
        await api.deleteCron(auth, job.id);
        refresh();
      } catch (e) {
        setErr((e as Error).message || "删除失败");
      }
    },
    [auth, refresh],
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">定时任务</span>
        <Button variant="secondary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? <X size={14} /> : <Plus size={14} />}
          {creating ? "取消" : "新建"}
        </Button>
      </div>

      {creating && (
        <CronCreateForm
          auth={auth}
          onCreated={() => {
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
        <p className="px-5 py-10 text-center text-[13px] text-faint">
          还没有定时任务。可在对话里让智能体「每天 9 点推送…」自动创建，或点上方「新建」。
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 px-4 pb-4">
          {jobs.map((job) => (
            <li
              key={job.id}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface px-3.5 py-3"
            >
              <Clock size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium text-fg">
                  {job.label || job.prompt || "（无标题）"}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-faint">
                  {job.schedule && <code className="font-mono">{job.schedule}</code>}
                  {job.oneshot && <span>· 一次性</span>}
                  {job.deliver && <span>· {deliverLabel(job.deliver)}</span>}
                  {job.nextRunAt && <span>· 下次 {fmtTime(job.nextRunAt)}</span>}
                </div>
                {job.label && job.prompt && job.prompt !== job.label && (
                  <div className="mt-1 line-clamp-2 text-[12px] text-muted">{job.prompt}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch checked={job.enabled !== false} onCheckedChange={() => toggle(job)} aria-label="启用" />
                <button
                  onClick={() => remove(job)}
                  aria-label="删除"
                  className="flex size-7 items-center justify-center rounded-md text-faint outline-none hover:bg-danger-soft hover:text-danger focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CronCreateForm({
  auth,
  onCreated,
  onError,
}: {
  auth: AuthSession;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState("");
  const [deliver, setDeliver] = useState("webchat");
  const [oneshot, setOneshot] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (!schedule.trim() || !prompt.trim()) return;
    setBusy(true);
    try {
      await api.createCron(auth, {
        schedule: schedule.trim(),
        prompt: prompt.trim(),
        label: label.trim() || undefined,
        deliver,
        oneshot,
      });
      onCreated();
    } catch (e) {
      onError((e as Error).message || "创建失败");
    } finally {
      setBusy(false);
    }
  }, [auth, schedule, prompt, label, deliver, oneshot, onCreated, onError]);

  return (
    <div className="mx-4 mb-3 flex flex-col gap-2.5 rounded-xl border border-border bg-bg px-4 py-3.5">
      <Field label="cron 表达式">
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="0 9 * * 1  （每周一 9 点）"
          className={inputCls}
        />
      </Field>
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
        <label className="flex items-center gap-2 text-[13px] text-fg">
          <Switch checked={oneshot} onCheckedChange={setOneshot} aria-label="一次性" /> 一次性
        </label>
        <Button variant="primary" size="sm" onClick={submit} disabled={busy || !schedule.trim() || !prompt.trim()} className="ml-auto">
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          创建任务
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
