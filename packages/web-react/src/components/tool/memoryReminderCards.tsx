import { Bell, CalendarClock, CheckCircle2, Clock, Hash, ListChecks, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cronHuman } from "../../lib/cron";
import { cn } from "../../lib/utils";
import { Badge } from "../ui";
import { asStr } from "./format";

// 注意:核心记忆已迁 memdir 文件范式,旧的 oc-memory `memory` 读/写状态卡(renderMemoryReadCards /
// MemoryStatusCard,依赖已删除的 § 分隔 memoryText)随之退役;记忆读写现由记忆中心文件列表 +
// 「记忆更新」Write/Edit 卡承载。本文件只保留定时提醒/任务(reminder)相关卡。

type ReminderJob = {
  id: string;
  title: string;
  schedule: string;
  oneshot?: boolean;
  enabled?: boolean;
  deliver?: string;
  nextRunAt?: string;
};

type ReminderParseResult =
  | { kind: "empty" }
  | { kind: "list"; declaredCount?: number; jobs: ReminderJob[] };

const EMPTY_REMINDER_RE = /当前没有任何定时提醒\/任务/;
const REMINDER_LINE_RE = /^-\s+\*\*(.*?)\*\*\s+\(ID:\s*`([^`]+)`\)\s+—\s+(.+)$/u;

function stripBackticks(s: string): string {
  return s.trim().replace(/^`|`$/g, "");
}

export function parseReminderListOutput(output?: string | null): ReminderParseResult | null {
  const text = String(output || "").trim();
  if (!text) return null;
  if (EMPTY_REMINDER_RE.test(text)) return { kind: "empty" };

  const countMatch = /共\s+(\d+)\s+个定时提醒\/任务/.exec(text);
  const declaredCount = countMatch ? Number(countMatch[1]) : undefined;
  const jobs: ReminderJob[] = [];
  let malformedTaskLine = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || countMatch?.[0] === trimmed) continue;
    if (!trimmed.startsWith("- ")) continue;
    const m = REMINDER_LINE_RE.exec(trimmed);
    if (!m) {
      malformedTaskLine = true;
      continue;
    }
    const bits = m[3].split(" · ").map((b) => b.trim()).filter(Boolean);
    const scheduleBit = bits.find((b) => /^`[^`]+`$/.test(b));
    const next = bits.find((b) => b.startsWith("下次 "));
    jobs.push({
      title: m[1].trim() || m[2],
      id: m[2],
      schedule: scheduleBit ? stripBackticks(scheduleBit) : "",
      oneshot: bits.includes("一次性") ? true : bits.includes("重复") ? false : undefined,
      enabled: bits.includes("已停用") ? false : bits.includes("启用中") ? true : undefined,
      deliver: bits.includes("仅记录") ? "仅记录" : bits.includes("Telegram") ? "Telegram" : bits.includes("推送对话") ? "推送对话" : undefined,
      nextRunAt: next ? next.slice(3).trim() : undefined,
    });
  }
  if (jobs.length === 0) return null;
  if (malformedTaskLine || (declaredCount !== undefined && jobs.length !== declaredCount)) return null;
  return { kind: "list", declaredCount, jobs };
}

function fmtDateTime(value?: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function SmallMeta({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

function ReminderJobCard({ job }: { job: ReminderJob }) {
  const human = job.schedule ? cronHuman(job.schedule) : "自定义时间";
  return (
    <li className="rounded-xl border border-border bg-elevated px-3 py-2.5 shadow-soft">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Clock size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 max-w-full truncate text-[13px] font-semibold text-fg">{job.title}</span>
            {job.enabled === false ? <Badge tone="warning">已停用</Badge> : <Badge tone="success">启用中</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <SmallMeta icon={<CalendarClock size={11} />}>{human}</SmallMeta>
            {job.schedule && <SmallMeta>{job.schedule}</SmallMeta>}
            <SmallMeta>{job.oneshot ? "一次性" : "重复"}</SmallMeta>
            {job.deliver && <SmallMeta>{job.deliver}</SmallMeta>}
            {job.nextRunAt && <SmallMeta>下次 {fmtDateTime(job.nextRunAt)}</SmallMeta>}
            <SmallMeta icon={<Hash size={10} />}>{job.id}</SmallMeta>
          </div>
        </div>
      </div>
    </li>
  );
}

export function renderReminderListCard(output?: string | null): ReactNode | null {
  const parsed = parseReminderListOutput(output);
  if (!parsed) return null;
  if (parsed.kind === "empty") {
    return (
      <div className="rounded-xl border border-dashed border-border bg-elevated px-3 py-4 text-center">
        <Clock size={18} className="mx-auto text-faint" />
        <div className="mt-1 text-[13px] font-medium text-fg">还没有定时任务</div>
        <p className="mt-0.5 text-[12px] text-faint">可以直接对智能体说“每天 9 点提醒我…”来创建。</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
          <ListChecks size={14} className="text-accent" />
          当前共有 {parsed.declaredCount ?? parsed.jobs.length} 个定时任务
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {parsed.jobs.map((job) => (
          <ReminderJobCard key={job.id} job={job} />
        ))}
      </ul>
    </div>
  );
}

function statusTone(ok: boolean | undefined): "success" | "danger" | "neutral" {
  if (ok === true) return "success";
  if (ok === false) return "danger";
  return "neutral";
}

function parseReminderStatus(op: string, input: Record<string, unknown> | null, output?: string | null, error?: boolean) {
  const text = String(output || "").trim();
  const ok = error || /^error:/i.test(text) ? false : text ? true : undefined;
  const failureText = ok === false ? text || "工具执行失败" : "";
  if (op === "create_reminder") {
    const id = /ID:\s*`([^`]+)`/.exec(text)?.[1];
    const schedule = /计划:\s*`([^`]+)`/.exec(text)?.[1] || asStr(input?.schedule);
    const quoted = /已创建:\s*"([\s\S]*?)"(?:\n|$)/.exec(text)?.[1];
    return {
      ok,
      icon: Bell,
      title: ok === false ? "创建提醒失败" : "已创建定时任务",
      desc: failureText || quoted || asStr(input?.message) || asStr(input?.label),
      id,
      schedule,
      chips: [input?.oneshot === false ? "重复" : "一次性", asStr(input?.deliver)].filter(Boolean),
    };
  }
  if (op === "update_reminder") {
    const id = /已修改任务\s+`([^`]+)`/.exec(text)?.[1] || asStr(input?.id);
    const fields = /:\s*([^:]+)$/.exec(text)?.[1];
    return {
      ok,
      icon: CheckCircle2,
      title: ok === false ? "修改任务失败" : "已修改定时任务",
      desc: failureText || (fields ? `更新字段：${fields}` : "任务信息已更新"),
      id,
      schedule: asStr(input?.schedule),
      chips: [input?.enabled === false ? "已停用" : input?.enabled === true ? "启用中" : "", input?.oneshot === true ? "一次性" : input?.oneshot === false ? "重复" : ""].filter(Boolean),
    };
  }
  const id = /已删除任务\s+`([^`]+)`/.exec(text)?.[1] || asStr(input?.id);
  return {
    ok,
    icon: Trash2,
    title: ok === false ? "删除任务失败" : "已删除定时任务",
    desc: failureText || (id ? "这个任务不会再触发。" : text),
    id,
    schedule: "",
    chips: [] as string[],
  };
}

export function ReminderStatusCard({ op, input, output, error }: { op: string; input: Record<string, unknown> | null; output?: string | null; error?: boolean }) {
  const status = parseReminderStatus(op, input, output, error);
  const Icon = status.icon;
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", status.ok === false ? "border-danger-soft bg-danger-soft/40" : "border-border bg-elevated")}>
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", status.ok === false ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-fg">{status.title}</span>
            <Badge tone={statusTone(status.ok)}>{status.ok === false ? "失败" : "完成"}</Badge>
          </div>
          {status.desc && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-snug text-muted">{status.desc}</p>}
          <div className="mt-1 flex flex-wrap gap-1.5">
            {status.schedule && <SmallMeta icon={<CalendarClock size={11} />}>{cronHuman(status.schedule)}</SmallMeta>}
            {status.schedule && <SmallMeta>{status.schedule}</SmallMeta>}
            {status.chips.map((chip) => <SmallMeta key={chip}>{chip}</SmallMeta>)}
            {status.id && <SmallMeta icon={<Hash size={10} />}>{status.id}</SmallMeta>}
          </div>
        </div>
      </div>
    </div>
  );
}

