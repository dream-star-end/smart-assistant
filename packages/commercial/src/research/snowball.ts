/**
 * 引用图 snowball(方案 §12 P2)— OpenAlex 前/后向扩展。
 *
 * 给定 seed 文献,沿引用关系扩展相关文献(文献综述/找全相关工作):
 *   - backward(后向):seed 引用的文献(OpenAlex work.referenced_works)。
 *   - forward(前向):引用 seed 的文献(OpenAlex /works?filter=cites:<id>)。
 * 元数据走 OpenAlex 免费 API(polite via mailto);**不代爬全文**。
 */

import type { SourceRecord } from "@openclaude/protocol/research";
import {
  type FetchLike,
  normalizeArxivId,
  normalizeDoi,
  parseOpenAlexWork,
} from "./sources.js";

export type SnowballDirection = "backward" | "forward" | "both";

export interface SnowballInput {
  /** seed:doi/arxiv/openalex id(带或不带前缀)。 */
  seed: string;
  direction?: SnowballDirection;
  size?: number;
}

export interface SnowballDeps {
  mailto?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface SnowballResult {
  seedId: string | null;
  sources: SourceRecord[];
  warnings: string[];
}

const DEFAULT_TIMEOUT = 12_000;

async function oaGet(url: string, deps: SnowballDeps): Promise<unknown> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

/** 解析 seed → OpenAlex work 选择器(path 段)。返回 null=无法识别。 */
export function seedToOpenAlexSelector(seed: string): string | null {
  const s = seed.trim();
  const lower = s.toLowerCase();
  if (/^w\d+$/i.test(s)) return s.toUpperCase();
  if (lower.startsWith("openalex:")) {
    const id = s.slice(9).trim();
    return /^w\d+$/i.test(id) ? id.toUpperCase() : null;
  }
  const arx = lower.startsWith("arxiv:") || lower.includes("arxiv.org/") || /^\d{4}\.\d{4,5}(v\d+)?$/.test(s)
    ? normalizeArxivId(s)
    : undefined;
  if (arx) return `doi:10.48550/arxiv.${arx}`; // arXiv 在 OpenAlex 以 DataCite DOI 收录
  const doi = lower.startsWith("doi:") ? normalizeDoi(s.slice(4)) : normalizeDoi(s);
  if (doi && /^10\.\d{4,}\//.test(doi)) return `doi:${doi}`;
  return null;
}

const OA_ORIGIN = "https://api.openalex.org";

/** 二次 parse 断言(防 path/query 混淆;同 cite.ts)。 */
function safeOaUrl(rawUrl: string, pathPrefix: string, query?: Record<string, string>): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.origin !== OA_ORIGIN || u.search !== "" || u.hash !== "" || u.username || u.password) return null;
  if (!u.pathname.startsWith(pathPrefix)) return null;
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

interface OAWorkRaw {
  id?: string;
  referenced_works?: string[];
  title?: string | null;
  display_name?: string | null;
}

export async function snowball(input: SnowballInput, deps: SnowballDeps = {}): Promise<SnowballResult> {
  const direction = input.direction ?? "both";
  // NaN/非有限 → 回落 20(防 per-page=NaN)
  const size = Math.min(Math.max(Number.isFinite(input.size) ? (input.size as number) : 20, 1), 100);
  const warnings: string[] = [];
  const selector = seedToOpenAlexSelector(input.seed);
  if (!selector) {
    return { seedId: null, sources: [], warnings: ["无法识别 seed(需 DOI/arXiv/OpenAlex id)"] };
  }
  const mailtoQ = deps.mailto ? { mailto: deps.mailto } : undefined;

  // 1) 取 seed work
  let seed: OAWorkRaw | null = null;
  const seedUrl = safeOaUrl(`${OA_ORIGIN}/works/${selector}`, "/works/", mailtoQ);
  if (seedUrl) {
    try {
      seed = (await oaGet(seedUrl, deps)) as OAWorkRaw;
    } catch (e) {
      warnings.push(`seed 解析失败: ${errMsg(e)}`);
    }
  }
  if (!seed?.id) {
    return { seedId: null, sources: [], warnings: [...warnings, "seed 未在 OpenAlex 命中"] };
  }
  const seedId: string = seed.id;
  const out: SourceRecord[] = [];
  const seen = new Set<string>();

  // 2) backward:referenced_works(取前 size 个 id,批量过滤拉取)
  if ((direction === "backward" || direction === "both") && Array.isArray(seed.referenced_works)) {
    const refIds = seed.referenced_works.slice(0, size).map((u) => u.split("/").pop()).filter(Boolean) as string[];
    if (refIds.length > 0) {
      const url = safeOaUrl(`${OA_ORIGIN}/works`, "/works", {
        filter: `openalex_id:${refIds.join("|")}`,
        "per-page": String(size),
        ...(mailtoQ ?? {}),
      });
      if (url) {
        try {
          const j = (await oaGet(url, deps)) as { results?: Parameters<typeof parseOpenAlexWork>[0][] };
          for (const w of j.results ?? []) pushRec(out, seen, parseOpenAlexWork(w));
        } catch (e) {
          warnings.push(`backward 拉取失败: ${errMsg(e)}`);
        }
      }
    }
  }

  // 3) forward:cites:<seedId>
  if (direction === "forward" || direction === "both") {
    const url = safeOaUrl(`${OA_ORIGIN}/works`, "/works", {
      filter: `cites:${seedId.split("/").pop()}`,
      "per-page": String(size),
      ...(mailtoQ ?? {}),
    });
    if (url) {
      try {
        const j = (await oaGet(url, deps)) as { results?: Parameters<typeof parseOpenAlexWork>[0][] };
        for (const w of j.results ?? []) pushRec(out, seen, parseOpenAlexWork(w));
      } catch (e) {
        warnings.push(`forward 拉取失败: ${errMsg(e)}`);
      }
    }
  }

  return { seedId, sources: out.slice(0, size), warnings };
}

function pushRec(out: SourceRecord[], seen: Set<string>, rec: SourceRecord): void {
  if (!rec.title) return;
  const key = rec.doi ? `doi:${rec.doi}` : rec.openalexId ?? rec.id;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(rec);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
