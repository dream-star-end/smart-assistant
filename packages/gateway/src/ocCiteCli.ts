/**
 * oc-cite — 容器内引用接地门禁 CLI(Phase 1:identifier 回查 + 撤稿 + 格式化)。
 *
 * 用法(baseline skill oc-cite 文档化):
 *   oc-cite verify <id...>            # DOI/arXiv/OpenAlex/PMID/ADS bibcode 回查 + 撤稿(闸③④)
 *   oc-cite format <id> [--style gb-t-7714-2015|ieee|nature|apa|bibtex] [--doc-id <id>] [--span-id <id>] [--evidence-grade <A|B>]
 *   oc-cite check --manifest <file>   # 证据 manifest 接地校验(闸①②③④,master 铸 verified)
 *   oc-cite fix --manifest <file> --docs <docId,...>
 *
 * verify 输出 { verdicts }:resolved=false 或 retracted=true 即"不可信引用",不得写进
 * "已验证参考文献"。check 输出已检 manifest:claim.status 由 master 铸造,unsupported 红标。
 */
import { readFileSync } from "node:fs";
import { callResearch, exitWithCliHelp, fail, isCliHelpArg, out, parseFlags } from "./ocResearchClient.js";

const TOOL = "oc-cite";
const USAGE = `usage:
  oc-cite verify <id...>
  oc-cite format <id> [--style <style>] [--doc-id <docId>] [--span-id <spanId>] [--evidence-grade <A|B>]
  oc-cite check --manifest <file>
  oc-cite fix --manifest <file> --docs <docId,...>

id 支持:
  doi:/arxiv:/openalex:/pmid:/ads:<bibcode>

--style 支持 5 种格式:
  gb-t-7714-2015 (默认, 别名 gb-t-7714) | ieee | nature | apa | bibtex

format 可选参数:
  --doc-id <docId>           绑定已入库的本地权威文档 ID
  --span-id <spanId>         绑定本地文档的权威 span ID (需与 --doc-id 同时提供, 经 master 核验匹配后授分级 A)
  --evidence-grade <A|B>     证据来源分级 (显式传 B 可降级为摘要/题录级; A 仅由 master 本地全文核验铸造)

用法示例:
  oc-cite verify 10.1038/s41586-024-0001 arxiv:2301.00001
  oc-cite format 10.1038/s41586-024-0001 --style gb-t-7714-2015
  oc-cite format 10.1038/s41586-024-0001 --style ieee --doc-id doc:abc123 --span-id s0
  oc-cite format 10.1038/s41586-024-0001 --style nature
  oc-cite format 10.1038/s41586-024-0001 --style apa --evidence-grade B
  oc-cite format arxiv:2301.00001 --style bibtex
  oc-cite check --manifest manifest.json
  oc-cite fix --manifest manifest.json --docs doc:abc123,doc:def456`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (isCliHelpArg(cmd) || rest.includes("--help") || rest.includes("-h")) {
    exitWithCliHelp(USAGE);
  }
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "verify": {
      if (positional.length === 0) fail(TOOL, "verify <id...>");
      out(await callResearch(TOOL, "cite/verify", { identifiers: positional }));
      return;
    }
    case "format": {
      const id = positional[0] ?? flags.id;
      if (!id) {
        fail(
          TOOL,
          "format <id> --style gb-t-7714-2015|gb-t-7714|ieee|nature|apa|bibtex [--doc-id <docId>] [--span-id <spanId>] [--evidence-grade <A|B>]",
        );
      }
      const style = flags.style ?? "gb-t-7714-2015";
      out(
        await callResearch(TOOL, "cite/format", {
          identifier: id,
          style,
          ...(flags["evidence-grade"] ? { evidenceGrade: flags["evidence-grade"] } : {}),
          ...(flags["doc-id"] ? { docId: flags["doc-id"] } : {}),
          ...(flags["span-id"] ? { spanId: flags["span-id"] } : {}),
        }),
      );
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
    case "fix": {
      const file = flags.manifest ?? positional[0];
      if (!file) fail(TOOL, "fix --manifest <file> --docs <docId,...>");
      const docIds = (flags.docs ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (docIds.length === 0) fail(TOOL, "fix 需 --docs <docId,...>(用于重检索的权威文档)");
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        fail(TOOL, `cannot read/parse manifest: ${file}`);
      }
      out(await callResearch(TOOL, "cite/fix", { manifest, docIds }));
      return;
    }
    default:
      fail(TOOL, USAGE);
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
