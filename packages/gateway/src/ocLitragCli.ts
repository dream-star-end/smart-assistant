/**
 * oc-litrag — 容器内 quote-first RAG CLI(在已 ingest 的权威文档上检索 → quote handles)。
 *
 * 用法(baseline skill oc-litrag 文档化):
 *   oc-litrag query "<问题>" [--docs <docId,...>] [--project <id>] [--top-k 8]
 *
 * 无 --docs 且 OC_RESEARCH_WORKSPACE 开启时走当前课题 membership(截 50)。
 * 输出 { quotes: QuoteHandle[], missing: string[], truncated?, docCount? }。
 * quote.text 是 master 权威 span 子串(写作唯一可引用素材);写 claim 只能引用这些 quote 的 id。
 */
import {
  callResearch,
  exitWithCliHelp,
  fail,
  isCliHelpArg,
  isResearchWorkspaceEnabled,
  out,
  parseFlags,
  resolveCliResearchProjectId,
} from "./ocResearchClient.js";

const TOOL = "oc-litrag";
const USAGE = 'usage: oc-litrag query "<问题>" [--docs <docId,...>] [--project <id>] [--top-k N]';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (isCliHelpArg(cmd)) {
    exitWithCliHelp(USAGE);
  }
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "query": {
      const query = positional.join(" ").trim();
      if (!query) fail(TOOL, 'query "<问题>" [--docs <docId,...>] [--project <id>] [--top-k N]');
      const docIds = (flags.docs ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const workspaceOn = isResearchWorkspaceEnabled();
      if (docIds.length === 0 && !workspaceOn) {
        fail(TOOL, "--docs <docId,...> required (先用 oc-ingest parse 得到 docId)");
      }
      const body: Record<string, unknown> = { query };
      if (docIds.length > 0) body.docIds = docIds;
      if (flags["top-k"]) body.topK = Number(flags["top-k"]);
      if (workspaceOn) {
        const projectId = resolveCliResearchProjectId(flags);
        if (projectId) body.projectId = projectId;
      }
      out(await callResearch(TOOL, "litrag/query", body));
      return;
    }
    default:
      fail(TOOL, USAGE);
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
