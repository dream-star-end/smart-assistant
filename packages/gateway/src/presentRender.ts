/**
 * 演示产物确定性构建(oc-slides / oc-poster)。
 *
 * SlideDeck / PosterSpec(结构)→ Quarto markdown(revealjs / typst)。引擎据 design-token
 * 主题确定性排版,LLM 不碰样式。图走 SciencePlots/Mermaid 路径,**禁生成式插画**(由
 * scientific-figures skill + PresAesth 约束)。纯函数,可单测;CLI 负责写文件 + 调 quarto。
 */

import type { PosterSpec, SlideDeck } from "@openclaude/protocol/research";

/** design-token 主题 → revealjs 内置主题(白名单;未知回落 default)。 */
const SLIDE_THEME: Record<string, string> = {
  default: "default",
  dark: "dark",
  nature: "serif",
  ieee: "simple",
  white: "white",
  league: "league",
};

function escapeYaml(s: string): string {
  // 折叠换行/控制字符为空格(防破坏 frontmatter),再转义引号
  // biome-ignore lint/suspicious/noControlCharactersInRegex: collapse control chars to keep YAML valid
  return s.replace(/[\r\n\t\x00-\x1F]+/g, " ").replace(/"/g, '\\"').trim();
}

export interface BuildSlidesResult {
  markdown: string;
  slideCount: number;
}

/** SlideDeck → Quarto revealjs markdown(可 render html/pptx)。 */
export function buildSlideDeck(deck: SlideDeck): BuildSlidesResult {
  const theme = SLIDE_THEME[(deck.theme ?? "default").toLowerCase()] ?? "default";
  const lines: string[] = ["---", `title: "${escapeYaml(deck.title)}"`];
  if (deck.subtitle) lines.push(`subtitle: "${escapeYaml(deck.subtitle)}"`);
  if (deck.author) lines.push(`author: "${escapeYaml(deck.author)}"`);
  lines.push("format:");
  lines.push("  revealjs:");
  lines.push(`    theme: ${theme}`);
  lines.push("    slide-number: true");
  lines.push("    incremental: false");
  lines.push("    fig-align: center");
  lines.push("lang: zh");
  lines.push("---");
  lines.push("");

  for (const s of deck.slides) {
    lines.push(`## ${s.heading}`);
    lines.push("");
    for (const b of s.bullets) lines.push(`- ${b}`);
    if (s.bullets.length > 0) lines.push("");
    if (s.figure) {
      lines.push(`![](${s.figure})`);
      lines.push("");
    }
    if (s.notes) {
      lines.push("::: notes");
      lines.push(s.notes);
      lines.push(":::");
      lines.push("");
    }
  }
  return { markdown: lines.join("\n"), slideCount: deck.slides.length };
}

export interface BuildPosterResult {
  markdown: string;
  sectionCount: number;
}

/** PosterSpec → Quarto typst markdown(单页多列海报;Quarto≥1.4 内置 typst,无需单独装)。 */
export function buildPoster(spec: PosterSpec): BuildPosterResult {
  const columns = Math.min(Math.max(Number.isFinite(spec.columns) ? (spec.columns as number) : 3, 1), 4);
  const lines: string[] = ["---", `title: "${escapeYaml(spec.title)}"`];
  if (spec.authors) lines.push(`author: "${escapeYaml(spec.authors)}"`);
  lines.push("format:");
  lines.push("  typst:");
  lines.push("    papersize: a1");
  lines.push("    margin:");
  lines.push("      x: 2cm");
  lines.push("      y: 2cm");
  lines.push("lang: zh");
  lines.push("---");
  lines.push("");
  if (spec.affiliation) {
    lines.push(`*${spec.affiliation}*`);
    lines.push("");
  }
  // 多列:Typst raw block 起多列布局,后续 markdown 章节自然分流
  lines.push("```{=typst}");
  lines.push(`#set page(columns: ${columns})`);
  lines.push("#set text(size: 11pt)");
  lines.push("```");
  lines.push("");
  for (const sec of spec.sections) {
    lines.push(`## ${sec.heading}`);
    lines.push("");
    lines.push(sec.bodyMd);
    lines.push("");
    if (sec.figure) {
      lines.push(`![](${sec.figure})`);
      lines.push("");
    }
  }
  return { markdown: lines.join("\n"), sectionCount: spec.sections.length };
}
