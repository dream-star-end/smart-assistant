/**
 * oc-lit — 容器内多源文献检索 CLI(OpenAlex/Crossref/arXiv,平台持 key 走 master)。
 *
 * 用法(baseline skill oc-lit 文档化):
 *   oc-lit search <query> [--sources openalex,crossref,arxiv] [--size 20] [--year-min 2020] [--lang zh|en]
 *   oc-lit snowball <id> [--direction backward|forward|both] [--size N]
 *   oc-lit fetch <id|records.json> [--project P] [--no-ingest]        # OA 全文下载+入库(单条/≤5)
 *   oc-lit fetch-batch <records.json> --request-id <rid> [--project P] # 异步批量(≤200,durable job)
 *   oc-lit job-status <requestId>                                     # 批量 job 状态轮询
 *
 * 输出:JSON { sources: SourceRecord[], warnings: string[] }(检索)/ { results } / { job }(下载)。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  callResearch,
  exitWithCliHelp,
  fail,
  isCliHelpArg,
  out,
  parseFlags,
} from "./ocResearchClient.js";

const TOOL = "oc-lit";

const USAGE =
  "usage: oc-lit <search <query> [--sources ...] [--size N] [--year-min Y] [--lang zh|en] | snowball <id> [--direction ...] | fetch <id|records.json> [--project P] [--no-ingest] | fetch-batch <records.json> --request-id <rid> [--project P] | job-status <requestId>>";

/** 单个 identifier(doi:/arxiv:/裸 DOI/arXiv id)→ 紧凑 fetch 记录。 */
function recordFromIdentifier(id: string): Record<string, string> | null {
  const s = id.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower.startsWith("doi:") || /^10\.\d{4,}\//.test(s) || lower.includes("doi.org/")) {
    return { id: s.replace(/^doi:/i, ""), doi: s.replace(/^doi:/i, "") };
  }
  if (
    lower.startsWith("arxiv:") ||
    lower.includes("arxiv.org/") ||
    /^\d{4}\.\d{4,5}(v\d+)?$/.test(s)
  ) {
    const arxivId = s.replace(/^arxiv:/i, "").replace(/^https?:\/\/arxiv\.org\/abs\//i, "");
    return { id: `arxiv:${arxivId.replace(/v\d+$/, "")}`, arxivId: arxivId.replace(/v\d+$/, "") };
  }
  return null;
}

/** 读 records 文件(数组或 {records:[]}),条目至少含 id;返回 null=不可解析。 */
function readRecordsFile(file: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { records?: unknown }).records)
      ? (parsed as { records: unknown[] }).records
      : null;
  if (!arr) return null;
  const ok = arr.every(
    (r) => r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string",
  );
  return ok ? arr : null;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (isCliHelpArg(cmd)) {
    exitWithCliHelp(USAGE);
  }
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "search": {
      const query = positional.join(" ").trim();
      if (!query) fail(TOOL, "search <query>");
      const body: Record<string, unknown> = { query };
      if (flags.sources) {
        body.sources = flags.sources
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (flags.size) body.size = Number(flags.size);
      if (flags["year-min"]) body.yearMin = Number(flags["year-min"]);
      if (flags.lang === "zh" || flags.lang === "en") body.lang = flags.lang;
      out(await callResearch(TOOL, "lit/search", body));
      return;
    }
    case "snowball": {
      const seed = positional[0] ?? flags.seed;
      if (!seed)
        fail(
          TOOL,
          "snowball <DOI|arXiv|OpenAlex id> [--direction backward|forward|both] [--size N]",
        );
      const body: Record<string, unknown> = { seed };
      if (flags.direction) body.direction = flags.direction;
      if (flags.size) body.size = Number(flags.size);
      out(await callResearch(TOOL, "lit/snowball", body));
      return;
    }
    case "fetch": {
      // fetch <id|records.json>:identifier 或 records 文件(≤5 条;更多用 fetch-batch)
      const arg = positional[0] ?? flags.id;
      if (!arg) fail(TOOL, "fetch <id|records.json> [--project P] [--no-ingest]");
      let records: unknown[];
      if (existsSync(arg)) {
        const parsed = readRecordsFile(arg);
        if (!parsed)
          fail(
            TOOL,
            `records file must be a JSON array (or {records:[]}) of {id,doi?,arxivId?,title?}: ${arg}`,
          );
        records = parsed.slice(0, 5);
        if (records.length === 0) fail(TOOL, "records file is empty");
      } else {
        const rec = recordFromIdentifier(arg);
        if (!rec)
          fail(TOOL, "fetch <id>: 需要 doi:.../10.x/... 或 arXiv id,或一个 records JSON 文件路径");
        records = [rec];
      }
      const body: Record<string, unknown> = { records };
      if (flags.project) body.projectId = flags.project;
      body.ingest = !(flags["no-ingest"] === "true" || flags.ingest === "false");
      out(await callResearch(TOOL, "lit/fetch", body));
      return;
    }
    case "fetch-batch": {
      // fetch-batch <records.json> --request-id <rid>(幂等:同 requestId 重提=续跑/查状态)
      const file = positional[0] ?? flags.ids;
      if (!file) fail(TOOL, "fetch-batch <records.json> --request-id <rid> [--project P]");
      const rid = flags["request-id"];
      if (!rid) fail(TOOL, "fetch-batch 需要 --request-id <rid>(幂等续跑键)");
      const parsed = readRecordsFile(file);
      if (!parsed)
        fail(
          TOOL,
          `records file must be a JSON array (or {records:[]}) of {id,doi?,arxivId?,title?}: ${file}`,
        );
      const records = parsed.slice(0, 200);
      if (records.length === 0) fail(TOOL, "records file is empty");
      const body: Record<string, unknown> = { records, requestId: rid };
      if (flags.project) body.projectId = flags.project;
      out(await callResearch(TOOL, "lit/fetch-batch", body));
      return;
    }
    case "job-status": {
      const rid = positional[0] ?? flags["request-id"];
      if (!rid) fail(TOOL, "job-status <requestId>");
      out(await callResearch(TOOL, "job/status", { requestId: rid }));
      return;
    }
    default:
      fail(TOOL, USAGE);
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
