const DOI_RE = /(?:\bdoi\s*:\s*)?\b10\.\d{4,9}\/[\w.()/:;+-]+/i;
const DOI_URL_RE = /https?:\/\/(?:dx\.)?doi\.org\/10\.\d{4,9}\/[^\s<>"']+/i;
const ARXIV_RE = /\barxiv\s*:?\s*(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;
const ARXIV_URL_RE = /https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)(?:\.pdf)?/i;
const BARE_ARXIV_RE = /^\s*\d{4}\.\d{4,5}(?:v\d+)?\s*$/i;
const BIBTEX_RE = /@(?:article|inproceedings|proceedings|book|misc|preprint|software|dataset)\s*\{/i;

const PAPER_TERM_RE = /论文|文献|期刊|预印本|题名|doi|arxiv|pubmed|pmid|bibtex|endnote|ris|\b(?:paper|papers|article|articles|literature|preprint|journal|doi|arxiv|pubmed|pmid|bibtex|ris|endnote)\b/i;
const PAPER_ACTION_RE = /下载|查找|找一下|帮我找|搜索|检索|引用|导出|批量|阅读清单|文献综述|综述|\b(?:download|find|search|lookup|cite|citation|references?|bibliography|bibtex|ris|endnote|review|survey)\b/i;
const SEARCH_RE = /搜索|检索|查找|找一下|有哪些|文献综述|综述|\b(?:search|find|lookup|literature review|survey)\b/i;
const CITATION_RE = /引用|参考文献|导出|bibtex|endnote|\bris\b|\b(?:cite|citation|bibliography|reference)\b/i;
const BATCH_RE = /批量|阅读清单|每行|列表|清单|\bbatch\b|\breading list\b/i;
const BROWSER_STATUS_RE = /隐身浏览器|机构登录|webvpn|carsi|vpnsci|\b(?:incognito browser|institutional login|webvpn|carsi|vpnsci)\b/i;
const HEALTH_RE = /健康检查|网络诊断|来源评分|通道.*(?:可用|状态)|\b(?:health check|network diagnose|source scores?)\b/i;

export const SCANSCI_PAPER_HINT_MARKER = "【OpenClaude 论文任务系统提示】";

const SCANSCI_PAPER_HINT = [
  "---",
  SCANSCI_PAPER_HINT_MARKER,
  "检测到这轮可能是论文/文献任务。用户不需要打开任何设置入口；如果当前工具列表中存在 `scansci_pdf_*` 工具，可优先使用它们；否则使用内置 WebSearch/WebFetch 检索/抓取，必要时说明当前未挂载专用 PDF 下载工具。",
  "- 单个 DOI、arXiv、论文 URL 或精确题名：若有 `scansci_pdf_*` 则解析/下载；否则用 WebSearch/WebFetch 查找来源、标题、链接与可访问 PDF，不要假装已下载。",
  "- 主题、关键词或模糊题名：先搜索并列候选，让用户按编号/卡片选择；不要擅自批量下载。",
  "- 引用、BibTeX、RIS、EndNote：有专用工具时生成结构化结果；否则给出可核验的普通引用信息。",
  "- 多篇列表或阅读清单：小批量处理，汇总成功/失败与下一步建议；专用下载工具不可用时只汇总链接与检索结果。",
  "- 不要输出 ScanSci 配置、Cookie、Token、browser_state、代理或机构登录敏感信息；隐身浏览器/WebVPN 相关请求先做状态检测并清楚说明可用边界。",
].join("\n");

export type ScanSciPaperIntentKind = "download" | "search" | "citation" | "batch" | "health" | "browser";

export interface ScanSciPaperIntent {
  kind: ScanSciPaperIntentKind;
  reason: "identifier" | "bibtex" | "paper_action" | "paper_topic" | "status";
}

export function detectScanSciPaperIntent(text: string): ScanSciPaperIntent | null {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  if (raw.includes(SCANSCI_PAPER_HINT_MARKER)) return null;

  const hasDoi = DOI_RE.test(raw) || DOI_URL_RE.test(raw);
  const hasArxiv = ARXIV_RE.test(raw) || ARXIV_URL_RE.test(raw) || BARE_ARXIV_RE.test(raw);
  const hasIdentifier = hasDoi || hasArxiv;
  const hasBibtex = BIBTEX_RE.test(raw);
  const hasPaperTerm = PAPER_TERM_RE.test(raw);
  const hasPaperAction = PAPER_ACTION_RE.test(raw);

  if (BROWSER_STATUS_RE.test(raw) && (hasPaperTerm || /论文|文献|paper|article|scansci/i.test(raw))) {
    return { kind: "browser", reason: "status" };
  }
  if (HEALTH_RE.test(raw) && (hasPaperTerm || /论文|文献|paper|article|scansci/i.test(raw))) {
    return { kind: "health", reason: "status" };
  }
  if (hasBibtex) {
    return { kind: BATCH_RE.test(raw) ? "batch" : "citation", reason: "bibtex" };
  }
  if (hasIdentifier) {
    if (CITATION_RE.test(raw)) return { kind: "citation", reason: "identifier" };
    if (BATCH_RE.test(raw)) return { kind: "batch", reason: "identifier" };
    return { kind: "download", reason: "identifier" };
  }
  if (hasPaperTerm && hasPaperAction) {
    if (CITATION_RE.test(raw)) return { kind: "citation", reason: "paper_action" };
    if (BATCH_RE.test(raw)) return { kind: "batch", reason: "paper_action" };
    if (SEARCH_RE.test(raw)) return { kind: "search", reason: "paper_action" };
    return { kind: "download", reason: "paper_action" };
  }
  // Common terse query from Chinese users: “CRISPR prime editing 论文”.
  if (/论文|文献/.test(raw) && raw.length <= 240) {
    return { kind: "search", reason: "paper_topic" };
  }
  return null;
}

export function appendScanSciPaperIntentHintToFrame<T extends Record<string, unknown>>(frame: T): T {
  const content = frame.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return frame;
  const text = (content as { text?: unknown }).text;
  if (typeof text !== "string") return frame;
  const intent = detectScanSciPaperIntent(text);
  if (intent === null) return frame;
  const nextContent = {
    ...(content as Record<string, unknown>),
    text: `${text}\n\n${SCANSCI_PAPER_HINT}\n- 本轮检测类型：${intent.kind} (${intent.reason})。`,
  };
  return {
    ...frame,
    content: nextContent,
  };
}
