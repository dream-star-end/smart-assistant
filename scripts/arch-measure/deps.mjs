#!/usr/bin/env node
// OCV5-540: plan §1.2–§1.5 module and dependency numbers (appendix A.1).
// Value imports skip `import type` / `export type`. Commercial directory graph: one node per
// commercial/src top-level dir, root files merged into `_root`, edges out of commercial/src/index.ts
// dropped (it is the composition root), Tarjan SCC.
// Usage: node scripts/arch-measure/deps.mjs [--root <repo>] [--json]
import path from "node:path";
import { emit, parseArgs, prodFiles, read, resolveRelative, scanImports, scc } from "./lib.mjs";

const args = parseArgs();
const R = args.root;
const rows = [];
const add = (id, value, what) => rows.push({ id, value, what });

const PKG_DIRS = ["protocol", "storage", "gateway", "commercial", "cli", "mcp-memory", "plugin-sdk", "web-react",
  "channels/wechat", "channels/feishu", "channels/telegram", "channels/webchat"];
const filesOf = new Map(PKG_DIRS.map((p) => [p, prodFiles(R, `packages/${p}`)]));
const refsCache = new Map();
function refs(f) {
  if (!refsCache.has(f)) refsCache.set(f, scanImports(read(R, f)));
  return refsCache.get(f);
}
const pkgOfSpec = (spec) => {
  const m = /^@openclaude\/([a-z0-9-]+)/.exec(spec);
  if (!m) return null;
  // channel packages are named @openclaude/channel-<x> and live in packages/channels/<x>
  return m[1].startsWith("channel-") ? `channels/${m[1].slice("channel-".length)}` : m[1];
};

// ── §1.2 package edges (value), and the commercial → gateway edge count ──
const pkgEdges = new Map();
for (const [p, files] of filesOf) {
  for (const f of files) for (const r of refs(f)) {
    const q = pkgOfSpec(r.spec);
    if (!q || q === p || r.kind !== "value") continue;
    const k = `${p}→${q}`;
    pkgEdges.set(k, (pkgEdges.get(k) ?? 0) + 1);
  }
}
const pg = new Map(PKG_DIRS.map((p) => [p, new Set()]));
for (const k of pkgEdges.keys()) { const [a, b] = k.split("→"); pg.get(a)?.add(b); }
add("pkg.valueEdges", [...pkgEdges.keys()].sort().join(" "), "package-level value edges (§1.2)");
const pkgComps = scc(pg).filter((c) => c.length > 1);
add("pkg.cycles", pkgComps.length, "package-level non-trivial value SCCs (§1.2 says none)");
add("pkg.cycleMembers", pkgComps.map((c) => c.join("+")).join(" ") || "-", "members of each package-level cycle");
let cg = 0; let cgv = 0;
for (const f of filesOf.get("commercial")) for (const r of refs(f)) {
  if (!/^@openclaude\/gateway(\/|$)/.test(r.spec)) continue;
  cg++; if (r.kind === "value") cgv++;
}
add("commercial→gateway.refs", cg, "import statements from commercial to @openclaude/gateway* (§1.2, 35)");
add("commercial→gateway.valueRefs", cgv, "of which value imports (§1.2, 15)");

// ── §1.2 protocol purity and web-react usage ──
let nodeImports = 0;
for (const f of filesOf.get("protocol")) {
  if (!f.startsWith("packages/protocol/src/")) continue;
  for (const r of refs(f)) if (r.spec.startsWith("node:") && r.kind === "value") nodeImports++;
}
add("protocol.nodeImports", nodeImports, "node:* value imports in protocol/src (§1.2, 5)");
let webProto = 0; let webProtoRoot = 0;
for (const f of filesOf.get("web-react")) {
  const rs = refs(f).filter((r) => /^@openclaude\/protocol(\/|$)/.test(r.spec));
  if (!rs.length) continue;
  webProto++;
  if (rs.some((r) => r.spec === "@openclaude/protocol")) webProtoRoot++;
}
add("web-react→protocol.files", webProto, "web-react non-test files importing protocol, incl. browser-tests/ (§1.2, 59)");
add("web-react→protocol.rootBarrel", webProtoRoot, "of which via the root barrel (§1.2, 43)");

// ── §1.1 storage importers per package ──
const storageUsers = [];
for (const [p, files] of filesOf) {
  if (p === "storage") continue;
  const n = files.filter((f) => refs(f).some((r) => /^@openclaude\/storage(\/|$)/.test(r.spec))).length;
  if (n) storageUsers.push(`${p}=${n}`);
}
add("storage.importerFiles", storageUsers.join(" "), "files importing @openclaude/storage per package (§1.1)");

// ── §1.3 commercial directory graph ──
const CSRC = "packages/commercial/src/";
const cfiles = filesOf.get("commercial").filter((f) => f.startsWith(CSRC));
const nodeOf = (f) => {
  const rest = f.slice(CSRC.length);
  return rest.includes("/") ? rest.split("/")[0] : "_root";
};
const dirGraph = new Map();
const fileGraph = new Map();
const dirEdgeFiles = new Map(); // "a→b" -> Set(files in a importing b)
for (const f of cfiles) {
  const a = nodeOf(f);
  if (a === "__tests__") continue;
  if (!dirGraph.has(a)) dirGraph.set(a, new Set());
  if (!fileGraph.has(f)) fileGraph.set(f, new Set());
  for (const r of refs(f)) {
    if (r.kind !== "value") continue;
    const t = resolveRelative(R, f, r.spec);
    if (!t || !t.startsWith(CSRC)) continue;
    fileGraph.get(f).add(t);
    if (f === `${CSRC}index.ts`) continue;
    const b = nodeOf(t);
    if (b === "__tests__") continue;
    if (b !== a) {
      dirGraph.get(a).add(b);
      const k = `${a}→${b}`;
      if (!dirEdgeFiles.has(k)) dirEdgeFiles.set(k, new Set());
      dirEdgeFiles.get(k).add(f);
    }
  }
}
for (const n of [...dirGraph.values()].flatMap((s) => [...s])) if (!dirGraph.has(n)) dirGraph.set(n, new Set());
const dirEdges = [...dirGraph.values()].reduce((n, s) => n + s.size, 0);
const comps = scc(dirGraph).filter((c) => c.length > 1).sort((x, y) => y.length - x.length);
add("commercial.dirNodes", dirGraph.size, "directory-graph nodes (§1.3, 51)");
add("commercial.dirEdges", dirEdges, "directory-graph value edges (§1.3, 275)");
add("commercial.nontrivialSCCs", comps.length, "non-trivial SCCs, size >= 2 (§1.3, 1)");
add("commercial.largestSCC", comps[0]?.length ?? 0, "members of the largest SCC (§1.3, 38)");
const inScc = new Set(comps.flat());
add("commercial.outsideSCC", [...dirGraph.keys()].filter((d) => !inScc.has(d)).sort().join(","), "nodes outside any SCC (§1.3, 13)");
const fileComps = scc(fileGraph).filter((c) => c.length > 1);
add("commercial.fileValueCycles", fileComps.length, "file-level non-trivial value-import SCCs (§1.3, 4)");
// Import statements per directory pair (value / all), the unit §1.3's table uses.
function pairRefs(a, bs) {
  let value = 0; let all = 0;
  for (const f of cfiles) {
    if (nodeOf(f) !== a) continue;
    for (const r of refs(f)) {
      const t = resolveRelative(R, f, r.spec);
      if (!t || !t.startsWith(CSRC) || !bs.includes(nodeOf(t))) continue;
      all++; if (r.kind === "value") value++;
    }
  }
  return `${value}/${all}`;
}
add("commercial.billing→http", pairRefs("billing", ["http"]), "import statements value/all (§1.3, 8)");
add("commercial.db→upper", pairRefs("db", ["http", "billing", "dispatch", "goal"]), "db → http|billing|dispatch|goal, value/all (§1.3, 10)");
add("commercial.→ws", ["auth", "billing", "dispatch"].map((a) => `${a}=${pairRefs(a, ["ws"])}`).join(" "), "auth/billing/dispatch → ws, value/all (§1.3, 4)");
add("commercial.http→admin", pairRefs("http", ["admin"]), "http → admin, value/all (§3.5, 128)");
const idx = `${CSRC}index.ts`;
const idxTargets = new Set([...(fileGraph.get(idx) ?? [])].map(nodeOf));
add("commercial.index.valueDeps", idxTargets.size, "dirs + _root that index.ts value-imports (§1.3, 42)");

// egress/main.ts: transitive value-import closure inside commercial/src
const seen = new Set();
const todo = [`${CSRC}egress/main.ts`];
while (todo.length) {
  const f = todo.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  for (const t of fileGraph.get(f) ?? []) todo.push(t);
}
seen.delete(`${CSRC}egress/main.ts`);
const byDir = new Map();
for (const f of seen) { const d = nodeOf(f); if (d === "egress") continue; byDir.set(d, (byDir.get(d) ?? 0) + 1); }
add("egress.closureFiles", [...byDir.values()].reduce((a, b) => a + b, 0), "commercial files outside egress/ in egress/main.ts's transitive value closure");
const directByDir = new Map();
for (const t of fileGraph.get(`${CSRC}egress/main.ts`) ?? []) { const d = nodeOf(t); if (d !== "egress") directByDir.set(d, (directByDir.get(d) ?? 0) + 1); }
add("egress.directFiles", [...directByDir.values()].reduce((a, b) => a + b, 0), "commercial files egress/main.ts value-imports directly (§1.1, 64)");
add("egress.directByDir", [...directByDir].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}=${n}`).join(" "), "same, per dir (§1.1/§1.3: http 33, account-pool 7, billing 6, auth 4)");

// ── §1.4 gateway ──
const GSRC = "packages/gateway/src/";
const gfiles = filesOf.get("gateway").filter((f) => f.startsWith(GSRC));
const server = `${GSRC}server.ts`;
let sv = 0; let st = 0; let svNoIndex = 0;
const gGraph = new Map();
for (const f of gfiles) {
  gGraph.set(f, new Set());
  let v = false; let t = false;
  for (const r of refs(f)) {
    const tgt = resolveRelative(R, f, r.spec);
    if (!tgt) continue;
    if (r.kind === "value") gGraph.get(f).add(tgt);
    if (tgt === server && f !== server) { if (r.kind === "value") v = true; else t = true; }
  }
  if (v) { sv++; if (f !== `${GSRC}index.ts`) svNoIndex++; } else if (t) st++;
}
add("gateway.serverImporters", sv + st, "files importing server.ts (§1.4, 31)");
add("gateway.serverValueImporters", sv, "of which value imports (§1.4, 20)");
add("gateway.serverValueImportersNoIndex", svNoIndex, "value importers without index.ts (§1.4, 19)");
add("gateway.serverTypeOnlyImporters", st, "type-only importers (§1.4, 11)");
const gComps = scc(gGraph).filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
add("gateway.largestValueCycle", gComps[0]?.length ?? 0, "files in the largest gateway value-import SCC (§1.4, 29)");
const engineRev = new Map();
for (const f of gfiles.filter((x) => x.startsWith(`${GSRC}engine/`))) {
  for (const r of refs(f)) {
    const tgt = resolveRelative(R, f, r.spec);
    if (!tgt || !tgt.startsWith(GSRC) || tgt.slice(GSRC.length).includes("/")) continue;
    const name = path.posix.basename(tgt).replace(/\.(ts|tsx)$/, "");
    engineRev.set(name, (engineRev.get(name) ?? 0) + 1);
  }
}
add("gateway.engine→root", ["logger", "remoteTarget", "subprocessRunner", "promptSlots"].map((n) => `${n}=${engineRev.get(n) ?? 0}`).join(" "),
  "engine/ import statements of root modules (§1.4: logger 13, remoteTarget 8, subprocessRunner 7, promptSlots 7)");
emit(args, "deps", rows);
