/**
 * 前端轻量引用格式化(导出按钮用)。
 *
 * 与 `@openclaude/protocol/research` 的 formatCitation **同算法**,但在前端本地实现,
 * 避免把 protocol 的 typebox(运行时依赖)打进 web 包(frames 一直是 type-only import)。
 * 权威格式化仍以 master oc-cite 输出为准;此处仅为前端"导出 BibTeX/GB-T7714/APA/IEEE/Nature"便利。
 */
import type { Author, EvidenceGrade, SourceRecord } from "@openclaude/protocol/research";

export type CiteStyle = "gb-t-7714-2015" | "gb-t-7714" | "apa" | "bibtex" | "ieee" | "nature";

function isConference(rec: SourceRecord): boolean {
  const t = (rec.crossrefType ?? "").toLowerCase();
  return t === "proceedings-article" || t === "paper-conference" || t === "conference-paper";
}

function isBook(rec: SourceRecord): boolean {
  const t = (rec.crossrefType ?? "").toLowerCase();
  return t === "book" || t === "monograph" || t === "edited-book";
}

function isCjk(name: string): boolean {
  return /[\u3400-\u9fff]/.test(name);
}

function splitCompactInitials(token: string): string[] {
  const cleaned = token.replace(/\./g, "").trim();
  if (!cleaned) return [];
  return cleaned
    .split("-")
    .filter(Boolean)
    .flatMap((seg) => (/^[A-Z]{2,4}$/.test(seg) ? seg.split("") : [seg]));
}

function extractInitials(given: string[]): string {
  const letters: string[] = [];
  for (const part of given) {
    const pieces = part
      .split(/[\s.]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const piece of pieces) {
      if (/^[A-Z]{2,4}(?:-[A-Z]{1,2})*$/.test(piece)) {
        for (const ch of splitCompactInitials(piece)) letters.push(`${ch[0]!.toUpperCase()}.`);
      } else if (piece.includes("-")) {
        const hyph = piece
          .split("-")
          .filter(Boolean)
          .map((s) => `${s[0]!.toUpperCase()}.`)
          .join("-");
        if (hyph) letters.push(hyph);
      } else {
        letters.push(`${piece[0]!.toUpperCase()}.`);
      }
    }
  }
  return letters.join(" ");
}

function splitAuthor(author: Author | string): { given: string[]; family: string } {
  if (typeof author !== "string" && author.family?.trim()) {
    return {
      family: author.family.trim(),
      given: (author.given ?? "").trim().split(/\s+/).filter(Boolean),
    };
  }
  const trimmed = (typeof author === "string" ? author : author.name).trim();
  if (trimmed.includes(",")) {
    const [fam, rest] = trimmed.split(",", 2);
    return { family: (fam ?? "").trim(), given: (rest ?? "").trim().split(/\s+/).filter(Boolean) };
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { family: trimmed, given: [] };
  const last = parts[parts.length - 1]!;
  const prev = parts[parts.length - 2]!;
  if (
    /^[A-Z]{1,4}(?:-[A-Z]{1,2})*$/.test(last) &&
    (/[a-z]/.test(prev) || (prev.length >= 2 && !/^[A-Z]\.?$/.test(prev)))
  ) {
    return { family: parts.slice(0, -1).join(" "), given: splitCompactInitials(last) };
  }
  return { family: parts[parts.length - 1]!, given: parts.slice(0, -1) };
}

function formatFamilyInitials(author: Author | string): string {
  const t = (typeof author === "string" ? author : author.name).trim();
  if (!t || isCjk(t)) return t;
  const { given, family } = splitAuthor(author);
  if (!given.length) return family;
  const initials = extractInitials(given);
  return initials ? `${family}, ${initials}`.trim() : family;
}

function formatApaAuthors(authors: Author[]): string {
  const formatted = authors.map((a) => formatFamilyInitials(a)).filter(Boolean);
  if (formatted.length === 0) return "";
  if (formatted.length === 1) return formatted[0]!;
  if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
  if (formatted.length <= 20) {
    return `${formatted.slice(0, -1).join(", ")}, & ${formatted[formatted.length - 1]}`;
  }
  return `${formatted.slice(0, 19).join(", ")}, ... ${formatted[formatted.length - 1]}`;
}

function normalizePages(pages: string | undefined, dash: string): string | undefined {
  if (!pages) return undefined;
  const clean = pages.trim().replace(/^[pP]{1,2}\.?\s*/, "");
  return clean ? clean.replace(/\s*[-–—]+\s*/g, dash) : undefined;
}

function gbtAuthors(rec: SourceRecord): string {
  const names = rec.authors.map((a) => a.name);
  if (names.length === 0) return "佚名";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, 等`;
}

export function formatGbt7714(rec: SourceRecord): string {
  const authors = gbtAuthors(rec);
  const pages = normalizePages(rec.pages, "-");
  if (rec.arxivId && !rec.doi && !isConference(rec) && !isBook(rec)) {
    return `${authors}. ${rec.title}[J/OL]. arXiv, ${rec.year ?? ""}. https://arxiv.org/abs/${rec.arxivId}.`.replace(
      /,\s*\./,
      ".",
    );
  }
  if (isConference(rec)) {
    const body = [`${authors}. ${rec.title}[C]`];
    body.push(rec.venue ? `//${rec.venue}` : ".");
    const tail = [rec.publisher, rec.year ? String(rec.year) : undefined].filter(Boolean);
    if (tail.length > 0) body.push(`${rec.venue ? ". " : " "}${tail.join(", ")}`);
    if (pages) body.push(`: ${pages}`);
    body.push(".");
    if (rec.doi) body.push(` DOI: ${rec.doi}.`);
    return body.join("").replace(/\.\.+/g, ".").replace(/,\s*\./g, ".").trim();
  }
  if (isBook(rec)) {
    const parts = [`${authors}. ${rec.title}[M].`];
    const pubYear = [rec.publisher, rec.year ? String(rec.year) : undefined].filter(Boolean).join(", ");
    if (pubYear) parts.push(` ${pubYear}`);
    if (pages) parts.push(`: ${pages}`);
    if (pubYear || pages) parts.push(".");
    if (rec.doi) parts.push(` DOI: ${rec.doi}.`);
    return parts.join("").replace(/\.\.+/g, ".").replace(/,\s*\./g, ".").trim();
  }
  const parts = [`${authors}. ${rec.title}[J].`];
  const pubMeta: string[] = [];
  if (rec.venue) pubMeta.push(rec.venue);
  const volIssue = rec.volume ? (rec.issue ? `${rec.volume}(${rec.issue})` : rec.volume) : rec.issue ? `(${rec.issue})` : "";
  const yearVol = rec.year && volIssue ? `${rec.year}, ${volIssue}` : rec.year ? String(rec.year) : volIssue;
  if (yearVol) pubMeta.push(yearVol);
  if (pubMeta.length > 0) parts.push(` ${pubMeta.join(", ")}${pages ? `: ${pages}` : ""}.`);
  else if (pages) parts.push(` ${pages}.`);
  if (rec.doi) parts.push(` DOI: ${rec.doi}.`);
  return parts.join("").replace(/,\s*\./g, ".").trim();
}

export function formatApa(rec: SourceRecord): string {
  const authors = formatApaAuthors(rec.authors);
  const year = rec.year ? `(${rec.year}). ` : "";
  const pages = normalizePages(rec.pages, "–");
  const venueParts: string[] = [];
  if (rec.venue) venueParts.push(rec.venue);
  if (rec.volume) venueParts.push(rec.issue ? `${rec.volume}(${rec.issue})` : rec.volume);
  else if (rec.issue) venueParts.push(`(${rec.issue})`);
  if (pages) venueParts.push(pages);
  const venue = venueParts.length > 0 ? ` ${venueParts.join(", ")}.` : "";
  const doi = rec.doi
    ? ` https://doi.org/${rec.doi}`
    : rec.arxivId
      ? ` https://arxiv.org/abs/${rec.arxivId}`
      : "";
  return `${authors} ${year}${rec.title}.${venue}${doi}`.trim();
}

export function formatBibtex(rec: SourceRecord): string {
  const first = rec.authors[0];
  const surname = first ? splitAuthor(first).family : "anon";
  const key = `${(surname.replace(/[^A-Za-z]/g, "") || "ref").toLowerCase()}${rec.year ?? ""}`;
  const conf = isConference(rec);
  const book = isBook(rec);
  const type = rec.arxivId && !rec.doi && !conf && !book ? "misc" : conf ? "inproceedings" : book ? "book" : "article";
  const fields = [`  title = {${rec.title}}`];
  if (rec.authors.length) fields.push(`  author = {${rec.authors.map((a) => a.name).join(" and ")}}`);
  if (rec.venue) fields.push(`  ${conf ? "booktitle" : "journal"} = {${rec.venue}}`);
  if (rec.year) fields.push(`  year = {${rec.year}}`);
  if (rec.volume) fields.push(`  volume = {${rec.volume}}`);
  if (rec.issue) fields.push(`  number = {${rec.issue}}`);
  const pages = normalizePages(rec.pages, "--");
  if (pages) fields.push(`  pages = {${pages}}`);
  if (rec.publisher) fields.push(`  publisher = {${rec.publisher}}`);
  if (rec.doi) fields.push(`  doi = {${rec.doi}}`);
  if (rec.arxivId) fields.push(`  eprint = {${rec.arxivId}}`);
  return `@${type}{${key},\n${fields.join(",\n")}\n}`;
}

export function formatIeee(rec: SourceRecord): string {
  const authors = rec.authors
    .map((a) => {
      const t = a.name.trim();
      if (!t || isCjk(t)) return t;
      const { given, family } = splitAuthor(a);
      if (!given.length) return family;
      const initials = extractInitials(given);
      return initials ? `${initials} ${family}`.trim() : family;
    })
    .filter(Boolean);
  const authorStr =
    authors.length === 1
      ? authors[0]!
      : authors.length === 2
        ? `${authors[0]} and ${authors[1]}`
        : authors.length > 6
          ? `${authors[0]} et al.`
          : authors.length > 2
            ? `${authors.slice(0, -1).join(", ")}, and ${authors[authors.length - 1]}`
            : "";
  const details: string[] = [];
  if (rec.venue) details.push(isConference(rec) ? `in ${rec.venue}` : rec.venue);
  if (rec.volume) details.push(`vol. ${rec.volume}`);
  if (rec.issue) details.push(`no. ${rec.issue}`);
  const pages = normalizePages(rec.pages, "–");
  if (pages) details.push(`pp. ${pages}`);
  if (rec.year) details.push(String(rec.year));
  const parts = [authorStr, details.length > 0 ? `"${rec.title},"` : `"${rec.title}."`].filter(Boolean);
  let out = parts.join(", ");
  if (details.length > 0) out += ` ${details.join(", ")}.`;
  if (rec.doi) out += ` doi: ${rec.doi}.`;
  else if (rec.arxivId) out += ` arXiv:${rec.arxivId}.`;
  return out.replace(/\.\.+/g, ".").trim();
}

export function formatNature(rec: SourceRecord): string {
  const authors = rec.authors.map((a) => formatFamilyInitials(a)).filter(Boolean);
  const authorStr =
    authors.length === 1
      ? authors[0]!
      : authors.length === 2
        ? `${authors[0]} & ${authors[1]}`
        : authors.length > 5
          ? `${authors[0]} et al.`
          : authors.length > 2
            ? `${authors.slice(0, -1).join(", ")} & ${authors[authors.length - 1]}`
            : "";
  const segments = [authorStr, `${rec.title}.`].filter(Boolean);
  const pages = normalizePages(rec.pages, "–");
  if (rec.arxivId && !rec.doi && !rec.venue) {
    segments.push(`Preprint at https://arxiv.org/abs/${rec.arxivId}${rec.year ? ` (${rec.year})` : ""}.`);
    return segments.join(" ").replace(/\.\.+/g, ".").trim();
  }
  const pubBits = [rec.venue, rec.volume].filter(Boolean);
  let pub = pubBits.join(" ");
  if (pages) pub = pub ? `${pub}, ${pages}` : pages;
  if (rec.year) pub = pub ? `${pub} (${rec.year})` : `(${rec.year})`;
  if (pub) segments.push(`${pub}.`);
  if (rec.doi) segments.push(`https://doi.org/${rec.doi}`);
  else if (rec.arxivId) segments.push(`https://arxiv.org/abs/${rec.arxivId}`);
  return segments.join(" ").replace(/\.\.+/g, ".").trim();
}

export function resolveEvidenceGrade(input: {
  evidenceGrade?: EvidenceGrade | null;
  docId?: string | null;
  spanId?: string | null;
  quoteBound?: boolean;
  localEvidenceVerified?: boolean;
}): EvidenceGrade {
  if (input.evidenceGrade === "B") return "B";
  if (typeof input.localEvidenceVerified === "boolean") return input.localEvidenceVerified ? "A" : "B";
  if (input.quoteBound === true) return "A";
  if (input.quoteBound === false) return "B";
  return Boolean(input.docId?.trim()) && Boolean(input.spanId?.trim()) ? "A" : "B";
}

export function formatCitation(rec: SourceRecord, style: CiteStyle): string {
  if (style === "bibtex") return formatBibtex(rec);
  if (style === "apa") return formatApa(rec);
  if (style === "ieee") return formatIeee(rec);
  if (style === "nature") return formatNature(rec);
  return formatGbt7714(rec);
}

/** 导出整库为某格式(每条一行/一块)。 */
export function exportLibrary(sources: SourceRecord[], style: CiteStyle): string {
  if (style === "bibtex") return sources.map((s) => formatBibtex(s)).join("\n\n");
  return sources.map((s, i) => `${i + 1}. ${formatCitation(s, style)}`).join("\n");
}
