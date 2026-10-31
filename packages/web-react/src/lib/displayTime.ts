/**
 * 用户能看到的时间共用这一处时区。
 *
 * 账户偏好里的 IANA 名优先。没设过时用北京时间，不跟浏览器走：体验官的系统时钟是台北，
 * 浏览器时区却慢 12 小时，跟浏览器会把上午显示成「夜深了」，分享图日期也会少一天。
 * 账单 #1237 已经固定在此时区。设置里选「此浏览器」时存的是当时的 IANA 名。
 */

export const DISPLAY_TIME_ZONE_DEFAULT = "Asia/Shanghai";

let preference: string | undefined;

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function setDisplayTimeZonePreference(tz: string | null | undefined): void {
  preference = tz && isValidTimeZone(tz) ? tz : undefined;
}

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : DISPLAY_TIME_ZONE_DEFAULT;
  } catch {
    return DISPLAY_TIME_ZONE_DEFAULT;
  }
}

export function displayTimeZone(): string {
  return preference ?? DISPLAY_TIME_ZONE_DEFAULT;
}

/** 读 GET/PATCH /api/me/preferences 的快照（包一层 prefs 或平铺）。非法或缺失则回到缺省。 */
export function timeZoneFromPrefs(snap: unknown): void {
  if (!snap || typeof snap !== "object") {
    setDisplayTimeZonePreference(undefined);
    return;
  }
  const obj = snap as Record<string, unknown>;
  const nested = obj.prefs;
  const inner = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : obj;
  setDisplayTimeZonePreference(typeof inner.timezone === "string" ? inner.timezone : undefined);
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const PART_OPTIONS: Intl.DateTimeFormatOptions = {
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};

export function zonedParts(date: Date, timeZone = displayTimeZone()): ZonedParts {
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    ...PART_OPTIONS,
    timeZone,
  }).formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export type AbsoluteFormat = "datetime" | "full" | "date" | "time" | "short";

export function formatZoned(
  date: Date,
  format: AbsoluteFormat,
  timeZone = displayTimeZone(),
): string {
  const p = zonedParts(date, timeZone);
  const Y = String(p.year);
  const M = pad(p.month);
  const D = pad(p.day);
  const h = pad(p.hour);
  const m = pad(p.minute);
  const s = pad(p.second);
  switch (format) {
    case "date":
      return `${Y}-${M}-${D}`;
    case "time":
      return `${h}:${m}`;
    case "short":
      return `${M}-${D} ${h}:${m}`;
    case "full":
      return `${Y}-${M}-${D} ${h}:${m}:${s}`;
    default:
      return `${Y}-${M}-${D} ${h}:${m}`;
  }
}

/** 账单短时间：M月D日 HH:mm。月日不补零，与 #1237 一致。 */
export function formatLedgerShort(date: Date, timeZone = displayTimeZone()): string {
  const p = zonedParts(date, timeZone);
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`;
}

export function zonedHour(date: Date, timeZone = displayTimeZone()): number {
  return zonedParts(date, timeZone).hour;
}

/** 时区内的公历日序号，用来算今天/昨天。不能拿 YYYYMMDD 相减。 */
export function zonedDayIndex(date: Date, timeZone = displayTimeZone()): number {
  const p = zonedParts(date, timeZone);
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}
