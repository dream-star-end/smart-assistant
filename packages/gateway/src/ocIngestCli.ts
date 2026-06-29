/**
 * oc-ingest — 容器内文档解析 CLI(上传字节 → master 从字节铸造权威 NormalizedDocument)。
 *
 * 用法(baseline skill oc-ingest 文档化):
 *   oc-ingest parse <file>            # 上传并解析,返回 docId + 章节大纲(权威 span 文本留 master)
 *
 * 输出 { docId, lang, title, sections, spanCount } 或 { needsOcr, reason }。
 * docId 供 oc-litrag 检索引用(quote handle 从权威 span 铸造)。
 */
import { callResearch, fail, out, parseFlags, uploadBlob } from "./ocResearchClient.js";

const TOOL = "oc-ingest";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional } = parseFlags(rest);

  switch (cmd) {
    case "parse": {
      const file = positional[0];
      if (!file) fail(TOOL, "parse <file>");
      const blob = await uploadBlob(TOOL, file);
      const filename = file.split("/").pop();
      out(await callResearch(TOOL, "ingest/parse", { blobId: blob.blobId, filename }));
      return;
    }
    default:
      fail(TOOL, "usage: oc-ingest parse <file>");
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
