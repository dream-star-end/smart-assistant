/**
 * oc-ingest — 容器内文档解析 CLI(上传字节 → master 从字节铸造权威 NormalizedDocument)。
 *
 * 用法(baseline skill oc-ingest 文档化):
 *   oc-ingest parse <file> [--project <id>]   # 上传并解析,挂当前/指定课题
 *   oc-ingest list [--project <id>]           # 列课题文献元数据
 *
 * 输出 { docId, lang, title, sections, spanCount } 或 { needsOcr, reason }。
 * docId 供 oc-litrag 检索引用(quote handle 从权威 span 铸造)。
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
  uploadBlob,
} from "./ocResearchClient.js";

const TOOL = "oc-ingest";
const USAGE = `usage: oc-ingest parse <file> [--project <id>]
       oc-ingest list [--project <id>]`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (isCliHelpArg(cmd)) exitWithCliHelp(USAGE);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "parse": {
      const file = positional[0];
      if (!file) fail(TOOL, "parse <file> [--project <id>]");
      const blob = await uploadBlob(TOOL, file);
      const filename = file.split("/").pop();
      const body: Record<string, unknown> = { blobId: blob.blobId, filename };
      if (isResearchWorkspaceEnabled()) {
        const projectId = resolveCliResearchProjectId(flags);
        if (projectId) body.projectId = projectId;
      }
      out(await callResearch(TOOL, "ingest/parse", body));
      return;
    }
    case "list": {
      const body: Record<string, unknown> = {};
      if (isResearchWorkspaceEnabled()) {
        const projectId = resolveCliResearchProjectId(flags);
        if (projectId) body.projectId = projectId;
      }
      out(await callResearch(TOOL, "library/list", body));
      return;
    }
    default:
      fail(TOOL, USAGE);
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
