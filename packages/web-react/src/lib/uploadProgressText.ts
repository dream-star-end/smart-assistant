/**
 * Percent while bytes are still leaving the browser. Floors and stops at 99%
 * so "100%" never shows before the last byte is sent; once everything is sent
 * the server is still storing it, so say so instead of sitting at 100%.
 */
export function uploadProgressText(sentBytes: number, totalBytes: number): string {
  if (totalBytes <= 0) return "";
  if (sentBytes >= totalBytes) return "处理中…";
  return `${Math.min(99, Math.floor((Math.max(0, sentBytes) / totalBytes) * 100))}%`;
}
