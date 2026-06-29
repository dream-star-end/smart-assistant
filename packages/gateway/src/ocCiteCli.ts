/**
 * oc-cite — 容器内引用接地门禁 CLI(Phase 1:identifier 回查 + 撤稿 + 格式化)。
 *
 * 用法(baseline skill oc-cite 文档化):
 *   oc-cite verify <id...>            # DOI/arXiv/OpenAlex 回查 + 撤稿(闸③④)
 *   oc-cite format <id> --style gb-t-7714-2015|apa|bibtex
 *
 * verify 输出 { verdicts: CitationVerdict[] }:resolved=false 或 retracted=true
 * 即"不可信引用",不得写进"已验证参考文献"。
 */
import { callResearch, fail, out, parseFlags } from "./ocResearchClient.js";

const TOOL = "oc-cite";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "verify": {
      if (positional.length === 0) fail(TOOL, "verify <id...>");
      out(await callResearch(TOOL, "cite/verify", { identifiers: positional }));
      return;
    }
    case "format": {
      const id = positional[0] ?? flags.id;
      if (!id) fail(TOOL, "format <id> --style gb-t-7714-2015|apa|bibtex");
      const style = flags.style ?? "gb-t-7714-2015";
      out(await callResearch(TOOL, "cite/format", { identifier: id, style }));
      return;
    }
    default:
      fail(TOOL, "usage: oc-cite <verify <id...>|format <id> --style ...>");
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
