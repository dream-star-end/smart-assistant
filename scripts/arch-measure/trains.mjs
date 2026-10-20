#!/usr/bin/env node
// OCV5-540: plan §1.9 / §8.1 train timings from <trainId>.summary.json (OCV5-539), read-only.
//   node scripts/arch-measure/trains.mjs [--dir /opt/openclaude/tmp/lease-trains] [--since 2026-10-21] [--json]
//   node scripts/arch-measure/trains.mjs --check-last 10    # P0a exit: the last N trains all have a complete summary
// Percentiles are per phase letter (A, B, C, D, P, E1–E4, F, G; X = compensation), summed over the
// letter's sub-phases inside one train, then taken across trains. They do not add up (§1.9).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib.mjs";

const args = parseArgs();
const dir = args.dir ?? process.env.OC_V5_LEASE_LOG_DIR ?? "/opt/openclaude/tmp/lease-trains";
const since = args.since ? Date.parse(args.since) : 0;
if (!existsSync(dir)) { console.error(`no such dir: ${dir}`); process.exit(2); }

const trainIdTime = (id) => {
  const m = /^tr-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(id);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};
const logs = readdirSync(dir).filter((f) => /^tr-.*\.log$/.test(f)).map((f) => f.replace(/\.log$/, ""));
const trains = logs.map((id) => {
  const f = path.join(dir, `${id}.summary.json`);
  let summary = null; let error = null;
  if (existsSync(f)) {
    try { summary = JSON.parse(readFileSync(f, "utf8")); } catch (e) { error = String(e.message ?? e); }
  }
  return { id, t: trainIdTime(id), summary, error };
}).filter((x) => x.t >= since).sort((a, b) => a.t - b.t);

const letter = (id) => (/^E\d/.test(id) ? id.slice(0, 2) : id.split(".")[0]);
function complete(s) {
  if (!s || s.schema !== "oc.v5.selfhost.train-summary/1" || s.final !== true) return "not final";
  if (!Array.isArray(s.phases) || !s.phases.length) return "no phases";
  if (s.phases.some((p) => p.durationMs == null)) return "open phase";
  if (s.result === "success") {
    const have = new Set(s.phases.map((p) => letter(p.id)));
    const missing = ["A", "B", "C", "D", "P", "E1", "E2", "E3", "E4", "F", "G"].filter((l) => !have.has(l));
    if (missing.length) return `missing ${missing.join(",")}`;
    if (s.phases.filter((p) => p.id.startsWith("C.")).length < 10) return "fewer than 10 C gates";
  }
  return "ok";
}

if (args["check-last"]) {
  const n = Number(args["check-last"]);
  const last = trains.slice(-n);
  let bad = 0;
  for (const t of last) {
    const v = t.error ? `unreadable: ${t.error}` : complete(t.summary);
    if (v !== "ok") bad++;
    console.log(`${t.id}  ${t.summary?.result ?? "-"}  ${v}`);
  }
  console.log(last.length < n ? `only ${last.length} trains since the cutoff` : bad ? `${bad} of ${n} incomplete` : `all ${n} complete`);
  process.exit(last.length === n && !bad ? 0 : 1);
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const withSummary = trains.filter((t) => t.summary?.final);
const ok = withSummary.filter((t) => t.summary.result === "success");
const failed = withSummary.filter((t) => t.summary.result !== "success");
const perLetter = new Map();
const perGate = new Map();
for (const t of ok) {
  const sums = new Map();
  for (const p of t.summary.phases) {
    sums.set(letter(p.id), (sums.get(letter(p.id)) ?? 0) + (p.durationMs ?? 0));
    if (p.id.startsWith("C.")) { if (!perGate.has(p.id)) perGate.set(p.id, []); perGate.get(p.id).push(p.durationMs); }
  }
  for (const [l, v] of sums) { if (!perLetter.has(l)) perLetter.set(l, []); perLetter.get(l).push(v); }
}
const s = (ms) => (ms == null ? "-" : (ms / 1000).toFixed(0));
const out = {
  dir, trains: trains.length, withFinalSummary: withSummary.length, success: ok.length, failed: failed.length,
  noSummary: trains.filter((t) => !t.summary).map((t) => t.id),
  totalSec: { p50: s(pct(ok.map((t) => t.summary.durationMs), 50)), p90: s(pct(ok.map((t) => t.summary.durationMs), 90)) },
  phasesSec: Object.fromEntries([...perLetter].map(([l, v]) => [l, { n: v.length, p50: s(pct(v, 50)), p90: s(pct(v, 90)) }])),
  gatesSec: Object.fromEntries([...perGate].map(([g, v]) => [g, { p50: s(pct(v, 50)), p90: s(pct(v, 90)) }])),
  frontendReused: ok.filter((t) => t.summary.cache?.frontend === "reused").length,
  nodeModulesHardlink: ok.filter((t) => t.summary.cache?.nodeModules === "hardlink").length,
  failedPhases: failed.reduce((m, t) => { const k = t.summary.failedPhase ?? "?"; m[k] = (m[k] ?? 0) + 1; return m; }, {}),
  failedMinutes: Math.round(failed.reduce((n, t) => n + (t.summary.durationMs ?? 0), 0) / 60000),
};
if (args.json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`# trains in ${dir}${since ? ` since ${args.since}` : ""}: ${out.trains} (final summary ${out.withFinalSummary}; success ${out.success}, failed ${out.failed})`);
  console.log(`total p50/p90 s: ${out.totalSec.p50}/${out.totalSec.p90}; frontend reused ${out.frontendReused}/${out.success}; node_modules hardlink ${out.nodeModulesHardlink}/${out.success}`);
  for (const [l, v] of Object.entries(out.phasesSec)) console.log(`  ${l.padEnd(3)} n=${v.n} p50=${v.p50} p90=${v.p90}`);
  for (const [g, v] of Object.entries(out.gatesSec)) console.log(`    ${g.padEnd(28)} p50=${v.p50} p90=${v.p90}`);
  console.log(`failed by phase: ${JSON.stringify(out.failedPhases)}, ${out.failedMinutes} min`);
  if (out.noSummary.length) console.log(`no summary (older than OCV5-539 or lost): ${out.noSummary.length}`);
}
