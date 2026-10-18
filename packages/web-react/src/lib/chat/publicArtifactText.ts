type MarkdownNode = {
  type: string; value?: string; url?: string; alt?: string; identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** A portable artifact reference, never a rewrite of arbitrary filesystem paths. */
function artifactRelative(path: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  const match = /^\/(?:home\/agent|root)\/\.openclaude\/(?:generated|uploads)\/(.+)$/.exec(decoded);
  if (!match || /[\r\n?#<>]|\s+-|\s+\//.test(match[1]!)) return null;
  const relative = match[1]!;
  return relative.split("/").some((part) => !part || part === "." || part === "..") ? null : relative;
}

function labelText(node: MarkdownNode): string {
  return node.value ?? node.alt ?? (node.children ?? []).map(labelText).join("");
}

/** Output-only formatting. Preserve user text and executable code; do not change stored messages. */
export async function publicArtifactText(markdown: string): Promise<string> {
  if (!/\/(?:home\/agent|root)\/\.openclaude\/(?:generated|uploads)\//.test(markdown)) return markdown;
  const { fromMarkdown } = await import("mdast-util-from-markdown");
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const definitions = new Map((tree.children ?? []).filter((node) => node.type === "definition").map((node) => [node.identifier, node.url ?? ""]));
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = markdown.slice(start, end);
    let replacement: string | null = null;
    if (node.type === "code") return; // Useful source code must remain runnable, including its paths.
    if (node.type === "definition") {
      if (artifactRelative(node.url ?? "")) replacement = "";
    } else if (["link", "image", "linkReference", "imageReference"].includes(node.type)) {
      const relative = artifactRelative(node.url ?? definitions.get(node.identifier) ?? "");
      if (relative) {
        const label = labelText(node).trim().replace(/\/(?:home\/agent|root)\/\.openclaude\/(?:generated|uploads)\//g, "");
        replacement = label.includes(relative) ? label : label ? `${label}（${relative}）` : relative;
      } else if (node.type === "link") return; // Preserve ordinary URLs and their labels verbatim.
    } else if (node.type === "inlineCode") {
      const relative = artifactRelative(node.value ?? "");
      if (relative) replacement = `\`${relative}\``;
      else return; // A command is not an artifact reference.
    } else if (node.type === "text") {
      const text = raw.replace(/https?:\/\/[^\s<>]+|(?<![\w/:])\/(?:home\/agent|root)\/\.openclaude\/(?:generated|uploads)\/[^\s`<>\[\]()"']+/g, (path) => {
        if (/^https?:\/\//.test(path)) return path;
        const clean = path.replace(/[.,;:!?，。；：！？]+$/, "");
        const relative = artifactRelative(clean);
        return relative === null ? path : relative + path.slice(clean.length);
      });
      if (text !== raw) replacement = text;
    }
    if (replacement !== null) edits.push({ start, end, text: replacement });
    else for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start)) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  return markdown;
}
