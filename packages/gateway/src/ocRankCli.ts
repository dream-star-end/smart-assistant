/**
 * oc-rank — 确定性候选排名(tournament debate / tree-search 变体选择用)。
 *
 * leader 用 delegate 生成 N 候选 + 跑 pairwise 评审,把评审结果喂这里算 Elo 排名
 * (排名确定,不让 LLM 心算)。用法(baseline skill research-tournament 文档化):
 *   oc-rank elo --matches <matches.json>
 * matches.json = { items: string[], matches: [{a,b,winner:'a'|'b'|'draw'}] }
 * 输出 { ranked: [{id,rating,wins,losses,draws}] };ranked[0] 即胜者。
 */
import { readFileSync } from "node:fs";
import { type Match, computeElo } from "./rank.js";

const TOOL = "oc-rank";

function fail(msg: string): never {
  process.stderr.write(`${TOOL}: ${msg}\n`);
  process.exit(1);
}

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write("usage: oc-rank elo --matches <file>\n");
    process.exit(0);
  }
  if (cmd !== "elo") fail("usage: oc-rank elo --matches <file>");
  const file = flagVal(rest, "--matches");
  if (!file) fail("elo --matches <file>");
  let data: { items?: unknown; matches?: unknown };
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`cannot read/parse ${file}`);
  }
  const items = Array.isArray(data.items) ? data.items.filter((x): x is string => typeof x === "string") : [];
  const matches = Array.isArray(data.matches)
    ? (data.matches.filter(
        (m) =>
          m &&
          typeof (m as Match).a === "string" &&
          typeof (m as Match).b === "string" &&
          ((m as Match).winner === "a" || (m as Match).winner === "b" || (m as Match).winner === "draw"),
      ) as Match[])
    : [];
  if (items.length === 0) fail("items[] required");
  const ranked = computeElo(items, matches);
  process.stdout.write(`${JSON.stringify({ ranked }, null, 2)}\n`);
}

main();
