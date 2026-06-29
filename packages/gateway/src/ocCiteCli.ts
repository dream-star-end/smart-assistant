/**
 * oc-cite — 容器内引用接地门禁 CLI(Phase 1:identifier 回查 + 撤稿 + 格式化)。
 *
 * 用法(baseline skill oc-cite 文档化):
 *   oc-cite verify <id...>            # DOI/arXiv/OpenAlex 回查 + 撤稿(闸③④)
 *   oc-cite format <id> --style gb-t-7714-2015|apa|bibtex
 *   oc-cite check --manifest <file>   # 证据 manifest 接地校验(闸①②③④,master 铸 verified)
 *
 * verify 输出 { verdicts }:resolved=false 或 retracted=true 即"不可信引用",不得写进
 * "已验证参考文献"。check 输出已检 manifest:claim.status 由 master 铸造,unsupported 红标。
 */
import { readFileSync } from "node:fs";
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
    case "check": {
      const file = flags.manifest ?? positional[0];
      if (!file) fail(TOOL, "check --manifest <file>");
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        fail(TOOL, `cannot read/parse manifest: ${file}`);
      }
      out(await callResearch(TOOL, "cite/check", { manifest }));
      return;
    }
    default:
      fail(TOOL, "usage: oc-cite <verify <id...>|format <id> --style ...|check --manifest <file>>");
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
