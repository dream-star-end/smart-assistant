/**
 * 共享 CSV 工具(M8.4 / P2-20)
 *
 * 与 ledger.ts 原有 csvEscapeCell 行为完全一致 — 抽出来给 users.csv / orders.csv
 * / ledger.csv 三处共用。CRLF 行尾由调用方组装。
 */

/**
 * Excel/Sheets 公式注入防护:`= + - @ \t \r` 起首加 `'` 前缀让 Excel 当文本。
 * RFC 4180 quote:含 `,` `"` `\r` `\n` 用 `"` 包裹,内部 `"` 转 `""`。
 */
export function csvEscapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 文件名时间戳:`<prefix>-YYYYMMDDTHHmm.csv`(UTC,与 ledger.csv 一致)。
 */
export function csvFilename(prefix: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `${prefix}-${stamp}.csv`;
}
