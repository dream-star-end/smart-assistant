/**
 * oc-lit 多源检索编排:并发查各源 → 去重合并 → OA 发现 → SourceRecord[]。
 *
 * 去重(方案 §7):DOI 优先;中文文献 DOI 缺失率高 → fallback 标题+首作者姓+年 模糊 key。
 * 单源失败/超时不拖垮整体(Promise.allSettled → warnings)。
 * OA 全文走 OA 源 + 用户自带文件;**绝不代爬付费墙**(知网/万方命中只给题录)。
 */

import type { SourceRecord } from "@openclaude/protocol/research";
import {
  type FetchLike,
  type SourceSearchOpts,
  normalizeArxivId,
  normalizeAuthorSurname,
  normalizeDoi,
  normalizeTitleForKey,
  searchArxiv,
  searchCrossref,
  searchDeepXiv,
  searchOpenAlex,
  searchPubmed,
  searchS2,
} from "./sources.js";

export type LitSourceName = "openalex" | "crossref" | "arxiv" | "pubmed" | "s2";

/**
 * 默认候选源(未显式传 --sources 时全量候选)。门控在 searchMultiSource:
 * pubmed 免费官方 API,默认参与(pubmedEnabled=false 时剔除);s2 无 key 限速,
 * **仅** s2Enabled=true 时参与 —— 所以默认列表带上 s2 也不会在未开启时出网。
 */
export const DEFAULT_LIT_SOURCES: LitSourceName[] = ["openalex", "crossref", "arxiv", "pubmed", "s2"];

export interface LitSearchInput {
  query: string;
  sources?: LitSourceName[];
  size?: number;
  yearMin?: number;
  /** 'zh' 时偏向中文召回提示(目前仅影响 warnings 文案;源本身语言无关)。 */
  lang?: "zh" | "en";
}

export interface LitSearchDeps {
  mailto?: string;
  /** Unpaywall OA 发现 email(配了才启用 OA 富化)。 */
  unpaywallEmail?: string;
  /** PubMed 源开关(免费官方 API,默认参与;显式 false 才剔除)。 */
  pubmedEnabled?: boolean;
  /** PubMed E-utilities polite email;未配回落 mailto。 */
  pubmedEmail?: string;
  /** Semantic Scholar 源开关(research_config litSources.s2Enabled;**默认关**,true 才出网)。 */
  s2Enabled?: boolean;
  /** S2 API key(secret;无 key 可用但共享限速池,易 429)。 */
  s2ApiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** 瞬时出站失败的重试退避基数(ms);默认 400,测试可传 0 跑快。 */
  retryDelayMs?: number;
  /** DeepXiv arXiv 兜底源(域内 RAG):主源全空时用它补召回。token 留 master,不进容器。 */
  deepxiv?: { base: string; token: string };
}

export interface LitSearchResult {
  sources: SourceRecord[];
  warnings: string[];
}

/** 去重 key:DOI > arxivId > 标题+首作者姓+年(模糊)。 */
export function dedupKey(r: SourceRecord): string {
  const doi = normalizeDoi(r.doi);
  if (doi) return `doi:${doi}`;
  const arx = normalizeArxivId(r.arxivId);
  if (arx) return `arxiv:${arx}`;
  const a = normalizeAuthorSurname(r.authors[0]?.name ?? "");
  return `t:${normalizeTitleForKey(r.title)}|${a}|${r.year ?? ""}`;
}

/** 完整度评分:字段越全分越高(用于合并时挑"主记录")。 */
function completeness(r: SourceRecord): number {
  let s = 0;
  if (r.doi) s += 3;
  if (r.arxivId) s += 1;
  if (r.openalexId) s += 1;
  if (r.year) s += 1;
  if (r.venue) s += 1;
  if (r.authors.length > 0) s += 1;
  if (typeof r.citationCount === "number") s += 1;
  if (r.oa?.isOA) s += 1;
  return s;
}

/** 合并同组记录:以最完整者为主,补齐缺失字段 + 合并 OA / 撤稿 / 引用数。 */
export function mergeGroup(group: SourceRecord[]): SourceRecord {
  const sorted = [...group].sort((a, b) => completeness(b) - completeness(a));
  const base = { ...sorted[0] };
  for (const r of sorted.slice(1)) {
    base.doi ??= r.doi;
    base.arxivId ??= r.arxivId;
    base.openalexId ??= r.openalexId;
    base.year ??= r.year;
    base.venue ??= r.venue;
    base.crossrefType ??= r.crossrefType;
    if (r.authors.length > base.authors.length) base.authors = r.authors;
    if (typeof r.citationCount === "number") {
      base.citationCount = Math.max(base.citationCount ?? 0, r.citationCount);
    }
    // OA:任一源标 isOA 即 OA(取带 url 的)
    if (r.oa?.isOA && (!base.oa?.isOA || !base.oa?.url)) base.oa = r.oa;
    base.oa ??= r.oa;
    // 撤稿:true 优先;否则取任一非 null
    if (r.retracted === true) base.retracted = true;
    else if (base.retracted == null && r.retracted != null) base.retracted = r.retracted;
  }
  return base;
}

/** 去重合并:同 key 归一为一条。保持稳定顺序(首次出现序)。 */
export function dedupAndMerge(records: SourceRecord[]): SourceRecord[] {
  const groups = new Map<string, SourceRecord[]>();
  const order: string[] = [];
  for (const r of records) {
    const k = dedupKey(r);
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(r);
  }
  return order.map((k) => mergeGroup(groups.get(k)!));
}

interface UnpaywallResp {
  is_oa?: boolean;
  best_oa_location?: { url_for_pdf?: string | null; url?: string | null; license?: string | null } | null;
}

/** Unpaywall OA 发现(by DOI)。失败返 null(不抛,best-effort)。 */
async function unpaywallOA(
  doi: string,
  email: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ url?: string; license?: string } | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
      { method: "GET", signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as UnpaywallResp;
    if (!j.is_oa) return null;
    const loc = j.best_oa_location;
    const url = loc?.url_for_pdf ?? loc?.url ?? undefined;
    return { url: url ?? undefined, license: loc?.license ?? undefined };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

/** 多源检索 + 去重 + OA 富化。 */
/** 瞬时出站失败的有界重试:网络(fetch failed)、超时(abort)、5xx/429 才重试;4xx(404 等)
 *  与最后一次直接抛。指数退避(400ms→800ms)。最坏 3×timeout + 1.2s,仍在容器 60s 调用窗内。 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 400): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = errMsg(e);
      const transient = /fetch failed|abort|terminated|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|upstream_5\d\d|upstream_429/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

export async function searchMultiSource(
  input: LitSearchInput,
  deps: LitSearchDeps = {},
): Promise<LitSearchResult> {
  const requested = input.sources?.length ? input.sources : DEFAULT_LIT_SOURCES;
  const explicit = Boolean(input.sources?.length);
  const size = Math.min(Math.max(input.size ?? 20, 1), 100);
  const warnings: string[] = [];
  // 平台门控:s2 仅 s2Enabled=true 参与(默认关,不出网);pubmed 默认参与,
  // pubmedEnabled=false 才剔除。默认候选被剔除时静默;用户**显式**点名被剔除的源
  // 时给 warning(让容器知道为什么该源没结果)。
  const sources = requested.filter((s) => {
    if (s === "pubmed" && deps.pubmedEnabled === false) {
      if (explicit) warnings.push("source pubmed disabled by platform config");
      return false;
    }
    if (s === "s2" && deps.s2Enabled !== true) {
      if (explicit) warnings.push("source s2 disabled by platform config (litSources.s2Enabled)");
      return false;
    }
    return true;
  });
  const opts: SourceSearchOpts = {
    size,
    yearMin: input.yearMin,
    mailto: deps.mailto,
    pubmedEmail: deps.pubmedEmail ?? deps.mailto,
    timeoutMs: deps.timeoutMs,
    fetchImpl: deps.fetchImpl,
  };

  const fns: Record<LitSourceName, () => Promise<SourceRecord[]>> = {
    openalex: () => searchOpenAlex(input.query, opts),
    crossref: () => searchCrossref(input.query, opts),
    arxiv: () => searchArxiv(input.query, opts),
    pubmed: () => searchPubmed(input.query, opts),
    s2: () => searchS2(input.query, opts, { apiKey: deps.s2ApiKey }),
  };

  // 研究 API 出站走 master 全局 EnvHttpProxyAgent(→ 日本 sing-box 代理),偶发瞬时 fetch failed/
  // 超时/5xx(boss #faa3c041:英文检索三源全 fetch failed、中文才成,即代理瞬时抖动)。每个源
  // **整体重试**(重跑 searchX → 新 AbortController/signal,绕开复用已 abort 的 signal);只重试瞬时
  // 类错误(网络/超时/5xx/429),4xx(如 404 not found)不重试。
  const settled = await Promise.allSettled(sources.map((s) => withRetry(() => fns[s](), 3, deps.retryDelayMs ?? 400)));
  const all: SourceRecord[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") all.push(...r.value);
    else warnings.push(`source ${sources[i]} failed: ${errMsg(r.reason)}`);
  });

  if (input.lang === "zh") {
    warnings.push("中文检索:DOI 缺失率高,已用 标题+作者+年 模糊去重;OA 全文以 OA 源/上传文件为准");
  }

  let merged = dedupAndMerge(all);

  // DeepXiv 兜底:主源(OpenAlex/Crossref/arXiv 直连,经日本代理)全空时(出站失败/无命中),用域内
  // 可达的 DeepXiv RAG 补 arXiv 召回(boss #faa3c041:英文检索三源全 fetch failed)。仅在空时触发
  // (不常态加压);失败不影响主结果。
  // 仅当请求的源包含 arxiv 时兜底(DeepXiv 是 arxiv 类;尊重用户显式 --sources 排除 arxiv 的语义)。
  if (merged.length === 0 && deps.deepxiv?.base && deps.deepxiv.token && sources.includes("arxiv")) {
    try {
      const dx = await withRetry(() => searchDeepXiv(input.query, opts, deps.deepxiv!), 2, deps.retryDelayMs ?? 400);
      if (dx.length > 0) {
        merged = dedupAndMerge(dx);
        warnings.push("主源暂不可用,已用 DeepXiv(域内 arXiv RAG)兜底召回");
      }
    } catch (e) {
      warnings.push(`DeepXiv 兜底也失败: ${errMsg(e)}`);
    }
  }

  // OA 富化(Unpaywall,可选):仅对有 DOI 且尚未发现 OA 的记录
  if (deps.unpaywallEmail) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? 8000;
    const targets = merged.filter((r) => r.doi && !(r.oa?.isOA && r.oa.url));
    await Promise.all(
      targets.map(async (r) => {
        const oa = await unpaywallOA(r.doi!, deps.unpaywallEmail!, fetchImpl, timeoutMs);
        if (oa?.url) r.oa = { isOA: true, url: oa.url, license: oa.license, source: "unpaywall" };
      }),
    );
    merged = merged.slice(); // 上面是原地改 oa,这里仅保持引用语义清晰
  }

  return { sources: merged, warnings };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
