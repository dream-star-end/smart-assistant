/**
 * WebSearch 结果文本 → 来源条目。纯函数、无依赖:来源列表富卡(researchCards)与详情面板的
 * 参考来源(chat/workbench)共用;单独成文件,免得面板把整套研究卡拖进首屏(同 OCV5-310 artifactSrc)。
 */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

// 后端 WebSearchTool 把结果拼成 `  - [title](url): snippet` 行(见 minimaxAdapter/
// WebSearchTool.mapToolResultToToolResultBlockParam)。逐行解析,非结果行(标题/REMINDER)
// 自然不匹配。纯函数:解析失败/空/畸形 → [](卡片据此回落通用文本块,UX 铁律)。
const WEB_SEARCH_LINE = /^\s*-\s+\[(.+?)\]\(([^)]+)\)(?::\s*(.*))?$/;

export function parseWebSearchResults(text: string | null | undefined): WebSearchHit[] {
  if (!text) return [];
  const hits: WebSearchHit[] = [];
  for (const line of text.split("\n")) {
    const m = WEB_SEARCH_LINE.exec(line);
    if (!m) continue;
    const url = (m[2] ?? "").trim();
    if (!url) continue;
    hits.push({ title: (m[1] ?? "").trim(), url, snippet: m[3]?.trim() || undefined });
  }
  return hits;
}

/**
 * 详情面板「参考来源」用:除上面的 `- [title](url)` 行,还认内置 WebSearch 的原生结果
 * `Links: [{"title":…,"url":…}, …]`(一次搜索可能有多行)。只收 http(s),按 url 去重。
 * 聊天里的来源卡仍只用 parseWebSearchResults(其回落行为由它自己的测试锁定)。
 */
export function parseWebSearchSources(text: string | null | undefined): WebSearchHit[] {
  if (!text) return [];
  const hits: WebSearchHit[] = [...parseWebSearchResults(text)];
  for (const line of text.split("\n")) {
    const m = /^\s*Links:\s*(\[.*\])\s*$/.exec(line);
    if (!m) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const url = typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url.trim() : "";
      const title = typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title.trim() : "";
      if (url) hits.push({ title, url });
    }
  }
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const h of hits) {
    if (!/^https?:\/\//i.test(h.url) || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push(h);
  }
  return out;
}
