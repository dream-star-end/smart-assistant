import { isFoldableWorkRole } from "../../components/chat/ProcessDisclosure";
import { uiPlainText } from "../../components/iui/plainText";
import { BRAND } from "../brand";
import { sessionExportFilename } from "./exportMarkdown";
import type { ChatMessage } from "./model";
import { isAutoContinueMsg, isRecoveryControlUserTurn } from "./pure";

/**
 * 会话分享长图(OCV5-369)。
 * 分享物 = 浏览器本地画的一张 PNG 长图 + 一段可直接粘贴的文字,不出公开链接,不过服务端。
 * 只收 user / assistant 正文;thinking、tool、过程卡等一律不进分享物(不外泄工具输入和内部过程)。
 * 排版是纯函数(measure 可注入,单测不需要 canvas),renderShareCard 才碰 canvas。
 */

export type ShareRange = "last" | "last3" | "all";

export type ShareMessage = { role: "user" | "assistant"; text: string };

/** 单条消息最多画这么多行,超出截断。 */
export const SHARE_MAX_LINES_PER_MESSAGE = 80;
/** 逻辑像素宽与倍率:输出 1080px 宽。 */
export const SHARE_WIDTH = 540;
export const SHARE_SCALE = 2;
/** 逻辑高度上限:7600 × 2 × 1080 ≈ 16.4M 像素,低于 iOS Safari 画布面积上限(16.7M)。 */
export const SHARE_MAX_HEIGHT = 7600;

/** 聊天视图本来就不显示的行(与 MessageRenderer 的 renderableMessages 同口径)。 */
function hiddenInChat(m: ChatMessage): boolean {
  const id = typeof m.id === "string" ? m.id : "";
  return (
    (m as ChatMessage & { _historyProjection?: unknown })._historyProjection !== undefined ||
    id.startsWith("projection-") ||
    id.startsWith("oc-dispatch-err:") ||
    m._turnTapeProcess === true ||
    m._timelineAuxiliary !== undefined ||
    isRecoveryControlUserTurn(m) ||
    (m.role === "user" && isAutoContinueMsg(m))
  );
}

/** 干净的最终正文:非错误、非状态记录、非降级合并行(降级行可能把过程段和答案拼在一起)。 */
function isAnswerBody(m: ChatMessage): boolean {
  return (
    m.role === "assistant" &&
    !m._errorCode &&
    !m._isError &&
    !m.error &&
    !m._turnStatusRecord &&
    !m._genPlaceholder &&
    !m._displayDegraded &&
    m._displayDegradeReason === undefined &&
    (m.text ?? "").trim().length > 0
  );
}

/** 参与「本轮最后一行是谁」判定的行:助手行(含错误/状态记录)和工作行。空正文的助手占位不算。 */
function isTurnTail(m: ChatMessage): boolean {
  if (m.role === "assistant") {
    return (m.text ?? "").trim().length > 0 || !!m._errorCode || !!m._isError || !!m.error || !!m._turnStatusRecord;
  }
  return isFoldableWorkRole(m);
}

type Order = { seq: number; ts: number; index: number };

function orderOf(m: ChatMessage, index: number): Order {
  return {
    seq: typeof m._orderSeq === "number" && Number.isSafeInteger(m._orderSeq) && m._orderSeq > 0 ? m._orderSeq : 0,
    ts: typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0,
    index,
  };
}

/** a 是否晚于 b:两行都有 _orderSeq 才比它(本地追加的错误卡等没有),否则比 ts,再比数组下标。 */
function after(a: Order, b: Order): boolean {
  if (a.seq > 0 && b.seq > 0 && a.seq !== b.seq) return a.seq > b.seq;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.index > b.index;
}

/**
 * 按范围挑消息。用户消息 = 真实提问(恢复控制行、自动续接、排队中的不算)。
 * 归轮:行的 _clientMessageId 指向哪条提问就归哪轮(恢复子轮沿 _recoveryOfClientMessageId 归并回原提问);
 * 没有归属的旧行按数组位置归到前一条真实提问。
 * 每轮最多收**一条**助手正文,而且必须是该轮的最后一行(按 after 的顺序,且与数组顺序一致):
 * 最后一行是错误卡、状态记录、降级合并行或工具/思考等工作行时,这一轮没有可分享的回答 ——
 * 宁可只分享问题,也不把「正在读取 …」这类过程文本当答案。`sending` 时进行中那一轮不收回答。
 */
export function selectShareMessages(
  messages: readonly ChatMessage[],
  range: ShareRange,
  sending = false,
): ChatMessage[] {
  // 恢复控制行 → 它所恢复的那条消息。
  const parent = new Map<string, string>();
  for (const m of messages) {
    if (!isRecoveryControlUserTurn(m) || !m._recoveryOfClientMessageId) continue;
    parent.set(m.id, m._recoveryOfClientMessageId);
    if (m._clientMessageId) parent.set(m._clientMessageId, m._recoveryOfClientMessageId);
  }
  const root = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur) as string;
    }
    return cur;
  };

  // tail = 按 after 排序的最后一行;lastIndex = 数组里最后一行。两者一致才认这条回答。
  type Turn = { user: ChatMessage | null; tail: { m: ChatMessage; order: Order } | null; lastIndex: ChatMessage | null };
  const turns: Turn[] = [{ user: null, tail: null, lastIndex: null }];
  const byKey = new Map<string, Turn>();
  const rows = messages.filter((m) => !hiddenInChat(m));
  const positional: Turn[] = [];
  for (const m of rows) {
    if (m.role === "user" && m.status !== "queued" && (m.text ?? "").trim()) {
      const turn: Turn = { user: m, tail: null, lastIndex: null };
      turns.push(turn);
      byKey.set(m.id, turn);
      if (m._clientMessageId) byKey.set(m._clientMessageId, turn);
    }
    positional.push(turns[turns.length - 1]);
  }
  rows.forEach((m, i) => {
    if (m.role === "user" || !isTurnTail(m)) return;
    const owned = m._clientMessageId ? byKey.get(root(m._clientMessageId)) : undefined;
    const turn = owned ?? positional[i];
    const order = orderOf(m, i);
    if (!turn.tail || after(order, turn.tail.order)) turn.tail = { m, order };
    turn.lastIndex = m;
  });
  const live = sending ? turns[turns.length - 1] : null;
  const body: ChatMessage[] = [];
  for (const t of turns) {
    if (t.user) body.push(t.user);
    // 两种顺序说法不一时宁可只分享问题(不确定哪条才是最后一行,就不冒险把过程当答案)。
    if (t !== live && t.tail && t.tail.m === t.lastIndex && isAnswerBody(t.tail.m)) body.push(t.tail.m);
  }
  if (range === "all") return body;
  const userIdx: number[] = [];
  body.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length === 0) return body;
  const rounds = range === "last" ? 1 : 3;
  return body.slice(userIdx[Math.max(0, userIdx.length - rounds)]);
}

/** 助手正文里的 ```ui 组件先转成等价 Markdown(与导出同一转换器)。 */
export async function prepareShareMessages(messages: readonly ChatMessage[]): Promise<ShareMessage[]> {
  const out: ShareMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, text: m.role === "assistant" ? await uiPlainText(m.text ?? "") : (m.text ?? "") });
  }
  return out;
}

// ── Markdown 子集 → 块 ───────────────────────────────────────────────────────

export type ShareBlock =
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "row"; cells: string[]; header: boolean }
  | { kind: "rule" };

/** 去掉行内标记,只留文字。 */
export function stripInline(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? `[图片:${alt.trim()}]` : "[图片]"))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => stripInline(c.trim()));
}

export function parseShareBlocks(markdown: string): ShareBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ShareBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: stripInline(para.join("\n")) });
    if (quote.length) blocks.push({ kind: "quote", text: stripInline(quote.join("\n")) });
    para = [];
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = fence[1];
      const lang = fence[2].toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      if (lang === "mermaid") blocks.push({ kind: "para", text: "[图表]" });
      else if (body.join("").trim()) blocks.push({ kind: "code", text: body.join("\n").replace(/\s+$/, "") });
      continue;
    }
    if (line.trim() === "$$") {
      flush();
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") i++;
      blocks.push({ kind: "para", text: "[公式]" });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", text: stripInline(h[1].replace(/\s+#+\s*$/, "")) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.trim().startsWith("|") && line.includes("|", line.indexOf("|") + 1)) {
      flush();
      const next = lines[i + 1] ?? "";
      const header = next.includes("|") && TABLE_SEP.test(next);
      blocks.push({ kind: "row", cells: splitRow(line), header });
      if (header) i++;
      continue;
    }
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const task = /^\[([ xX])\]\s+(.*)$/.exec(ul[2]);
      const marker = task ? (task[1] === " " ? "☐" : "☑") : "•";
      blocks.push({ kind: "item", marker, text: stripInline(task ? task[2] : ul[2]) });
      continue;
    }
    const ol = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      blocks.push({ kind: "item", marker: `${ol[1]}.`, text: stripInline(ol[2]) });
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      if (para.length) {
        blocks.push({ kind: "para", text: stripInline(para.join("\n")) });
        para = [];
      }
      quote.push(q[1]);
      continue;
    }
    if (quote.length) {
      blocks.push({ kind: "quote", text: stripInline(quote.join("\n")) });
      quote = [];
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** 块 → 纯文字(复制文字用)。 */
export function blocksToPlainText(blocks: readonly ShareBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading" || b.kind === "para" || b.kind === "code") out.push(b.text);
    else if (b.kind === "item") out.push(`${b.marker} ${b.text}`);
    else if (b.kind === "quote") out.push(`「${b.text}」`);
    else if (b.kind === "row") out.push(b.cells.join(" | "));
  }
  return out.join("\n");
}

/** 可直接粘贴到聊天软件的文字版。 */
export function shareText(title: string | null | undefined, agentName: string, messages: readonly ShareMessage[]): string {
  const head = `【${(title ?? "").trim() || "新对话"}】`;
  const body = messages.map((m) => `${m.role === "user" ? "我" : agentName}：\n${blocksToPlainText(parseShareBlocks(m.text))}`);
  return [head, ...body, `—— 来自「${BRAND.name} ${BRAND.nameEn}」`].join("\n\n");
}

/** `<会话标题>.png`,命名规则与 Markdown 导出一致。 */
export function shareImageFilename(title: string | null | undefined): string {
  return sessionExportFilename(title).replace(/\.md$/, ".png");
}

// ── 换行 ────────────────────────────────────────────────────────────────────

export type Measure = (text: string, font: string) => number;

// 行首禁则:这些标点不放到行首,放不下时挂在上一行行尾。
const NO_LINE_START = new Set([..."，。、；：！？）》」』】,.;:!?)]}%…—"]);
// 拉丁/数字连续串(带尾随空白)整体换行;其余逐字符(CJK 可在任意字间断开)。
const TOKEN = /[A-Za-z0-9_\-.'’/@#&+=%:]+\s*|\s+|[\s\S]/gu;

export function wrapText(text: string, maxWidth: number, font: string, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const tokens = para.match(TOKEN) ?? [];
    let line = "";
    for (const tok of tokens) {
      if (measure(line + tok, font) <= maxWidth || (line && NO_LINE_START.has(tok))) {
        line += tok;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = "";
      const t = tok.trimStart();
      if (measure(t, font) <= maxWidth) {
        line = t;
        continue;
      }
      // 单个超长串(URL、长哈希)按字符硬断。
      for (const ch of t) {
        if (line && measure(line + ch, font) > maxWidth) {
          out.push(line);
          line = "";
        }
        line += ch;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// ── 排版 ────────────────────────────────────────────────────────────────────

export const SHARE_SANS =
  '"Inter Variable", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';
export const SHARE_MONO =
  'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", "Noto Sans CJK SC", monospace';

const C = {
  bg: "#f4f4f1",
  card: "#ffffff",
  fg: "#15151b",
  muted: "#6b6b76",
  border: "#e6e6e3",
  brand: "#c7ff64",
  brandFg: "#0a0b09",
  user: "#17171d",
  userFg: "#ffffff",
  codeBg: "#f3f3f6",
  quote: "#d6d6dd",
  accent: "#5a3fee",
};

const F = {
  brand: `800 15px ${SHARE_SANS}`,
  mark: `900 15px ${SHARE_SANS}`,
  title: `700 22px ${SHARE_SANS}`,
  meta: `400 12px ${SHARE_SANS}`,
  who: `600 12px ${SHARE_SANS}`,
  body: `400 15px ${SHARE_SANS}`,
  bold: `700 15px ${SHARE_SANS}`,
  heading: `700 16px ${SHARE_SANS}`,
  code: `400 13px ${SHARE_MONO}`,
  note: `400 12px ${SHARE_SANS}`,
  footer: `600 13px ${SHARE_SANS}`,
};

const LH = { body: 24, code: 20, title: 30, meta: 18, note: 18 };
const PAD = 20;
const CARD_PAD = 16;
const GAP = 16;

export type DrawOp =
  | { t: "rect"; x: number; y: number; w: number; h: number; r: number; fill: string; stroke?: string }
  | { t: "text"; x: number; y: number; text: string; font: string; color: string; align?: "left" | "right" | "center" };

type Section = { height: number; ops: DrawOp[] };

function shift(ops: readonly DrawOp[], dy: number): DrawOp[] {
  return ops.map((o) => ({ ...o, y: o.y + dy }));
}

type Line = {
  text: string;
  font: string;
  color: string;
  indent: number;
  lh: number;
  /** 连续同 bg 的行合成一块底(代码灰底 / 引用竖线 / 表格框)。 */
  bg?: "code" | "quote" | "table";
  /** 表格行:各单元格文字与相对 x。 */
  cells?: { text: string; x: number }[];
  header?: boolean;
};

const CELL_PAD = 10;

/** 表格能横向放下(每格单行)时画成网格,否则退回「列1 · 列2」逐行文字。 */
function tableLines(rows: Extract<ShareBlock, { kind: "row" }>[], width: number, measure: Measure, fg: string): Line[] | null {
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const widths = new Array<number>(cols).fill(0);
  for (const r of rows) {
    r.cells.forEach((c, i) => {
      widths[i] = Math.max(widths[i], measure(c, r.header ? F.bold : F.body) + CELL_PAD * 2);
    });
  }
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > width) return null;
  // 富余宽度平均分给各列,表格铺满卡片内宽。
  const extra = (width - total) / cols;
  const xs: number[] = [];
  let x = 0;
  for (const w of widths) {
    xs.push(x + CELL_PAD);
    x += w + extra;
  }
  return rows.map((r) => ({
    text: "",
    font: r.header ? F.bold : F.body,
    color: fg,
    indent: 0,
    lh: LH.body + 12,
    bg: "table" as const,
    header: r.header,
    cells: r.cells.map((c, i) => ({ text: c, x: xs[i] })),
  }));
}

/** 一条消息的正文行(含截断)。 */
function messageLines(
  m: ShareMessage,
  width: number,
  measure: Measure,
  fg: string,
): { lines: Line[]; truncated: boolean } {
  const lines: Line[] = [];
  const push = (text: string, font: string, color: string, indent: number, lh: number, bg?: Line["bg"]) => {
    for (const l of wrapText(text, width - indent - (bg === "code" ? 20 : bg === "quote" ? 12 : 0), font, measure)) {
      lines.push({ text: l, font, color, indent, lh, bg });
    }
  };
  const spacer = (lh: number, bg?: Line["bg"]) => lines.push({ text: "", font: F.body, color: fg, indent: 0, lh, bg });
  const blocks = m.role === "user" ? [{ kind: "para", text: m.text.trim() } as ShareBlock] : parseShareBlocks(m.text);
  let prev: ShareBlock["kind"] | null = null;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (prev && !(prev === "item" && b.kind === "item")) spacer(8);
    prev = b.kind;
    if (b.kind === "heading") push(b.text, F.heading, fg, 0, LH.body);
    else if (b.kind === "para") push(b.text, F.body, fg, 0, LH.body);
    else if (b.kind === "quote") push(b.text, F.body, C.muted, 0, LH.body, "quote");
    else if (b.kind === "code") {
      spacer(8, "code");
      push(b.text, F.code, fg, 0, LH.code, "code");
      spacer(8, "code");
    } else if (b.kind === "rule") lines.push({ text: "────────", font: F.body, color: C.border, indent: 0, lh: LH.body });
    else if (b.kind === "row") {
      const rows: Extract<ShareBlock, { kind: "row" }>[] = [b];
      while (blocks[bi + 1]?.kind === "row") rows.push(blocks[++bi] as Extract<ShareBlock, { kind: "row" }>);
      const grid = tableLines(rows, width, measure, fg);
      if (grid) lines.push(...grid);
      else for (const r of rows) push(r.cells.filter(Boolean).join("  ·  "), r.header ? F.bold : F.body, fg, 0, LH.body);
    } else if (b.kind === "item") {
      const markerW = Math.max(measure(`${b.marker} `, F.body), 14);
      const wrapped = wrapText(b.text, width - markerW, F.body, measure);
      wrapped.forEach((l, idx) => {
        lines.push({ text: idx === 0 ? `${b.marker}\u0000${l}` : l, font: F.body, color: fg, indent: markerW, lh: LH.body });
      });
    }
  }
  let truncated = false;
  let textLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].lh >= LH.code) textLines++;
    if (textLines > SHARE_MAX_LINES_PER_MESSAGE) {
      lines.length = i;
      truncated = true;
      break;
    }
  }
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (last.text !== "" || last.cells || last.lh >= LH.code || last.bg) break;
    lines.pop();
  }
  return { lines, truncated };
}

function drawLines(lines: readonly Line[], x: number, y: number, width: number, ops: DrawOp[]): number {
  let cy = y;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.bg) {
      // 连续同底色行合成一块底;高度就是这些行的行高之和(留白也是行),绘制与排版高度一致。
      let j = i;
      let h = 0;
      while (j < lines.length && lines[j].bg === l.bg) h += lines[j++].lh;
      if (l.bg === "code") ops.push({ t: "rect", x, y: cy, w: width, h, r: 8, fill: C.codeBg });
      else if (l.bg === "quote") ops.push({ t: "rect", x, y: cy, w: 3, h, r: 1.5, fill: C.quote });
      else ops.push({ t: "rect", x, y: cy, w: width, h, r: 8, fill: C.card, stroke: C.border });
      for (let k = i; k < j; k++) {
        const line = lines[k];
        if (line.cells) {
          if (line.header) ops.push({ t: "rect", x: x + 1, y: cy + 1, w: width - 2, h: line.lh - 1, r: 7, fill: C.codeBg });
          else if (k > i) ops.push({ t: "rect", x, y: cy, w: width, h: 1, r: 0, fill: C.border });
          for (const c of line.cells) {
            ops.push({ t: "text", x: x + c.x, y: cy + 9, text: c.text, font: line.font, color: line.color });
          }
        } else if (line.text) {
          ops.push({ t: "text", x: x + (l.bg === "code" ? 10 : 12), y: cy + 3, text: line.text, font: line.font, color: line.color });
        }
        cy += line.lh;
      }
      i = j;
      continue;
    }
    if (l.text.includes("\u0000")) {
      const [marker, rest] = l.text.split("\u0000");
      ops.push({ t: "text", x, y: cy + 3, text: marker, font: l.font, color: C.muted });
      ops.push({ t: "text", x: x + l.indent, y: cy + 3, text: rest, font: l.font, color: l.color });
    } else if (l.text) {
      ops.push({ t: "text", x: x + l.indent, y: cy + 3, text: l.text, font: l.font, color: l.color });
    }
    cy += l.lh;
    i++;
  }
  return cy - y;
}

function truncNote(): Line {
  return { text: "……(内容较长，已截断)", font: F.note, color: C.muted, indent: 0, lh: LH.note + 6 };
}

function userSection(m: ShareMessage, measure: Measure): Section {
  const maxBubble = SHARE_WIDTH - PAD * 2 - 56;
  const inner = maxBubble - CARD_PAD * 2;
  const { lines, truncated } = messageLines(m, inner, measure, C.userFg);
  if (truncated) lines.push({ ...truncNote(), color: "#b8b8c2" });
  const textW = Math.max(...lines.map((l) => measure(l.text, l.font)), 20);
  const w = Math.min(maxBubble, textW + CARD_PAD * 2);
  const h = lines.reduce((s, l) => s + l.lh, 0) + 24;
  const x = SHARE_WIDTH - PAD - w;
  const ops: DrawOp[] = [{ t: "rect", x, y: 0, w, h, r: 16, fill: C.user }];
  drawLines(lines, x + CARD_PAD, 12, w - CARD_PAD * 2, ops);
  return { height: h, ops };
}

function assistantSection(m: ShareMessage, agentName: string, measure: Measure): Section {
  const cardW = SHARE_WIDTH - PAD * 2;
  const inner = cardW - CARD_PAD * 2;
  const { lines, truncated } = messageLines(m, inner, measure, C.fg);
  if (truncated) lines.push(truncNote());
  const ops: DrawOp[] = [
    { t: "rect", x: PAD, y: 3, w: 12, h: 12, r: 6, fill: C.brand },
    { t: "text", x: PAD + 18, y: 1, text: agentName, font: F.who, color: C.muted },
  ];
  const top = 24;
  const bodyH = lines.reduce((s, l) => s + l.lh, 0);
  const cardH = bodyH + CARD_PAD * 2;
  ops.push({ t: "rect", x: PAD, y: top, w: cardW, h: cardH, r: 14, fill: C.card, stroke: C.border });
  drawLines(lines, PAD + CARD_PAD, top + CARD_PAD, inner, ops);
  return { height: top + cardH, ops };
}

export type ShareCardInput = {
  title: string | null | undefined;
  agentName: string;
  messages: readonly ShareMessage[];
  /** 分享时刻(页眉日期)。 */
  now: Date;
};

export type ShareLayout = { width: number; height: number; ops: DrawOp[]; omitted: number };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function layoutShareCard(input: ShareCardInput, measure: Measure, maxHeight = SHARE_MAX_HEIGHT): ShareLayout {
  const W = SHARE_WIDTH;
  const head: DrawOp[] = [];
  // 品牌行
  head.push({ t: "rect", x: PAD, y: PAD, w: 28, h: 28, r: 8, fill: C.brand });
  head.push({ t: "text", x: PAD + 14, y: PAD + 6, text: "从", font: F.mark, color: C.brandFg, align: "center" });
  head.push({ t: "text", x: PAD + 38, y: PAD + 6, text: `${BRAND.name} · ${BRAND.nameEn}`, font: F.brand, color: C.fg });
  let y = PAD + 28 + 18;
  const titleLines = wrapText((input.title ?? "").trim() || "新对话", W - PAD * 2, F.title, measure).slice(0, 3);
  for (const l of titleLines) {
    head.push({ t: "text", x: PAD, y, text: l, font: F.title, color: C.fg });
    y += LH.title;
  }
  const d = input.now;
  const rounds = input.messages.filter((m) => m.role === "user").length;
  const meta = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}${rounds ? ` · ${rounds} 轮对话` : ""} · 与「${input.agentName}」`;
  head.push({ t: "text", x: PAD, y: y + 2, text: meta, font: F.meta, color: C.muted });
  y += LH.meta + 18;
  const headH = y;

  const footH = 76;
  const sections = input.messages.map((m) =>
    m.role === "user" ? userSection(m, measure) : assistantSection(m, input.agentName, measure),
  );
  // 超高时保留最新的消息。
  const noteH = 34;
  let budget = maxHeight - headH - footH - noteH;
  let start = sections.length;
  while (start > 0 && budget - sections[start - 1].height - GAP >= 0) {
    budget -= sections[start - 1].height + GAP;
    start--;
  }
  if (start === sections.length && sections.length) start = sections.length - 1; // 最新一条至少保留
  const omitted = start;

  const ops: DrawOp[] = [{ t: "rect", x: 0, y: 0, w: W, h: 0, r: 0, fill: C.bg }, ...head];
  if (omitted) {
    ops.push({ t: "text", x: W / 2, y: y + 4, text: `前面 ${omitted} 条消息未包含`, font: F.note, color: C.muted, align: "center" });
    y += noteH;
  }
  for (let i = start; i < sections.length; i++) {
    ops.push(...shift(sections[i].ops, y));
    y += sections[i].height + GAP;
  }
  // 页脚
  y += 8;
  ops.push({ t: "rect", x: PAD, y, w: W - PAD * 2, h: 1, r: 0, fill: C.border });
  y += 18;
  ops.push({ t: "rect", x: PAD, y, w: 22, h: 22, r: 6, fill: C.brand });
  ops.push({ t: "text", x: PAD + 11, y: y + 4, text: "从", font: `900 12px ${SHARE_SANS}`, color: C.brandFg, align: "center" });
  ops.push({ t: "text", x: PAD + 30, y: y + 3, text: `由 ${BRAND.name} ${BRAND.nameEn} 生成`, font: F.footer, color: C.fg });
  ops.push({ t: "text", x: W - PAD, y: y + 4, text: BRAND.slogan, font: F.note, color: C.muted, align: "right" });
  y += 22 + 8;
  ops.push({ t: "text", x: PAD, y, text: "内容由 AI 生成，仅供参考", font: F.note, color: "#9a9aa3" });
  y += LH.note + PAD;
  const height = Math.ceil(Math.min(y, maxHeight));
  (ops[0] as Extract<DrawOp, { t: "rect" }>).h = height;
  return { width: W, height, ops, omitted };
}

// ── 绘制 ────────────────────────────────────────────────────────────────────

export class ShareRenderError extends Error {}

/** 画出长图 PNG。没有 canvas(老 WebView / jsdom)时抛 ShareRenderError。 */
export async function renderShareCard(input: ShareCardInput): Promise<{ blob: Blob; layout: ShareLayout }> {
  if (typeof document === "undefined") throw new ShareRenderError("no document");
  try {
    await document.fonts?.ready;
  } catch {
    /* 字体没就绪也照画,回落系统字体 */
  }
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new ShareRenderError("canvas unavailable");
  const measure: Measure = (text, font) => {
    probe.font = font;
    return probe.measureText(text).width;
  };
  const layout = layoutShareCard(input, measure);
  const canvas = document.createElement("canvas");
  canvas.width = layout.width * SHARE_SCALE;
  canvas.height = layout.height * SHARE_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ShareRenderError("canvas unavailable");
  ctx.scale(SHARE_SCALE, SHARE_SCALE);
  ctx.textBaseline = "top";
  for (const op of layout.ops) {
    if (op.t === "rect") {
      ctx.beginPath();
      if (op.r > 0 && typeof ctx.roundRect === "function") ctx.roundRect(op.x, op.y, op.w, op.h, op.r);
      else ctx.rect(op.x, op.y, op.w, op.h);
      ctx.fillStyle = op.fill;
      ctx.fill();
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      ctx.font = op.font;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align ?? "left";
      ctx.fillText(op.text, op.x, op.y);
    }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new ShareRenderError("toBlob failed");
  return { blob, layout };
}
