/**
 * oc-cite — 引用接地门禁(Phase 1:identifier 回查闸③ + 撤稿闸④ + 引用格式化)。
 *
 * 闸③ identifier 校验:DOI/arXiv/OpenAlex/PMID/ADS bibcode 至少命中一个可信记录。
 * 闸④ 撤稿/关注过滤:Crossref update-to(已并入 Retraction Watch)。生医/临床/政策强制。
 * 格式化:BibTeX / GB/T 7714-2015(中文国标)/ APA。
 *
 * R5 Phase B:pmid(NCBI esummary,免费)与 ads:<bibcode>(官方 search API + 官方
 * BibTeX export,Bearer token)两种 scheme。ADS token 解析顺序:平台 secret
 * adsApiToken(用户级保险箱是 Phase C)。无 token → fail-loud 结构化指引,
 * 不伪造结果 —— 这是 user6 被 ADS 网页人机验证挡住场景的根治路径。
 *
 * 说明:GB/T 7714 实现覆盖常见文献类型(期刊[J]/预印本/会议[C]/专著[M]),"够用"级;
 * 全 CSL 覆盖(citeproc-js + zotero-chinese)留 P1.5 升级(见 IMPLEMENTATION_PLAN §5)。
 */

import {
  type CitationStyle,
  type CitationVerdict,
  type SourceRecord,
  formatApa,
  formatBibtex,
  formatCitation,
  formatGbt7714,
} from "@openclaude/protocol/research";
import {
  EUTILS_BASE,
  type FetchLike,
  guessLang,
  makeSourceId,
  normalizeArxivId,
  normalizeDoi,
  parseArxivAtom,
  parseCrossrefItem,
  parseOpenAlexWork,
  parsePubmedSummary,
} from "./sources.js";

export interface CiteDeps {
  mailto?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** ADS API token(research_config 平台级 secret adsApiToken;Phase C 再接用户级)。 */
  adsApiToken?: string;
}

export type IdScheme = "doi" | "arxiv" | "openalex" | "pmid" | "ads";

export interface ParsedId {
  scheme: IdScheme;
  id: string;
}

/**
 * ADS bibcode 形态:固定 19 字符,前 4 位年份,第 5-9 位期刊代码含字母
 * (如 2015A&A...576A.135S)。要求第 5-9 位至少一个字母,排除纯数字串。
 */
const ADS_BIBCODE_RE = /^\d{4}[A-Za-z0-9&.]{15}$/;

function looksLikeBibcode(s: string): boolean {
  return s.length === 19 && ADS_BIBCODE_RE.test(s) && /[A-Za-z]/.test(s.slice(4, 9));
}

/** 百分号解码(%26 → &);非法序列原样返回。 */
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 解析 identifier 入参:`doi:..`/`arxiv:..`/`openalex:..`/`pmid:..`/`ads:..`/裸 DOI(10.)/arXiv URL/OpenAlex W../裸 PMID(≥8 位数字)/19 字符 bibcode/ADS URL。 */
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
  if (lower.startsWith("pmid:")) {
    const digits = s.slice(5).replace(/^\/+/, "").trim();
    return /^\d{1,9}$/.test(digits) ? { scheme: "pmid", id: digits } : null;
  }
  if (lower.startsWith("ads:")) {
    const bc = decodeSafe(s.slice(4).trim());
    return bc ? { scheme: "ads", id: bc } : null;
  }
  // ADS abs URL:ui.adsabs.harvard.edu/abs/<bibcode>(路径里 & 会被编码成 %26,先捕后解码)
  const adsUrl = s.match(/ui\.adsabs\.harvard\.edu\/abs\/([A-Za-z0-9&.%]+)/i);
  if (adsUrl) {
    const bc = decodeSafe(adsUrl[1]);
    if (bc.length === 19) return { scheme: "ads", id: bc };
  }
  // 裸 DOI
  if (/^10\.\d{4,}\//.test(s) || lower.includes("doi.org/")) {
    const d = normalizeDoi(s);
    return d ? { scheme: "doi", id: d } : null;
  }
  // arXiv URL / 纯 id(1234.5678 或 hep-th/9901001)
  if (
    lower.includes("arxiv.org/") ||
    /^\d{4}\.\d{4,5}(v\d+)?$/.test(s) ||
    /^[a-z-]+\/\d{7}$/.test(lower)
  ) {
    const a = normalizeArxivId(s);
    return a ? { scheme: "arxiv", id: a } : null;
  }
  // 裸 PMID(≥8 位数字起,防把年份/计数当 PMID;显式 pmid: 前缀无此限制)
  if (/^\d{8,9}$/.test(s)) return { scheme: "pmid", id: s };
  // 裸 bibcode(19 字符)
  if (looksLikeBibcode(s)) return { scheme: "ads", id: s };
  // OpenAlex work id
  if (/^w\d+$/i.test(s)) return { scheme: "openalex", id: s.toUpperCase() };
  return null;
}

const DEFAULT_TIMEOUT = 12_000;

async function getJson(
  url: string,
  deps: CiteDeps,
  headers?: Record<string, string>,
): Promise<unknown> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
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
    const headers = deps.mailto
      ? { "User-Agent": `OpenClaude-research/1.0 (mailto:${deps.mailto})` }
      : undefined;
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
    const xml = await getText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`,
      deps,
    );
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

// ── R5 Phase B: PMID / ADS bibcode ───────────────────────────────────

/** 按 PMID 回查 NCBI esummary(免费;复用 sources.parsePubmedSummary)。 */
export async function resolvePmid(pmid: string, deps: CiteDeps): Promise<SourceRecord | null> {
  if (!/^\d{1,9}$/.test(pmid)) return null;
  const params = new URLSearchParams({ db: "pubmed", retmode: "json", id: pmid });
  // polite:tool/email 与 searchPubmed 同款(E-utilities 配额纪律)
  params.set("tool", "openclaude-research");
  if (deps.mailto) params.set("email", deps.mailto);
  try {
    const j = (await getJson(`${EUTILS_BASE}/esummary.fcgi?${params.toString()}`, deps)) as {
      result?: Record<string, unknown> & { uids?: unknown };
    };
    const item = j.result?.[pmid];
    if (!item || typeof item !== "object") return null;
    const rec = parsePubmedSummary(item as Parameters<typeof parsePubmedSummary>[0]);
    if (!rec) return null;
    return { ...rec, pmid };
  } catch {
    return null;
  }
}

const ADS_API_BASE = "https://api.adsabs.harvard.edu/v1";

/** ADS token 缺失时的结构化指引(固化 user6 的"token 如何获取"问题)。 */
export const ADS_TOKEN_HINT =
  "到 https://ui.adsabs.harvard.edu → 用户设置 → API Token 生成免费 token,交平台管理员配置 research secret adsApiToken(个人版:管理台 → 科研配置)";

interface AdsDoc {
  title?: string | string[];
  author?: string[];
  year?: string;
  pub?: string;
  doi?: string | string[];
}

function adsDocToRecord(doc: AdsDoc, bibcode: string): SourceRecord | null {
  const title = (Array.isArray(doc.title) ? doc.title[0] : (doc.title ?? "")).trim();
  if (!title) return null;
  const authors = (doc.author ?? [])
    .map((a) => ({ name: a.trim() }))
    .filter((a) => a.name.length > 0);
  const year = doc.year && /^\d{4}$/.test(doc.year) ? Number(doc.year) : undefined;
  const doiRaw = Array.isArray(doc.doi) ? doc.doi[0] : doc.doi;
  const doi = normalizeDoi(doiRaw);
  const base = { doi, title, authors, year };
  return {
    id: makeSourceId(base),
    title,
    authors,
    year,
    venue: doc.pub?.trim() || undefined,
    doi,
    lang: guessLang(title),
    adsBibcode: bibcode,
    retracted: null,
  };
}

/** ADS 官方 BibTeX export(POST /v1/export/bibtex)。失败返 null(回落元数据自构)。 */
async function adsExportBibtex(bibcode: string, deps: CiteDeps): Promise<string | null> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetchFn(`${ADS_API_BASE}/export/bibtex`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.adsApiToken}`,
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ bibcode: [bibcode] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { export?: unknown };
    return typeof j.export === "string" && j.export.trim().length > 0 ? j.export.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/**
 * ADS bibcode 回查:官方 search API(Bearer token,不触发网页人机验证)。
 * 返回 {record, bibtex?} | null(未命中/上游失败)。
 * token 缺失由 verifyIdentifier 先行结构化拦截,不进本函数。
 */
export async function resolveAds(
  bibcode: string,
  deps: CiteDeps,
): Promise<{ record: SourceRecord; bibtex?: string } | null> {
  const bc = bibcode.trim();
  if (!bc || /[\s?#]/.test(bc)) return null;
  const params = new URLSearchParams({
    q: `identifier:"${bc}"`,
    fl: "title,author,year,pub,doi",
    rows: "1",
  });
  try {
    const j = (await getJson(`${ADS_API_BASE}/search/query?${params.toString()}`, deps, {
      Authorization: `Bearer ${deps.adsApiToken}`,
    })) as { response?: { docs?: AdsDoc[] } };
    const doc = j.response?.docs?.[0];
    if (!doc) return null;
    const record = adsDocToRecord(doc, bc);
    if (!record) return null;
    const bibtex = await adsExportBibtex(bc, deps);
    return bibtex ? { record, bibtex } : { record };
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
  let adsBibtex: string | undefined;

  // ADS:token 缺失 → fail-loud 结构化指引(不伪造,不打网)
  if (parsed.scheme === "ads" && !deps.adsApiToken) {
    return {
      identifier,
      resolved: false,
      retracted: null,
      reason: "ads_token_not_configured",
      hint: ADS_TOKEN_HINT,
    };
  }

  if (parsed.scheme === "doi") record = await resolveDoi(parsed.id, deps);
  else if (parsed.scheme === "arxiv") record = await resolveArxiv(parsed.id, deps);
  else if (parsed.scheme === "pmid") record = await resolvePmid(parsed.id, deps);
  else if (parsed.scheme === "ads") {
    const ads = await resolveAds(parsed.id, deps);
    if (ads) {
      record = ads.record;
      adsBibtex = ads.bibtex;
    }
  } else record = await resolveOpenAlex(parsed.id, deps);

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
    // ADS 官方 export 优先;否则元数据自构 fallback(单一权威 formatBibtex)
    bibtex: adsBibtex ?? formatBibtex(record),
    gbt7714: formatGbt7714(record),
    apa: formatApa(record),
  };
}

/** 批量校验(并发)。 */
export async function verifyIdentifiers(
  raws: string[],
  deps: CiteDeps,
): Promise<CitationVerdict[]> {
  return Promise.all(raws.map((r) => verifyIdentifier(r, deps)));
}

// ───────────────────────────────────────────────
// 格式化(单一权威在 @openclaude/protocol/research,master 与容器 oc-report 共用)
// ───────────────────────────────────────────────

/** 仅格式化(已知 record),供 oc-cite format 子命令复用。 */
export function formatRecord(rec: SourceRecord, style: CitationStyle): string {
  return formatCitation(rec, style);
}
