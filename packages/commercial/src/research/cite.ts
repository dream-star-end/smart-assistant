/**
 * oc-cite — 引用接地门禁(Phase 1:identifier 回查闸③ + 撤稿闸④ + 引用格式化)。
 *
 * 闸③ identifier 校验:DOI/arXiv/OpenAlex 至少命中一个可信记录(Crossref/OpenAlex/arXiv)。
 * 闸④ 撤稿/关注过滤:Crossref update-to(已并入 Retraction Watch)。生医/临床/政策强制。
 * 格式化:BibTeX / GB/T 7714-2015(中文国标)/ APA。
 *
 * 说明:GB/T 7714 实现覆盖常见文献类型(期刊[J]/预印本/会议[C]/专著[M]),"够用"级;
 * 全 CSL 覆盖(citeproc-js + zotero-chinese)留 P1.5 升级(见 IMPLEMENTATION_PLAN §5)。
 */

import type { CitationVerdict, SourceRecord } from "@openclaude/protocol/research";
import {
  type FetchLike,
  normalizeArxivId,
  normalizeDoi,
  parseArxivAtom,
  parseCrossrefItem,
  parseOpenAlexWork,
} from "./sources.js";

export interface CiteDeps {
  mailto?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export type IdScheme = "doi" | "arxiv" | "openalex";

export interface ParsedId {
  scheme: IdScheme;
  id: string;
}

/** 解析 identifier 入参:`doi:..`/`arxiv:..`/`openalex:..`/裸 DOI(10.)/arXiv URL/OpenAlex W..。 */
export function parseIdentifier(raw: string): ParsedId | null {
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith("doi:")) {
    const d = normalizeDoi(s.slice(4));
    return d ? { scheme: "doi", id: d } : null;
  }
  if (lower.startsWith("arxiv:")) {
    const a = normalizeArxivId(s.slice(6));
    return a ? { scheme: "arxiv", id: a } : null;
  }
  if (lower.startsWith("openalex:")) {
    return { scheme: "openalex", id: s.slice(9).trim() };
  }
  // 裸 DOI
  if (/^10\.\d{4,}\//.test(s) || lower.includes("doi.org/")) {
    const d = normalizeDoi(s);
    return d ? { scheme: "doi", id: d } : null;
  }
  // arXiv URL / 纯 id(1234.5678 或 hep-th/9901001)
  if (lower.includes("arxiv.org/") || /^\d{4}\.\d{4,5}(v\d+)?$/.test(s) || /^[a-z-]+\/\d{7}$/.test(lower)) {
    const a = normalizeArxivId(s);
    return a ? { scheme: "arxiv", id: a } : null;
  }
  // OpenAlex work id
  if (/^w\d+$/i.test(s)) return { scheme: "openalex", id: s.toUpperCase() };
  return null;
}

const DEFAULT_TIMEOUT = 12_000;

async function getJson(url: string, deps: CiteDeps, headers?: Record<string, string>): Promise<unknown> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json", ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function getText(url: string, deps: CiteDeps): Promise<string> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetchFn(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

/** DOI path 安全化:Crossref/OpenAlex 的 /works/{doi} 要字面斜杠(不能 %2F),
 *  但要挡 path/query 混淆与编码绕过。doi 已经过 normalizeDoi(小写、去前缀)。
 *  拒:超长 / 控制字符+空白 / `? # \ %`(query·fragment·反斜杠·百分号编码绕过)/
 *      `.`·`..` 段 / 不符 `10.<4+digits>/` 形态。 */
function safeDoiPath(doi: string): string | null {
  if (doi.length === 0 || doi.length > 512) return null;
  if (!/^10\.\d{4,}\//.test(doi)) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: screen control/DEL + path-confusion chars
  if (/[\x00-\x20\x7F?#\\%]/.test(doi)) return null;
  if (doi.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return doi;
}

/**
 * 构造并二次校验 API GET URL(防 path/query 混淆):parse 后断言 origin 一致、
 * pathname 以预期前缀开头、无 query/hash/userinfo。可选 query 参数经 searchParams 安全编码。
 * 返回校验后的 URL string;任一不符 → null。
 */
function buildSafeApiUrl(
  origin: string,
  rawUrl: string,
  pathPrefix: string,
  query?: Record<string, string>,
): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  if (u.search !== "" || u.hash !== "" || u.username !== "" || u.password !== "") return null;
  if (!u.pathname.startsWith(pathPrefix)) return null;
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

/** 按 DOI 回查 Crossref(含撤稿)。命中返 SourceRecord,未命中/失败返 null。 */
export async function resolveDoi(doi: string, deps: CiteDeps): Promise<SourceRecord | null> {
  const safe = safeDoiPath(doi);
  if (!safe) return null;
  // DOI 含 '/' 是 Crossref path 的一部分,字面拼接(encodeURIComponent 会 %2F,API 不认);
  // buildSafeApiUrl 二次 parse 断言 origin/无 query·hash,防 path/query 混淆。
  const url = buildSafeApiUrl(
    "https://api.crossref.org",
    `https://api.crossref.org/works/${safe}`,
    "/works/",
  );
  if (!url) return null;
  try {
    const headers = deps.mailto ? { "User-Agent": `OpenClaude-research/1.0 (mailto:${deps.mailto})` } : undefined;
    const j = (await getJson(url, deps, headers)) as {
      message?: Parameters<typeof parseCrossrefItem>[0];
    };
    if (!j.message) return null;
    return parseCrossrefItem(j.message);
  } catch {
    return null;
  }
}

/** 按 arXiv id 回查 arXiv API。 */
export async function resolveArxiv(id: string, deps: CiteDeps): Promise<SourceRecord | null> {
  try {
    const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, deps);
    const recs = parseArxivAtom(xml);
    return recs[0] ?? null;
  } catch {
    return null;
  }
}

/** 按 OpenAlex id 回查 OpenAlex(id 可为 'W123' 或 'doi:10.x/y')。 */
export async function resolveOpenAlex(id: string, deps: CiteDeps): Promise<SourceRecord | null> {
  // path id 安全化:W-id 或 doi:<safe doi>;其它一律拒(防注入路径)
  let pathId: string | null = null;
  if (/^W\d+$/i.test(id)) pathId = id.toUpperCase();
  else if (id.toLowerCase().startsWith("doi:")) {
    const d = safeDoiPath(normalizeDoi(id.slice(4)) ?? "");
    if (d) pathId = `doi:${d}`;
  }
  if (!pathId) return null;
  // doi:10.x/y 含 '/' 是 OpenAlex path 的一部分,字面拼接;二次 parse 断言 + mailto 经
  // searchParams 安全编码(防 path/query 混淆)。
  const url = buildSafeApiUrl(
    "https://api.openalex.org",
    `https://api.openalex.org/works/${pathId}`,
    "/works/",
    deps.mailto ? { mailto: deps.mailto } : undefined,
  );
  if (!url) return null;
  try {
    const j = (await getJson(url, deps)) as Parameters<typeof parseOpenAlexWork>[0];
    if (!j || !(j.title || j.display_name)) return null;
    return parseOpenAlexWork(j);
  } catch {
    return null;
  }
}

/** 校验单个 identifier(闸③ resolve + 闸④ retraction)+ 三格式化。 */
export async function verifyIdentifier(raw: string, deps: CiteDeps): Promise<CitationVerdict> {
  const parsed = parseIdentifier(raw);
  if (!parsed) {
    return { identifier: raw, resolved: false, retracted: null };
  }
  const identifier = `${parsed.scheme}:${parsed.id}`;
  let record: SourceRecord | null = null;
  if (parsed.scheme === "doi") record = await resolveDoi(parsed.id, deps);
  else if (parsed.scheme === "arxiv") record = await resolveArxiv(parsed.id, deps);
  else record = await resolveOpenAlex(parsed.id, deps);

  // DOI 经 Crossref 未命中时再尝试 OpenAlex(覆盖互补);仍未命中才判 unresolved。
  if (!record && parsed.scheme === "doi") {
    record = await resolveOpenAlex(`doi:${parsed.id}`, deps);
  }

  if (!record) {
    return { identifier, resolved: false, retracted: null };
  }
  return {
    identifier,
    resolved: true,
    record,
    retracted: record.retracted ?? null,
    bibtex: formatBibtex(record),
    gbt7714: formatGbt7714(record),
    apa: formatApa(record),
  };
}

/** 批量校验(并发)。 */
export async function verifyIdentifiers(raws: string[], deps: CiteDeps): Promise<CitationVerdict[]> {
  return Promise.all(raws.map((r) => verifyIdentifier(r, deps)));
}

// ───────────────────────────────────────────────
// 格式化
// ───────────────────────────────────────────────

function asciiKey(rec: SourceRecord): string {
  const surname = rec.authors[0]?.name?.split(/\s+/).pop() ?? "anon";
  const ascii = surname.replace(/[^A-Za-z]/g, "") || "ref";
  return `${ascii.toLowerCase()}${rec.year ?? ""}`;
}

/** BibTeX。type 按 crossrefType/arXiv 粗映射。 */
export function formatBibtex(rec: SourceRecord): string {
  const type = rec.arxivId && !rec.doi ? "misc" : "article";
  const fields: string[] = [];
  fields.push(`  title = {${rec.title}}`);
  if (rec.authors.length) fields.push(`  author = {${rec.authors.map((a) => a.name).join(" and ")}}`);
  if (rec.venue) fields.push(`  journal = {${rec.venue}}`);
  if (rec.year) fields.push(`  year = {${rec.year}}`);
  if (rec.doi) fields.push(`  doi = {${rec.doi}}`);
  if (rec.arxivId) fields.push(`  eprint = {${rec.arxivId}}`);
  return `@${type}{${asciiKey(rec)},\n${fields.join(",\n")}\n}`;
}

/** 作者列表(GB/T 7714:超 3 人取前 3 + 等)。 */
function gbtAuthors(rec: SourceRecord): string {
  const names = rec.authors.map((a) => a.name);
  if (names.length === 0) return "佚名";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")}, 等`;
}

/**
 * GB/T 7714-2015。覆盖常见类型:期刊[J] / 预印本(arXiv,[J/OL] 在线)/ 其它默认 [J]。
 * 形如:作者. 题名[J]. 刊名, 年. DOI: ...
 */
export function formatGbt7714(rec: SourceRecord): string {
  const authors = gbtAuthors(rec);
  if (rec.arxivId && !rec.doi) {
    // 预印本(电子文献/在线)
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

/** APA(7th,简化)。 */
export function formatApa(rec: SourceRecord): string {
  const authors = rec.authors.map((a) => a.name).join(", ");
  const year = rec.year ? `(${rec.year}). ` : "";
  const venue = rec.venue ? ` ${rec.venue}.` : "";
  const doi = rec.doi ? ` https://doi.org/${rec.doi}` : rec.arxivId ? ` https://arxiv.org/abs/${rec.arxivId}` : "";
  return `${authors} ${year}${rec.title}.${venue}${doi}`.trim();
}

/** 仅格式化(已知 record),供 oc-cite format 子命令复用。 */
export function formatRecord(rec: SourceRecord, style: "bibtex" | "gb-t-7714-2015" | "apa"): string {
  if (style === "bibtex") return formatBibtex(rec);
  if (style === "apa") return formatApa(rec);
  return formatGbt7714(rec);
}
