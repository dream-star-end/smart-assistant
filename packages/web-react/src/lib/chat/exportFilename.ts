/** `<会话标题>.md`；空标题回落「新对话」，去掉路径分隔符。 */
export function sessionExportFilename(title: string | null | undefined): string {
  const raw = (title ?? "").trim() || "新对话";
  const safe = raw.replace(/[\\/]/g, "_");
  return `${safe}.md`;
}
