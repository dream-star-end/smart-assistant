/** Only platform artifact links use container signing; ordinary site URLs stay links. */
export function artifactDownloadPath(href: string | undefined): string | null {
  if (!href || !/^\/(?:home\/agent|root)\/\.openclaude\/(?:generated|uploads)\//.test(href)) return null;
  let path: string;
  try { path = decodeURIComponent(href); } catch { return null; }
  if (/[\\?#]/.test(path) || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  const parts = path.split("/");
  if (parts.slice(1).some((part) => !part || part === "." || part === "..")) return null;
  return path;
}
