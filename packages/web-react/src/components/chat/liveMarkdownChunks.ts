/**
 * OCV5-421: split a streaming answer into top-level Markdown chunks so finished blocks stop
 * being re-parsed on every streamed delta (react-markdown + highlight + KaTeX on the whole
 * text each notify made long answers O(n²) on the main thread).
 *
 * A cut is only made at a blank line that ends a top-level block for good:
 * - outside fenced code and outside display math (`$$ … $$`, `\[ … \]`; `$$` inside inline code
 *   does not count);
 * - the next line is complete and starts a new block that cannot continue the previous one
 *   (not indented, not a list item, not a table row, not a blockquote line, not a definition,
 *   not a math opener).
 * Then rendering the chunks one after another yields the same block sequence as rendering the
 * whole text.
 *
 * Stability: whether a cut is made before a line depends only on the text up to the end of that
 * line — never on the total length or on anything that arrives later. So once a chunk is emitted
 * it keeps its exact string as the text grows, and nothing that is already mounted moves to
 * another chunk (rich blocks such as option cards keep their state).
 *
 * Footnotes / link reference definitions resolve across the whole document; `hasMarkdownDefinitions`
 * lets the caller fall back to a single render once streaming has ended.
 */
export const LIVE_CHUNK_MIN_CHARS = 1200;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const NOT_A_FRESH_BLOCK = /^(?:\s|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|\||>|\[[^\]]*\]:|\$\$|\\\[)/;
const DEFINITIONS = /^ {0,3}\[[^\]\n]+\]:/m;
/** Stateful rich fences (user choices, iframes): must never be remounted by a re-partition. */
const STATEFUL_FENCE = /^ {0,3}(?:`{3,}|~{3,})\s*(?:options|ui|html|htmlpreview)\b/im;

export function hasMarkdownDefinitions(text: string): boolean {
  return DEFINITIONS.test(text);
}

/** Whether `text` holds a stateful rich block (option card, Intelligent UI, HTML preview). */
export function hasStatefulBlock(text: string): boolean {
  return STATEFUL_FENCE.test(text);
}

/**
 * Removes inline code from one line, continuing a code span left open by earlier lines of the same
 * paragraph (`tick` = length of the open backtick run, 0 = none). Returns the text outside code
 * and the run still open at the end of the line.
 */
function outsideInlineCode(line: string, tick: number): { bare: string; tick: number } {
  let bare = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      if (tick === 0) bare += line[i];
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j++;
    const run = j - i;
    if (tick === 0) tick = run;
    else if (run === tick) tick = 0;
    i = j;
  }
  return { bare, tick };
}

export function splitLiveMarkdown(text: string, minChars = LIVE_CHUNK_MIN_CHARS): string[] {
  const out: string[] = [];
  let chunkStart = 0;
  let fence: string | null = null;
  let dollarMath = false;
  let bracketMath = false;
  let pos = 0;
  let prevBlank = false;
  let sawContent = false;
  let codeTick = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break; // last (possibly partial) line: never a cut point
    const line = text.slice(pos, nl);
    const blank = line.trim() === "";
    // Cut decision uses the state *before* this line: a fence opener may start a chunk.
    if (!fence && !dollarMath && !bracketMath && !blank && prevBlank && sawContent
      && !NOT_A_FRESH_BLOCK.test(line) && pos - chunkStart >= minChars) {
      out.push(text.slice(chunkStart, pos));
      chunkStart = pos;
    }
    if (fence) {
      const m = FENCE_OPEN.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
    } else if (!dollarMath && !bracketMath && FENCE_OPEN.test(line)) {
      fence = FENCE_OPEN.exec(line)![1];
    } else if (blank) {
      codeTick = 0; // a code span never crosses a paragraph
    } else {
      const scanned = outsideInlineCode(line, codeTick);
      codeTick = scanned.tick;
      const bare = scanned.bare;
      if ((bare.match(/\$\$/g) ?? []).length % 2 === 1) dollarMath = !dollarMath;
      if (!dollarMath) {
        const opens = (bare.match(/\\\[/g) ?? []).length;
        const closes = (bare.match(/\\\]/g) ?? []).length;
        if (!bracketMath && opens > closes) bracketMath = true;
        else if (bracketMath && closes > 0 && closes >= opens) bracketMath = false;
      }
    }
    if (!blank) sawContent = true;
    prevBlank = blank;
    pos = nl + 1;
  }
  out.push(text.slice(chunkStart));
  return out;
}
