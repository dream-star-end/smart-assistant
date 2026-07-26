/**
 * Structure-aware truncation for the WebFetch secondary-model prompt.
 *
 * Legacy behavior (utils.ts) hard-sliced to the first MAX_MARKDOWN_LENGTH chars
 * and discarded the entire tail — losing conclusions, references, and all later
 * document structure. This keeps the SAME character budget but spends it on the
 * parts a summarizer needs most:
 *   - HEAD  (~50%): the opening (lead / abstract / intro).
 *   - OUTLINE (~30%): every markdown heading in the elided middle plus its first
 *     paragraph, so the model still sees the full section structure and a lead
 *     sentence for each section that falls past the head budget.
 *   - TAIL  (~20%): the closing (conclusions / references / summary tables) that
 *     the old head-only cut dropped entirely.
 *
 * Constraints honored:
 *   - Output length is ALWAYS <= maxLen (same guarantee the old slice gave, so the
 *     downstream model's context budget is respected).
 *   - Pure function: (string, number) -> string. No I/O, no model calls. WebFetch
 *     still makes exactly ONE downstream model call; we never chunk-and-resummarize
 *     (that would multiply cost). This only reshapes WHICH bytes fill the budget.
 *   - When content already fits (<= maxLen) the input is returned verbatim.
 */

const HEAD_FRAC = 0.5;
const TAIL_FRAC = 0.2;
// Reserve room for the two elision markers so assembly never overflows maxLen.
const MARKER_OVERHEAD = 240;
// Cap a single section's captured lead so one huge paragraph can't eat the outline.
const MAX_SECTION_LEAD = 400;
// How far back to hunt for a clean paragraph/line boundary near a cut point.
const BOUNDARY_LOOKBACK = 2000;

const HEADING_RE = /^ {0,3}#{1,6}\s+\S/;

function isHeading(line: string): boolean {
  return HEADING_RE.test(line);
}

/** Largest index <= limit that sits on a clean boundary (paragraph > line > hard). */
function headCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const window = text.slice(Math.max(0, limit - BOUNDARY_LOOKBACK), limit);
  const para = window.lastIndexOf("\n\n");
  if (para >= 0) return Math.max(0, limit - BOUNDARY_LOOKBACK) + para;
  const nl = window.lastIndexOf("\n");
  if (nl >= 0) return Math.max(0, limit - BOUNDARY_LOOKBACK) + nl;
  return limit;
}

/** Start index for the tail slice: last `limit` chars, snapped forward to a boundary. */
function tailStart(text: string, limit: number): number {
  if (text.length <= limit) return 0;
  const raw = text.length - limit;
  const window = text.slice(raw, Math.min(text.length, raw + BOUNDARY_LOOKBACK));
  const para = window.indexOf("\n\n");
  if (para >= 0) return raw + para + 2;
  const nl = window.indexOf("\n");
  if (nl >= 0) return raw + nl + 1;
  return raw;
}

/**
 * From the elided middle region, keep each heading + its first paragraph, in
 * original order, until the outline budget is exhausted. Returns "" when the
 * middle has no headings (plain-text page) — head+tail alone is still strictly
 * better than the old head-only cut, and we avoid emitting incoherent fragments.
 */
function extractOutline(middle: string, budget: number): string {
  if (budget <= 0) return "";
  const lines = middle.split("\n");
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isHeading(lines[i])) continue;
    const heading = lines[i].trim();
    // Collect the first non-empty paragraph after the heading.
    const lead: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++; // skip blanks
    while (j < lines.length && lines[j].trim() !== "" && !isHeading(lines[j])) {
      lead.push(lines[j].trim());
      j++;
    }
    let block = heading;
    const leadText = lead.join(" ").trim();
    if (leadText) block += `\n${leadText.slice(0, MAX_SECTION_LEAD)}`;
    const cost = block.length + 2; // +2 for the joining blank line
    if (used + cost > budget) {
      // Budget exhausted: still try to fit at least the bare heading line.
      if (used + heading.length + 2 <= budget) {
        out.push(heading);
        used += heading.length + 2;
      }
      break;
    }
    out.push(block);
    used += cost;
  }
  return out.join("\n\n");
}

/**
 * Structure-aware truncate. `maxLen` is passed by the caller (single source of
 * truth stays MAX_MARKDOWN_LENGTH in utils.ts) so this module has no import cycle.
 */
export function smartTruncateMarkdown(content: string, maxLen = 100_000): string {
  if (content.length <= maxLen) return content;
  if (maxLen <= 0) return "";

  const usable = Math.max(0, maxLen - MARKER_OVERHEAD);
  const headBudget = Math.floor(usable * HEAD_FRAC);
  const tailBudget = Math.floor(usable * TAIL_FRAC);

  const headEnd = headCut(content, headBudget);
  const head = content.slice(0, headEnd);

  const tStart = Math.max(headEnd, tailStart(content, tailBudget));
  const tail = content.slice(tStart);

  const middle = content.slice(headEnd, tStart);
  const outlineBudget = usable - head.length - tail.length;
  const outline = extractOutline(middle, outlineBudget);

  const parts = [head];
  parts.push(
    outline
      ? "\n\n[⋯ 中段省略,以下按原文顺序保留各节标题与首段(供定位/引用) ⋯]\n\n" + outline
      : "\n\n[⋯ 中段省略 ⋯]",
  );
  parts.push("\n\n[⋯ 以下为原文结尾部分 ⋯]\n\n" + tail);

  const assembled = parts.join("");
  // Hard guarantee: never exceed maxLen (matches the old slice's invariant).
  return assembled.length <= maxLen ? assembled : assembled.slice(0, maxLen);
}
