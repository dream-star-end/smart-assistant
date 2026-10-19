import { isNextBlockCode } from "./inputPrediction";
import { normalizeInlineUiFences } from "./uiFence";

/** Match the Markdown renderer's hidden input controls without loading the IUI schema.
 * Other UI blocks and fenced code remain visible, including examples containing a nested ui fence. */
export function hasVisibleAssistantContent(text: string): boolean {
  const lines = normalizeInlineUiFences(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/.exec(line);
    if (!open || open[2]!.toLowerCase() !== "ui") return true;
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end]!)) end++;
    if (!isNextBlockCode(lines.slice(i + 1, end).join("\n"), end === lines.length)) return true;
    i = end;
  }
  return false;
}
