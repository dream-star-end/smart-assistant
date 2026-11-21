/**
 * 交付物富预览纯函数与轻量解析器（OCV5-811）。
 *
 * 零外部重依赖、零 React 依赖，用于：
 *   1. 全格式产物分类与元数据提取（表格 CSV/TSV/Excel、幻灯片 PPT/Marp、长文档/Word、PDF、HTML、代码、媒体）；
 *   2. RFC4180 兼容的轻量 CSV/TSV 解析器（引号转义、表头识别、列统计、搜索过滤、排序与前 N 行安全渲染）；
 *   3. Markdown 幻灯片（`---` 分页，跳过代码围栏与 frontmatter）与长文档大纲（H1–H3）提取；
 *   4. 带位置锚点的「批注回填提示词生成器」，支持回填 Composer 输入框或剪贴板兜底。
 */

export type DeliverableCategory =
  | "slides"
  | "spreadsheet"
  | "document"
  | "pdf"
  | "html"
  | "code"
  | "media"
  | "file";

export type DeliverableFormat =
  | "csv"
  | "tsv"
  | "excel"
  | "pptx"
  | "markdown-slides"
  | "markdown"
  | "word"
  | "pdf"
  | "html"
  | "code"
  | "text"
  | "media"
  | "binary";

export type DeliverableMeta = {
  category: DeliverableCategory;
  format: DeliverableFormat;
  label: string;
  shortBadge: string;
  ext: string;
  canInlinePreview: boolean;
  isBinaryOffice: boolean;
  agentConvertPrompt?: string;
};

export const DELIVERABLE_CATEGORY_LABEL: Record<DeliverableCategory, string> = {
  slides: "幻灯片",
  spreadsheet: "表格",
  document: "文档",
  pdf: "PDF",
  html: "网页",
  code: "代码",
  media: "媒体",
  file: "文件",
};

export const DELIVERABLE_CATEGORY_ORDER: readonly DeliverableCategory[] = [
  "slides",
  "spreadsheet",
  "document",
  "pdf",
  "html",
  "code",
  "media",
  "file",
];

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const EXCEL_EXT = new Set(["xlsx", "xls", "xlsm", "ods", "numbers"]);
const PPT_EXT = new Set(["pptx", "ppt", "key", "odp"]);
const WORD_EXT = new Set(["docx", "doc", "rtf", "odt", "pages"]);
const TEXT_EXT = new Set(["txt", "text", "log", "rst", "tex", "ini", "conf", "srt", "vtt"]);
const CODE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "sql", "json", "yaml", "yml", "toml", "xml", "css", "scss", "less", "vue", "svelte",
  "lua", "r", "dart", "scala", "ex", "exs", "erl", "hs", "ml", "pl", "ps1", "dockerfile", "makefile", "gradle", "proto",
  "ipynb",
]);

const SLIDE_FILENAME_RE = /(?:^|[\s._/-])(slides?|deck|ppt|presentation|pitch|keynote)(?:[\s._/-]|$)/i;

function fileBaseName(path: string): string {
  const trimmed = path.replace(/[?#].*$/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function fileExtOf(path: string): string {
  const name = fileBaseName(path).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return name;
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1) : "";
}

/** 识别交付物的细粒度类别、格式、徽章与可选的二进制文档转预览提示词。 */
export function classifyDeliverable(path: string, content?: string | null): DeliverableMeta {
  const ext = fileExtOf(path);
  const shortExt = ext ? ext.slice(0, 5).toUpperCase() : "FILE";

  if (ext === "csv" || ext === "tsv") {
    return {
      category: "spreadsheet",
      format: ext,
      label: "表格",
      shortBadge: ext.toUpperCase(),
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (EXCEL_EXT.has(ext)) {
    return {
      category: "spreadsheet",
      format: "excel",
      label: "Excel 表格",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: true,
      agentConvertPrompt: `请将 \`${path}\` 中的主要工作表导出为 CSV 文件（保留表头），并给出关键列统计摘要，方便我在右侧表格视图中筛选和逐行批注。`,
    };
  }
  if (PPT_EXT.has(ext)) {
    return {
      category: "slides",
      format: "pptx",
      label: "演示文稿",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: true,
      agentConvertPrompt: `请将 \`${path}\` 导出为逐页预览图（PNG）或转换为 Markdown 幻灯片大纲（使用 \`---\` 分页），方便我在右侧工作区逐页审阅和批注。`,
    };
  }
  if (ext === "pdf") {
    return {
      category: "pdf",
      format: "pdf",
      label: "PDF 论文 / 文档",
      shortBadge: "PDF",
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (ext === "html" || ext === "htm") {
    return {
      category: "html",
      format: "html",
      label: "交互网页",
      shortBadge: "HTML",
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (MARKDOWN_EXT.has(ext)) {
    if (content && parseMarkdownSlides(content, path).isSlideDeck) {
      return {
        category: "slides",
        format: "markdown-slides",
        label: "幻灯片",
        shortBadge: "SLIDES",
        ext,
        canInlinePreview: true,
        isBinaryOffice: false,
      };
    }
    return {
      category: "document",
      format: "markdown",
      label: "长文档",
      shortBadge: "MD",
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (WORD_EXT.has(ext)) {
    return {
      category: "document",
      format: "word",
      label: "Word 文档",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: true,
      agentConvertPrompt: `请将 \`${path}\` 转换为结构化 Markdown 文档（保留标题层级与表格），方便我在右侧长文档阅读器中按章节审阅和批注。`,
    };
  }
  if (IMG_EXT.has(ext) || VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
    return {
      category: "media",
      format: "media",
      label: IMG_EXT.has(ext) ? "图片" : VIDEO_EXT.has(ext) ? "视频" : "音频",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (CODE_EXT.has(ext)) {
    return {
      category: "code",
      format: "code",
      label: "代码",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  if (TEXT_EXT.has(ext)) {
    return {
      category: "document",
      format: "text",
      label: "文本",
      shortBadge: shortExt,
      ext,
      canInlinePreview: true,
      isBinaryOffice: false,
    };
  }
  return {
    category: "file",
    format: "binary",
    label: "文件",
    shortBadge: shortExt,
    ext,
    canInlinePreview: false,
    isBinaryOffice: false,
  };
}

export type CategoryCount = {
  category: DeliverableCategory;
  label: string;
  count: number;
};

/** 统计文件 + 媒体的交付物分类计数，供顶部汇总条与筛选胶囊使用。 */
export function summarizeDeliverableCategories(
  files: readonly { path: string }[],
  mediaCount = 0,
): CategoryCount[] {
  const counts = new Map<DeliverableCategory, number>();
  for (const f of files) {
    const cat = classifyDeliverable(f.path).category;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  if (mediaCount > 0) {
    counts.set("media", (counts.get("media") ?? 0) + mediaCount);
  }
  const out: CategoryCount[] = [];
  for (const category of DELIVERABLE_CATEGORY_ORDER) {
    const count = counts.get(category) ?? 0;
    if (count > 0) out.push({ category, label: DELIVERABLE_CATEGORY_LABEL[category], count });
  }
  return out;
}

// ── RFC4180 轻量 CSV / TSV 解析器 ────────────────────────────────────────

export type ParsedTableRow = {
  /** 1-based 行号（包含表头时，第一条数据行为第 2 行，与原始文件行号一致）。 */
  rowNumber: number;
  cells: string[];
};

export type ColumnStat = {
  index: number;
  name: string;
  nonEmptyCount: number;
  numericCount: number;
  isNumeric: boolean;
  min?: number;
  max?: number;
  avg?: number;
  uniqueCount: number;
};

export type ParsedTable = {
  delimiter: "," | "\t";
  headers: string[];
  rows: ParsedTableRow[];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
  hasHeader: boolean;
  columnStats: ColumnStat[];
};

export const DEFAULT_TABLE_MAX_ROWS = 500;

/** 尝试将常见数值单元格（含千分位逗号、货币符号、百分号）解析为有限数字。 */
export function parseNumericCell(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // 排除日期/区间/ID 类字符串
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) return null;
  const cleaned = s.replace(/^[¥$€£]/, "").replace(/%$/, "").replace(/,/g, "").trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function detectDelimiter(text: string): "," | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let tabs = 0;
  let commas = 0;
  let inQuotes = false;
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "\t") tabs += 1;
    else if (!inQuotes && ch === ",") commas += 1;
  }
  return tabs > commas ? "\t" : ",";
}

/**
 * RFC4180 兼容 CSV / TSV 解析器：
 *  - 正确处理双引号包裹字段、双引号转义 (`""` → `"`), 以及引号内换行；
 *  - 自动识别表头行并计算列统计；
 *  - 仅保留前 `maxRows` 行用于安全渲染，同时精确记录总行数。
 */
export function parseDelimitedTable(
  input: string,
  opts: { delimiter?: "," | "\t"; maxRows?: number } = {},
): ParsedTable {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRows = Math.max(1, opts.maxRows ?? DEFAULT_TABLE_MAX_ROWS);

  if (!text.trim()) {
    return {
      delimiter,
      headers: [],
      rows: [],
      totalRows: 0,
      totalColumns: 0,
      truncated: false,
      hasHeader: false,
      columnStats: [],
    };
  }

  // RFC4180 状态机解析：保留每个逻辑记录的起始文件行号
  const records: { line: number; cells: string[] }[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let lineNo = 1;
  let recordStartLine = 1;
  let fieldStart = true;

  const pushRecord = () => {
    row.push(field);
    field = "";
    fieldStart = true;
    // 跳过文件尾部的纯空行
    if (row.length > 1 || row[0].trim() !== "") {
      records.push({ line: recordStartLine, cells: row });
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === "\r" && text[i + 1] === "\n") {
        field += "\n";
        lineNo += 1;
        i += 1;
      } else {
        if (ch === "\n") lineNo += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && fieldStart) {
      inQuotes = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRecord();
      lineNo += 1;
      recordStartLine = lineNo;
    } else if (ch === "\n") {
      pushRecord();
      lineNo += 1;
      recordStartLine = lineNo;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (field !== "" || row.length > 0) {
    pushRecord();
  }

  if (records.length === 0) {
    return {
      delimiter,
      headers: [],
      rows: [],
      totalRows: 0,
      totalColumns: 0,
      truncated: false,
      hasHeader: false,
      columnStats: [],
    };
  }

  const totalColumns = records.reduce((m, r) => Math.max(m, r.cells.length), 0);
  const firstCells = records[0].cells;
  const nonEmptyFirst = firstCells.filter((c) => c.trim() !== "");
  const firstNumericCount = nonEmptyFirst.filter((c) => parseNumericCell(c) !== null).length;
  // 若首行有至少一个非空值，且不是全数字（且若有多行则至少有非数字文本），认定首行为表头
  const hasHeader =
    records.length > 1
      ? nonEmptyFirst.length > 0 && firstNumericCount < nonEmptyFirst.length
      : nonEmptyFirst.length > 0 && firstNumericCount === 0;

  const headers: string[] = [];
  for (let c = 0; c < totalColumns; c += 1) {
    const raw = hasHeader ? (firstCells[c] ?? "").trim() : "";
    headers.push(raw || `列 ${c + 1}`);
  }

  const dataRecords = hasHeader ? records.slice(1) : records;
  const totalRows = dataRecords.length;
  const truncated = totalRows > maxRows;
  const slice = truncated ? dataRecords.slice(0, maxRows) : dataRecords;
  const rows: ParsedTableRow[] = slice.map((r) => {
    const cells = new Array<string>(totalColumns);
    for (let c = 0; c < totalColumns; c += 1) cells[c] = r.cells[c] ?? "";
    return { rowNumber: r.line, cells };
  });

  // 列统计基于安全渲染切片计算，避免超大文件卡顿主线程
  const columnStats: ColumnStat[] = headers.map((name, index) => {
    let nonEmptyCount = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const unique = new Set<string>();
    for (const r of rows) {
      const val = (r.cells[index] ?? "").trim();
      if (!val) continue;
      nonEmptyCount += 1;
      if (unique.size <= 500) unique.add(val);
      const num = parseNumericCell(val);
      if (num !== null) {
        numericCount += 1;
        sum += num;
        if (num < min) min = num;
        if (num > max) max = num;
      }
    }
    const isNumeric = nonEmptyCount > 0 && numericCount / nonEmptyCount >= 0.7;
    return {
      index,
      name,
      nonEmptyCount,
      numericCount,
      isNumeric,
      ...(isNumeric && numericCount > 0 ? { min, max, avg: sum / numericCount } : {}),
      uniqueCount: unique.size,
    };
  });

  return {
    delimiter,
    headers,
    rows,
    totalRows,
    totalColumns,
    truncated,
    hasHeader,
    columnStats,
  };
}

/** 对表格数据行做关键词搜索过滤与列排序（数值列按数字排，文本列按中文 locale 排）。 */
export function filterAndSortTableRows(
  table: ParsedTable,
  opts: { query?: string; sortCol?: number | null; sortDir?: "asc" | "desc" },
): ParsedTableRow[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const filtered = q
    ? table.rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q)))
    : [...table.rows];

  const col = opts.sortCol;
  if (col === null || col === undefined || col < 0 || col >= table.totalColumns) {
    return filtered;
  }
  const dir = opts.sortDir === "desc" ? -1 : 1;
  const colIsNumeric = table.columnStats[col]?.isNumeric ?? false;

  return filtered.sort((a, b) => {
    const va = (a.cells[col] ?? "").trim();
    const vb = (b.cells[col] ?? "").trim();
    if (!va && !vb) return a.rowNumber - b.rowNumber;
    if (!va) return 1;
    if (!vb) return -1;
    if (colIsNumeric) {
      const na = parseNumericCell(va);
      const nb = parseNumericCell(vb);
      if (na !== null && nb !== null && na !== nb) return (na - nb) * dir;
    }
    const cmp = va.localeCompare(vb, "zh-CN", { numeric: true, sensitivity: "base" });
    return cmp !== 0 ? cmp * dir : a.rowNumber - b.rowNumber;
  });
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 将表头与当前切片行序列化为标准 RFC4180 CSV 文本（用于一键复制切片）。 */
export function serializeCsvSlice(
  headers: readonly string[],
  rows: readonly ParsedTableRow[],
  maxRows = 200,
): string {
  const out: string[] = [headers.map(escapeCsvCell).join(",")];
  const limit = Math.min(rows.length, Math.max(1, maxRows));
  for (let i = 0; i < limit; i += 1) {
    out.push(rows[i].cells.map(escapeCsvCell).join(","));
  }
  return out.join("\n");
}

// ── Markdown 幻灯片与长文档大纲提取 ──────────────────────────────────────

export type SlideItem = {
  index: number;
  title: string;
  markdown: string;
  notes?: string;
  lineStart: number;
  lineEnd: number;
};

export type ParsedDeck = {
  isSlideDeck: boolean;
  title: string;
  slides: SlideItem[];
  hasFrontmatter: boolean;
};

function stripFrontmatter(lines: string[]): { bodyStartIndex: number; frontmatter: string; hasFrontmatter: boolean } {
  if (lines[0]?.trim() !== "---") {
    return { bodyStartIndex: 0, frontmatter: "", hasFrontmatter: false };
  }
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      const fm = lines.slice(1, i).join("\n");
      // 仅当包含 key: value 结构时才视为 YAML frontmatter（避免把普通文档开头的分隔线误判）
      if (/^[a-zA-Z0-9_-]+\s*:/m.test(fm)) {
        return { bodyStartIndex: i + 1, frontmatter: fm, hasFrontmatter: true };
      }
      return { bodyStartIndex: 0, frontmatter: "", hasFrontmatter: false };
    }
  }
  return { bodyStartIndex: 0, frontmatter: "", hasFrontmatter: false };
}

function extractSlideNotes(md: string): { body: string; notes?: string } {
  const notes: string[] = [];
  const body = md
    .replace(/<!--([\s\S]*?)-->/g, (full, inner: string) => {
      const trimmed = inner.trim();
      // Marp 指令（_class, _paginate, _backgroundColor 等）不算演讲备注
      if (!trimmed || /^_[a-zA-Z]+\s*:/.test(trimmed)) return "";
      const cleaned = trimmed.replace(/^notes?\s*:\s*/i, "").trim();
      if (cleaned) notes.push(cleaned);
      return "";
    })
    .trim();
  return { body, notes: notes.length > 0 ? notes.join("\n\n") : undefined };
}

function firstHeadingOf(md: string): string | null {
  let inFence = false;
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,3}\s+(.+?)\s*#*$/.exec(trimmed);
    if (m) return m[1].replace(/[*_`~]/g, "").trim();
  }
  return null;
}

/**
 * 解析 Markdown 幻灯片（`---` 分页，自动跳过 frontmatter 与代码围栏内的 `---`）。
 * 同步识别 Marp / reveal.js / Slidev 语法或典型演示文稿结构。
 */
export function parseMarkdownSlides(markdown: string, filePath?: string): ParsedDeck {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const { bodyStartIndex, frontmatter, hasFrontmatter } = stripFrontmatter(lines);
  const fmSlideHint = hasFrontmatter && /^(?:marp|paginate|reveal|slidev|theme|transition)\s*:/im.test(frontmatter);
  const fmTitle = hasFrontmatter ? /^title\s*:\s*["']?(.+?)["']?\s*$/im.exec(frontmatter)?.[1]?.trim() : undefined;

  const chunks: { lines: string[]; lineStart: number; lineEnd: number }[] = [];
  let cur: string[] = [];
  let curStart = bodyStartIndex + 1;
  let inFence = false;

  for (let i = bodyStartIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      cur.push(line);
      continue;
    }
    if (!inFence && /^-{3,}$/.test(trimmed)) {
      if (cur.some((l) => l.trim() !== "")) {
        chunks.push({ lines: cur, lineStart: curStart, lineEnd: i });
      }
      cur = [];
      curStart = i + 2;
      continue;
    }
    cur.push(line);
  }
  if (cur.some((l) => l.trim() !== "")) {
    chunks.push({ lines: cur, lineStart: curStart, lineEnd: lines.length });
  }

  const slides: SlideItem[] = chunks.map((chunk, idx) => {
    const raw = chunk.lines.join("\n").trim();
    const { body, notes } = extractSlideNotes(raw);
    const title = firstHeadingOf(body) ?? `第 ${idx + 1} 页`;
    return {
      index: idx + 1,
      title,
      markdown: body,
      ...(notes ? { notes } : {}),
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
    };
  });

  const nameHint = filePath ? SLIDE_FILENAME_RE.test(fileBaseName(filePath)) : false;
  const headingSlides = slides.filter((s) => firstHeadingOf(s.markdown) !== null).length;
  const multiSlideStructure = slides.length >= 3 && headingSlides / slides.length >= 0.6;
  const isSlideDeck =
    slides.length >= 2 && (fmSlideHint || nameHint || multiSlideStructure);

  const deckTitle = fmTitle || slides[0]?.title || (filePath ? fileBaseName(filePath) : "演示文稿");
  return { isSlideDeck, title: deckTitle, slides, hasFrontmatter };
}

export type OutlineHeading = {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  line: number;
};

export type DocumentStats = {
  charCount: number;
  wordCount: number;
  lineCount: number;
  readingMinutes: number;
  headingCount: number;
  codeBlockCount: number;
  tableCount: number;
};

export type DocumentAnalysis = {
  headings: OutlineHeading[];
  stats: DocumentStats;
  hasSlideDividers: boolean;
};

function slugifyHeading(text: string, idx: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `sec-${idx + 1}${slug ? `-${slug}` : ""}`;
}

/** 提取长文档 H1–H3 目录大纲与中英文混排字数/阅读时长统计。 */
export function extractMarkdownOutline(markdown: string): DocumentAnalysis {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const { bodyStartIndex } = stripFrontmatter(lines);
  const headings: OutlineHeading[] = [];
  let inFence = false;
  let codeBlockCount = 0;
  let tableCount = 0;
  let inTable = false;
  let dividerCount = 0;

  for (let i = bodyStartIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (!inFence) codeBlockCount += 1;
      inFence = !inFence;
      inTable = false;
      continue;
    }
    if (inFence) continue;

    if (/^-{3,}$/.test(trimmed)) {
      dividerCount += 1;
      inTable = false;
      continue;
    }

    const hm = /^(#{1,3})\s+(.+?)\s*#*$/.exec(trimmed);
    if (hm) {
      const level = hm[1].length as 1 | 2 | 3;
      const text = hm[2].replace(/[*_`~]/g, "").trim();
      if (text) {
        headings.push({
          id: slugifyHeading(text, headings.length),
          level,
          text,
          line: i + 1,
        });
      }
      inTable = false;
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      if (!inTable && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        tableCount += 1;
        inTable = true;
      }
    } else {
      inTable = false;
    }
  }

  const bodyText = lines.slice(bodyStartIndex).join("\n");
  const stripped = bodyText.replace(/```[\s\S]*?```/g, " ").replace(/[#>*`~[\]()|_-]/g, " ");
  const cjkChars = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const latinWords = (stripped.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9]+/g) ?? []).length;
  const wordCount = cjkChars + latinWords;
  const charCount = bodyText.replace(/\s+/g, "").length;
  const readingMinutes = Math.max(1, Math.ceil(wordCount / 350));

  return {
    headings,
    stats: {
      charCount,
      wordCount,
      lineCount: lines.length,
      readingMinutes,
      headingCount: headings.length,
      codeBlockCount,
      tableCount,
    },
    hasSlideDividers: dividerCount >= 1,
  };
}

// ── 批注回填提示词生成器 ────────────────────────────────────────────────

export type AnnotationAnchor =
  | { kind: "slide"; page: number; title?: string }
  | { kind: "cell"; sheet: string; ref: string; value?: string; formula?: string }
  | { kind: "table-row"; rowNumber: number; columnsSummary?: string }
  | { kind: "section"; heading: string; line?: number }
  | { kind: "code-line"; lineStart: number; lineEnd?: number }
  | { kind: "file" };

export type AnnotationDraftInput = {
  filePath: string;
  fileName?: string;
  category?: DeliverableCategory;
  anchor: AnnotationAnchor;
  comment: string;
  excerpt?: string;
};

/** 将批注锚点格式化为简明可读的中文定位标签。 */
export function formatAnchorLabel(anchor: AnnotationAnchor): string {
  switch (anchor.kind) {
    case "slide":
      return anchor.title && anchor.title !== `第 ${anchor.page} 页`
        ? `第 ${anchor.page} 页（${anchor.title}）`
        : `第 ${anchor.page} 页`;
    case "cell":
      return `工作表「${anchor.sheet}」单元格 ${anchor.ref}`;
    case "table-row":
      return anchor.columnsSummary
        ? `第 ${anchor.rowNumber} 行（${anchor.columnsSummary}）`
        : `第 ${anchor.rowNumber} 行`;
    case "section":
      return anchor.line
        ? `章节「${anchor.heading}」（第 ${anchor.line} 行）`
        : `章节「${anchor.heading}」`;
    case "code-line":
      return anchor.lineEnd && anchor.lineEnd > anchor.lineStart
        ? `第 ${anchor.lineStart}–${anchor.lineEnd} 行`
        : `第 ${anchor.lineStart} 行`;
    case "file":
      return "整份交付物";
  }
}

/** 生成结构化交付物精修指令，供直接回填 Composer 或复制发送给助手。 */
export function buildAnnotationPrompt(input: AnnotationDraftInput): string {
  const comment = input.comment.trim();
  const anchorText = formatAnchorLabel(input.anchor);
  const lines: string[] = [
    `请根据以下批注精修交付物 \`${input.filePath}\`（定位：${anchorText}）：`,
    `修改要求：${comment || "请优化该处内容与表达。"}`,
  ];
  const excerpt = input.excerpt?.trim();
  if (excerpt) {
    const clean = excerpt.replace(/\s+/g, " ").slice(0, 180);
    lines.push(`定位参考：${clean}${excerpt.length > 180 ? "…" : ""}`);
  }
  return lines.join("\n");
}
