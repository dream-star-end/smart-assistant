/**
 * 前端轻量引用格式化(导出按钮用)。
 *
 * 与 `@openclaude/protocol/research` 的 formatCitation **同算法**,但在前端本地实现,
 * 避免把 protocol 的 typebox(运行时依赖)打进 web 包(frames 一直是 type-only import)。
 * 权威格式化仍以 master oc-cite 输出为准;此处仅为前端"导出 BibTeX/GB-T7714"便利。
 */
import type { SourceRecord } from "@openclaude/protocol/research";

export type CiteStyle = "gb-t-7714-2015" | "apa" | "bibtex";

function gbtAuthors(rec: SourceRecord): string {
  const names = rec.authors.map((a) => a.name);
  if (names.length === 0) return "佚名";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, 等`;
}

export function formatGbt7714(rec: SourceRecord): string {
  const authors = gbtAuthors(rec);
  if (rec.arxivId && !rec.doi) {
    return `${authors}. ${rec.title}[J/OL]. arXiv, ${rec.year ?? ""}. https://arxiv.org/abs/${rec.arxivId}.`.replace(
      /,\s*\./,
      ".",
    );
  }
  const parts = [`${authors}. ${rec.title}[J].`];
  if (rec.venue) parts.push(` ${rec.venue},`);
  if (rec.year) parts.push(` ${rec.year}.`);
  if (rec.doi) parts.push(` DOI: ${rec.doi}.`);
  return parts.join("").replace(/,\s*\./g, ".").trim();
}

export function formatApa(rec: SourceRecord): string {
  const authors = rec.authors.map((a) => a.name).join(", ");
  const year = rec.year ? `(${rec.year}). ` : "";
  const venue = rec.venue ? ` ${rec.venue}.` : "";
  const doi = rec.doi
    ? ` https://doi.org/${rec.doi}`
    : rec.arxivId
      ? ` https://arxiv.org/abs/${rec.arxivId}`
      : "";
  return `${authors} ${year}${rec.title}.${venue}${doi}`.trim();
}

export function formatBibtex(rec: SourceRecord): string {
  const surname = rec.authors[0]?.name?.split(/\s+/).pop() ?? "anon";
  const key = `${(surname.replace(/[^A-Za-z]/g, "") || "ref").toLowerCase()}${rec.year ?? ""}`;
  const type = rec.arxivId && !rec.doi ? "misc" : "article";
  const fields = [`  title = {${rec.title}}`];
  if (rec.authors.length) fields.push(`  author = {${rec.authors.map((a) => a.name).join(" and ")}}`);
  if (rec.venue) fields.push(`  journal = {${rec.venue}}`);
  if (rec.year) fields.push(`  year = {${rec.year}}`);
  if (rec.doi) fields.push(`  doi = {${rec.doi}}`);
  if (rec.arxivId) fields.push(`  eprint = {${rec.arxivId}}`);
  return `@${type}{${key},\n${fields.join(",\n")}\n}`;
}

export function formatCitation(rec: SourceRecord, style: CiteStyle): string {
  if (style === "bibtex") return formatBibtex(rec);
  if (style === "apa") return formatApa(rec);
  return formatGbt7714(rec);
}

/** 导出整库为某格式(每条一行/一块)。 */
export function exportLibrary(sources: SourceRecord[], style: CiteStyle): string {
  if (style === "bibtex") return sources.map((s) => formatBibtex(s)).join("\n\n");
  return sources.map((s, i) => `${i + 1}. ${formatCitation(s, style)}`).join("\n");
}
