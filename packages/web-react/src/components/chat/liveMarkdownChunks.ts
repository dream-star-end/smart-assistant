/**
 * OCV5-421: split a streaming answer into top-level Markdown chunks so finished blocks stop
 * being re-parsed on every streamed delta (react-markdown + highlight + KaTeX on the whole
 * text each notify made long answers O(n²) on the main thread).
 *
 * A cut is only made at a blank line that ends a top-level block for good:
 * - outside fenced code and outside `$$` display math;
 * - the next line already exists and starts a new block that cannot continue the previous one
 *   (not indented, not a list item, not a table row, not a blockquote line, not a definition).
 * Then rendering the chunks one after another yields the same block sequence as rendering the
 * whole text. Texts with footnotes or link reference definitions are never split (they resolve
 * across the whole document).
 *
 * Decisions depend only on text before the cut plus the line after it, so once a chunk is
 * emitted it never changes as the text grows — the memoized chunk keeps its exact string.
 */
export const LIVE_CHUNK_MIN_CHARS = 1200;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const NOT_A_FRESH_BLOCK = /^(?:\s|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|\||>|\[[^\]]*\]:|\$\$)/;
const DEFINITIONS = /^ {0,3}\[[^\]\n]+\]:/m;

export function splitLiveMarkdown(text: string, minChars = LIVE_CHUNK_MIN_CHARS): string[] {
  if (text.length < minChars * 2 || DEFINITIONS.test(text)) return [text];
  const out: string[] = [];
  let chunkStart = 0;
  let fence: string | null = null;
  let inMath = false;
  let pos = 0;
  let prevBlank = false;
  let sawContent = false;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break; // last (possibly partial) line: never a cut point
    const line = text.slice(pos, nl);
    const blank = line.trim() === "";
    // Cut decision uses the state *before* this line: a fence opener may start a chunk.
    if (!fence && !inMath && !blank && prevBlank && sawContent && !NOT_A_FRESH_BLOCK.test(line)
      && pos - chunkStart >= minChars) {
      out.push(text.slice(chunkStart, pos));
      chunkStart = pos;
    }
    if (fence) {
      const m = FENCE_OPEN.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
    } else if (!inMath && FENCE_OPEN.test(line)) {
      fence = FENCE_OPEN.exec(line)![1];
    } else if (!blank && (line.match(/\$\$/g) ?? []).length % 2 === 1) {
      inMath = !inMath;
    }
    if (!blank) sawContent = true;
    prevBlank = blank;
    pos = nl + 1;
  }
  out.push(text.slice(chunkStart));
  return out;
}
