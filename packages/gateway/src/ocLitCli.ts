/**
 * oc-lit — 容器内多源文献检索 CLI(OpenAlex/Crossref/arXiv,平台持 key 走 master)。
 *
 * 用法(baseline skill oc-lit 文档化):
 *   oc-lit search <query> [--sources openalex,crossref,arxiv] [--size 20] [--year-min 2020] [--lang zh|en]
 *
 * 输出:JSON { sources: SourceRecord[], warnings: string[] }(角标/库面板从此渲染)。
 */
import { callResearch, exitWithCliHelp, fail, isCliHelpArg, out, parseFlags } from "./ocResearchClient.js";

const TOOL = "oc-lit";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (isCliHelpArg(cmd)) {
    exitWithCliHelp(
      "usage: oc-lit <search <query> [--sources ...] [--size N] [--year-min Y] [--lang zh|en] | snowball <id> [--direction ...]>",
    );
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
      if (!seed) fail(TOOL, "snowball <DOI|arXiv|OpenAlex id> [--direction backward|forward|both] [--size N]");
      const body: Record<string, unknown> = { seed };
      if (flags.direction) body.direction = flags.direction;
      if (flags.size) body.size = Number(flags.size);
      out(await callResearch(TOOL, "lit/snowball", body));
      return;
    }
    default:
      fail(
        TOOL,
        "usage: oc-lit <search <query> [--sources ...] [--size N] [--year-min Y] [--lang zh|en] | snowball <id> [--direction ...]>",
      );
  }
}

main().catch((e) => fail(TOOL, e instanceof Error ? e.message : String(e)));
