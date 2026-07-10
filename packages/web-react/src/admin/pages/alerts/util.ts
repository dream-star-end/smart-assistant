import { ApiError } from "../../lib/adminApi";

/** 统一取错误文案:ApiError 用其 message(已解包 commercial 信封),否则回退 String。 */
export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** datetime-local 需要的本地时区 ISO(不带秒/时区):YYYY-MM-DDTHH:mm。 */
export function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
