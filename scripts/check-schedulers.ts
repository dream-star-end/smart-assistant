#!/usr/bin/env tsx
// check-schedulers.ts — Catch lifecycle classes / factories that are exported
// but never wired into the service boot path.
//
// Background: 5029a69 added compute-pool/nodeHealth.ts (HealthPoller class +
// getHealthPoller singleton) but no caller ever invoked .start(). Result:
// last_health_at stayed NULL forever, auto quarantine/recovery state machine
// never ran, and mTLS cert auto-renewal silently broke. tsc + lint + tests
// were all green. This linter exists so the next "code added but not wired"
// dead drop trips on `npm run check` instead of in production.
//
// Heuristic: scan packages/commercial/src for exports matching the lifecycle
// naming convention (start*Scheduler / get*Poller / class XxxWorker etc.).
// For each, require at least one reference from another non-test file. A
// type-only import counts as a reference — that's intentional, see plan.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../packages/commercial/src/", import.meta.url).pathname;

// Catch factory functions:  startXxxScheduler / getHealthPoller etc.
const FN_RE = /^export\s+(?:async\s+)?function\s+((?:start|get)\w*(?:Scheduler|Poller|Worker|Sweeper|Monitor))\b/gm;
// Catch class declarations:  HealthPoller / AccountScheduler / V3ContainerEventsWorker etc.
const CLASS_RE = /^export\s+class\s+(\w+(?:Scheduler|Poller|Worker|Sweeper|Monitor))\b/gm;

interface LifecycleExport {
  file: string; // path relative to commercial/src
  name: string;
  kind: "function" | "class";
}

function isTestPath(p: string): boolean {
  return p.includes("/__tests__/") || p.endsWith(".test.ts") || p.endsWith(".integ.test.ts");
}

function listTsFiles(): string[] {
  // Node 20.1+ supports recursive: true on readdirSync.
  const all = readdirSync(ROOT, { recursive: true, encoding: "utf8" }) as string[];
  return all.filter((p) => p.endsWith(".ts") && !isTestPath(p));
}

// Strip JS-style comments so commented-out imports don't count as references.
// Naive — doesn't handle comment-like substrings inside string literals, but
// for symbol-name detection that edge case is harmless (no real reference is
// hidden inside a string that only appears in a comment).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const sourcesRaw = new Map<string, string>();   // for export detection (regex anchored at line start, comments preserved is fine)
const sourcesCode = new Map<string, string>();  // for reference detection (stripped)
for (const rel of listTsFiles()) {
  const raw = readFileSync(join(ROOT, rel), "utf8");
  sourcesRaw.set(rel, raw);
  sourcesCode.set(rel, stripComments(raw));
}
const sources = sourcesRaw;

const exports: LifecycleExport[] = [];
for (const [file, src] of sources) {
  for (const m of src.matchAll(FN_RE)) exports.push({ file, name: m[1], kind: "function" });
  for (const m of src.matchAll(CLASS_RE)) exports.push({ file, name: m[1], kind: "class" });
}

const unwired: LifecycleExport[] = [];
for (const exp of exports) {
  // Require a reference in a non-test file other than the exporting file itself.
  // Use comment-stripped source so commented-out imports don't mask a missing wire.
  const re = new RegExp(`\\b${exp.name}\\b`);
  let referenced = false;
  for (const [otherFile, otherSrc] of sourcesCode) {
    if (otherFile === exp.file) continue;
    if (re.test(otherSrc)) {
      referenced = true;
      break;
    }
  }
  if (!referenced) unwired.push(exp);
}

if (unwired.length > 0) {
  console.error(`✗ ${unwired.length} unwired lifecycle export(s) detected in packages/commercial/src/:`);
  console.error("");
  for (const exp of unwired) {
    console.error(`  - ${exp.kind} ${exp.name}  (${exp.file})`);
  }
  console.error("");
  console.error("This usually means a Scheduler/Poller/Worker class was added");
  console.error("but never wired into service boot (cf. HealthPoller in v1.0.10).");
  console.error("Either:");
  console.error("  1. Add a call site (typically packages/commercial/src/index.ts");
  console.error("     or a sibling start*-style aggregator).");
  console.error("  2. Delete the export if it is genuinely dead code.");
  process.exit(1);
}

console.log(`✓ ${exports.length} lifecycle export(s) all referenced from non-test code.`);
