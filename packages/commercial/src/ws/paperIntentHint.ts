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

// 历史债:本模块符号仍带 "ScanSci" 旧名(detectScanSciPaperIntent / SCANSCI_PAPER_HINT_MARKER /
// appendScanSciPaperIntentHintToFrame),为限制改动面(userChatBridge + 测试只依赖这些名字与
// 意图 kind,不依赖 hint 文案)未连带重命名。**权威已迁移**:文献检索/引用统一走研究子系统的
// oc-* CLI(oc-lit / oc-cite / oc-ingest);旧的 `scansci-pdf` CLI 在当前镜像仅 server 模式
// (只有 run/check 子命令,无 search/download)——继续指向它会让 agent 每次都先跑必失败的
// `scansci-pdf search` 再回落。下面的提示已改为只指向 oc-*,并显式禁用 scansci-pdf 做检索。
const SCANSCI_PAPER_HINT = [
  "---",
  SCANSCI_PAPER_HINT_MARKER,
  "检测到这轮可能是论文/文献任务。用户不需要打开任何设置入口。文献检索与引用一律用容器内的 oc-* 研究命令行(经 Bash 调用，传参即可)；拿不到全文时再用内置 WebSearch/WebFetch 兜底。",
  "- 主题、关键词或模糊题名(找文献/综述素材)：用 `oc-lit search \"<3~8 个英文核心术语>\"`(多源 OpenAlex/Crossref/arXiv + 去重 + 开放获取发现)；从一篇关键论文滚雪球找全相关工作用 `oc-lit snowball <DOI|arXiv|OpenAlex id>`。",
  "- 单个 DOI / arXiv / 论文 URL / 精确题名：用 `oc-lit search` 定位元数据；`oa.isOA=true` 时给出 `oa.url` 开放全文链接，付费墙且无 OA 链接时不要代下载，提示用户经机构 IP 自取或上传 PDF(随后用 `oc-ingest` 解析入库)。",
  "- 引用 / BibTeX / RIS / APA / GB-T7714：用 `oc-cite verify <DOI|arXiv|OpenAlex id>` 接地校验并生成结构化引用(撤稿/未命中可信记录会标注)；引用接地是红线，绝不臆造。",
  "- 多篇列表或阅读清单：逐条 `oc-lit`/`oc-cite` 小批量处理，汇总成功/失败与下一步建议。",
  "- 子命令与参数见 `skill_view(\"oc-lit\")` / `skill_view(\"oc-cite\")` / `skill_view(\"oc-ingest\")`。**不要**用 `scansci-pdf` 做检索或下载(当前环境它只有 server 模式，无 search/download 子命令，调用必失败)。",
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
