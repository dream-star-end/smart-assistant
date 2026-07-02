// 友好的定时任务排程 —— cron 人类可读 + 常用预设生成 cron。纯函数，便于测试。
//
// 后端按容器时区 Asia/Shanghai 解释 5 段式 cron（分 时 日 月 周），见
// packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime（TZ=Asia/Shanghai）
// 与 packages/gateway/src/cron.ts。因此“几分钟后 / 某时一次”这类绝对时刻必须换算成
// 上海挂钟分量，绝不能直接用浏览器本地分量，否则跨时区用户会生成错误的小时/日。

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
/** 后端 cron 执行时区（容器 TZ）。Asia/Shanghai 固定 UTC+8、无 DST。 */
export const CRON_TZ = "Asia/Shanghai";

function isPlainInt(s: string): boolean {
  return /^\d+$/.test(s);
}
// 字段是否为 [lo,hi] 内的“简单值”：`*`、范围内整数、或（dow）范围内整数逗号列表。
// 含 step（*/n）/ range（n-m）等复杂语义、或越界数字 → 视为非简单，cronHuman 回退原串。
function okField(s: string, lo: number, hi: number, allowList = false): boolean {
  if (s === "*") return true;
  const vals = allowList ? s.split(",") : [s];
  return vals.every((x) => isPlainInt(x) && Number(x) >= lo && Number(x) <= hi);
}

/** 把 5 段式 cron 翻成中文人类可读；非 5 段、复杂（step/range）或越界时回退原串。 */
export function cronHuman(cron?: string): string {
  const raw = (cron || "").trim();
  const p = raw.split(/\s+/);
  if (p.length !== 5) return raw;
  const [min, hr, dom, mon, dow] = p;
  if (
    !okField(min, 0, 59) ||
    !okField(hr, 0, 23) ||
    !okField(dom, 1, 31) ||
    !okField(mon, 1, 12) ||
    !okField(dow, 0, 6, true)
  ) {
    return raw; // 复杂/越界字段 → 给原 cron，不臆测
  }
  let when = "";
  if (dom !== "*" && mon !== "*") when = `${mon}月${dom}日 `;
  else if (dow !== "*") when = `每周${dow.split(",").map((d) => DAY_NAMES[Number(d)] ?? d).join("、")} `;
  else if (dom !== "*") when = `每月${dom}日 `;
  else when = "每天 ";
  let time = "";
  if (hr !== "*" && min !== "*") time = `${hr.padStart(2, "0")}:${min.padStart(2, "0")}`;
  else if (hr !== "*") time = `${hr.padStart(2, "0")}:00`;
  else if (min !== "*") time = `每小时第 ${min} 分`;
  else time = "每分钟";
  return (when + time).trim();
}

export type ScheduleMode = "daily" | "weekly" | "after" | "once" | "advanced";

export type ScheduleInput = {
  time?: string; // "HH:mm"（daily/weekly，按服务时区/北京时间）
  weekday?: number; // 0-6（weekly）
  minutes?: number; // （after）
  at?: string; // datetime-local 值（once，浏览器本地挂钟，转绝对时刻）
  cron?: string; // （advanced）
  oneshot?: boolean; // （advanced）
  now?: Date; // 测试可注入“现在”
};

export type BuiltSchedule = { schedule: string; oneshot: boolean };

function parseHm(time?: string): { h: number; m: number } {
  const mt = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!mt) throw new Error("请填写 HH:mm 时间");
  const h = Number(mt[1]);
  const m = Number(mt[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) throw new Error("时间超出范围");
  return { h, m };
}

/** 把一个绝对时刻换算成后端时区（上海）的挂钟分量。 */
function shanghaiParts(d: Date): { minute: number; hour: number; day: number; month: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CRON_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? "0");
  return { minute: g("minute"), hour: g("hour"), day: g("day"), month: g("month"), year: g("year") };
}

function cronForInstant(d: Date): string {
  const p = shanghaiParts(d);
  return `${p.minute} ${p.hour} ${p.day} ${p.month} *`;
}

/**
 * 一次性 cron 为（分 时 日 月 *），不含年份。验证从 now 起“下一次匹配”恰好是 target；
 * 否则（典型：跨年——明年的月日今年会先匹配）后端会提前触发，直接拒绝。
 * Asia/Shanghai 固定 UTC+8、无 DST → 上海挂钟 Y-M-D h:m 的绝对时刻 = Date.UTC(Y, M-1, D, h-8, m)。
 */
function guardOneshotNextMatch(target: Date, now: Date): void {
  const p = shanghaiParts(target);
  const nowMs = now.getTime();
  let next = Number.POSITIVE_INFINITY;
  for (let y = p.year - 1; y <= p.year + 1; y++) {
    const t = Date.UTC(y, p.month - 1, p.day, p.hour - 8, p.minute, 0);
    if (t > nowMs && t < next) next = t;
  }
  if (!Number.isFinite(next) || Math.abs(next - target.getTime()) >= 60_000) {
    throw new Error("该一次性时间无法用日程精确表达，请选择近一年内的日期时间");
  }
}

/** 把友好预设转成 { cron, 是否一次性 }。非法输入抛带中文消息的 Error。 */
export function buildSchedule(mode: ScheduleMode, v: ScheduleInput = {}): BuiltSchedule {
  const now = v.now ?? new Date();
  if (mode === "daily") {
    const { h, m } = parseHm(v.time);
    return { schedule: `${m} ${h} * * *`, oneshot: false };
  }
  if (mode === "weekly") {
    const { h, m } = parseHm(v.time);
    const wd = Number(v.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error("请选择星期");
    return { schedule: `${m} ${h} * * ${wd}`, oneshot: false };
  }
  if (mode === "after") {
    const mins = Math.floor(Number(v.minutes));
    if (!Number.isFinite(mins) || mins < 1) throw new Error("请填写有效分钟数");
    const target = new Date(now.getTime() + mins * 60_000);
    guardOneshotNextMatch(target, now);
    return { schedule: cronForInstant(target), oneshot: true };
  }
  if (mode === "once") {
    const d = new Date(v.at ?? "");
    if (Number.isNaN(d.getTime())) throw new Error("请选择日期时间");
    if (d.getTime() <= now.getTime()) throw new Error("该时间已过去，请选择未来时间");
    guardOneshotNextMatch(d, now);
    return { schedule: cronForInstant(d), oneshot: true };
  }
  // advanced：用户手写 5 段式 cron（具体语义由后端校验；这里只挡明显非法）
  const schedule = String(v.cron || "").trim();
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(schedule)) {
    throw new Error("Cron 必须是 5 段：分 时 日 月 周");
  }
  return { schedule, oneshot: v.oneshot !== false };
}

/**
 * 尝试把 5 段 cron 还原成 每天/每周 预设（编辑表单预填）。只识别 buildSchedule
 * 会产出的简单形态（分/时为整数、日/月为 *、周为空或单数字）；其余（step/range/
 * 逗号列表等）返回 null，编辑表单回退到高级 cron 模式，不臆测语义。
 */
export function scheduleToPreset(
  schedule?: string,
): { mode: "daily" | "weekly"; time: string; weekday: number } | null {
  const p = (schedule || "").trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [min, hr, dom, mon, dow] = p;
  if (!isPlainInt(min) || !isPlainInt(hr) || dom !== "*" || mon !== "*") return null;
  const m = Number(min);
  const h = Number(hr);
  if (m > 59 || h > 23) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dow === "*") return { mode: "daily", time, weekday: 1 };
  if (isPlainInt(dow) && Number(dow) <= 6) return { mode: "weekly", time, weekday: Number(dow) };
  return null;
}

export const SCHEDULE_MODE_LABELS: { value: ScheduleMode; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "after", label: "几分钟后" },
  { value: "once", label: "某时一次" },
  { value: "advanced", label: "高级 Cron" },
];

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/** 星期下拉项（值 0-6，周一在前更符合中文习惯，周日=0）。 */
export const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((v) => ({
  value: v,
  label: WEEKDAY_LABELS[v === 0 ? 6 : v - 1],
}));
