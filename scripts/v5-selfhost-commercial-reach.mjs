#!/usr/bin/env node
// Which packages/commercial modules can the selfhost master reach? (OCV5-376 P8, read-only)
//
// The selfhost master runs `tsx packages/cli/src/index.ts gateway` from an immutable release.
// This bundles that entry with esbuild in memory (nothing is executed or written) and reads the
// metafile: every module reachable through static and literal dynamic imports. Third-party
// packages are external; @openclaude/* workspace packages are followed into the tree.
//
//   node scripts/v5-selfhost-commercial-reach.mjs [--root <tree or release dir>] [--json]
//
// Default root: this checkout. Typical use: --root "$(readlink -f /opt/openclaude/openclaude-v5-selfhost-live)".
// Reachable is an upper bound of what master can load; flavor checks at runtime decide what starts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = resolve(args.includes("--root") ? args[args.indexOf("--root") + 1] : join(here, ".."));
const asJson = args.includes("--json");
const esbuild = createRequire(join(here, "..", "package.json"))("esbuild");

function packageNames(dir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      if (name === "@openclaude") continue;
      for (const sub of readdirSync(join(dir, name))) out.push(`${name}/${sub}`);
    } else out.push(name);
  }
  return out;
}
const nodeModuleDirs = [join(root, "node_modules"), join(root, "claude-code-best", "node_modules")];
for (const pkg of readdirSync(join(root, "packages"))) nodeModuleDirs.push(join(root, "packages", pkg, "node_modules"));
const external = [...new Set(nodeModuleDirs.flatMap(packageNames))];

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["packages/cli/src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  splitting: true,
  outdir: "/nonexistent-g376",
  write: false,
  metafile: true,
  logLevel: "silent",
  external: [...external, "node:*"],
  loader: { ".node": "empty", ".md": "text", ".sql": "text" },
});
const reachable = new Set(Object.keys(result.metafile.inputs).map((p) => relative(root, resolve(root, p))));

const commercialSrc = join(root, "packages", "commercial", "src");
const skipDir = new Set(["node_modules", "__tests__", "__fixtures__", "fixtures"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!skipDir.has(name)) walk(path);
    } else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|integ\.test|spec)\.tsx?$/.test(name)) {
      files.push(relative(root, path));
    }
  }
})(commercialSrc);

const lines = (p) => readFileSync(join(root, p), "utf8").split("\n").length;
const byDir = new Map();
const unreachable = [];
for (const file of files) {
  const parts = file.split("/");
  const dir = parts.length > 4 ? parts[3] : "(root)";
  const row = byDir.get(dir) ?? { files: 0, lines: 0, unreachableFiles: 0, unreachableLines: 0 };
  const n = lines(file);
  row.files += 1;
  row.lines += n;
  if (!reachable.has(file)) {
    row.unreachableFiles += 1;
    row.unreachableLines += n;
    unreachable.push({ file, lines: n });
  }
  byDir.set(dir, row);
}
const total = [...byDir.values()].reduce((a, r) => ({ files: a.files + r.files, lines: a.lines + r.lines }), { files: 0, lines: 0 });
const unr = unreachable.reduce((a, r) => ({ files: a.files + 1, lines: a.lines + r.lines }), { files: 0, lines: 0 });
const report = {
  root,
  entry: "packages/cli/src/index.ts",
  commercial: { files: total.files, lines: total.lines },
  reachable: { files: total.files - unr.files, lines: total.lines - unr.lines },
  unreachable: { files: unr.files, lines: unr.lines, list: unreachable.sort((a, b) => b.lines - a.lines) },
  byDir: Object.fromEntries([...byDir.entries()].sort((a, b) => b[1].unreachableLines - a[1].unreachableLines)),
};
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`root ${root}`);
  console.log(`commercial src (non-test): ${total.files} files, ${total.lines} lines`);
  console.log(`reachable from ${report.entry}: ${report.reachable.files} files, ${report.reachable.lines} lines`);
  console.log(`not reachable: ${unr.files} files, ${unr.lines} lines`);
  for (const { file, lines: n } of report.unreachable.list) console.log(`  ${String(n).padStart(6)}  ${file}`);
}
