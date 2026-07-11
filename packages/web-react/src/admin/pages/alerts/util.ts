import { apiErrorMessage } from "../../lib/adminApi";

/** 统一取错误文案:收口到 apiErrorMessage(网络/英文技术串不外露,后端中文文案直显)。 */
export function errText(e: unknown): string {
  return apiErrorMessage(e, "请求失败");
}

/** datetime-local 需要的本地时区 ISO(不带秒/时区):YYYY-MM-DDTHH:mm。 */
export function toLocalDatetimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
