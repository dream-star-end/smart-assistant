/**
 * oc-litrag — 容器内 quote-first RAG CLI(在已 ingest 的权威文档上检索 → quote handles)。
 *
 * 用法(baseline skill oc-litrag 文档化):
 *   oc-litrag query "<问题>" --docs <docId,docId> [--top-k 8]
 *
 * 输出 { quotes: QuoteHandle[], missing: string[] }。quote.text 是 master 权威 span 子串
 * (写作唯一可引用素材);写 claim 只能引用这些 quote 的 id。
 */
import { callResearch, fail, out, parseFlags } from "./ocResearchClient.js";

const TOOL = "oc-litrag";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "query": {
      const query = positional.join(" ").trim();
      if (!query) fail(TOOL, 'query "<问题>" --docs <docId,...>');
      const docIds = (flags.docs ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (docIds.length === 0) fail(TOOL, "--docs <docId,...> required (先用 oc-ingest parse 得到 docId)");
      const body: Record<string, unknown> = { query, docIds };
      if (flags["top-k"]) body.topK = Number(flags["top-k"]);
      out(await callResearch(TOOL, "litrag/query", body));
      return;
    }
    default:
      fail(TOOL, 'usage: oc-litrag query "<问题>" --docs <docId,...> [--top-k N]');
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
