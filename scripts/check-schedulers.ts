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

// A file's exports that ARE referenced from elsewhere (comment-stripped).
function referencedElsewhere(name: string, file: string): boolean {
  const re = new RegExp(`\\b${name}\\b`);
  for (const [otherFile, otherSrc] of sourcesCode) {
    if (otherFile === file) continue;
    if (re.test(otherSrc)) return true;
  }
  return false;
}

const unwired: LifecycleExport[] = [];
for (const exp of exports) {
  // Require a reference in a non-test file other than the exporting file itself.
  // Use comment-stripped source so commented-out imports don't mask a missing wire.
  if (referencedElsewhere(exp.name, exp.file)) continue;
  // Singleton-factory pattern:class 与其 get*/start* 工厂同文件(如 ImagePromoteScheduler
  // + getImagePromoteScheduler)。类名只被工厂内部 new,外部只经工厂消费 —— 只要该工厂
  // 自己被外部引用,类就算已接线。仍能抓住 HealthPoller 原始事故形态(工厂也无人调用)。
  if (exp.kind === "class") {
    const ownSrc = sourcesCode.get(exp.file) ?? "";
    const usedInOwnFactory =
      new RegExp(`\\bnew\\s+${exp.name}\\b`).test(ownSrc) &&
      exports.some(
        (other) =>
          other.file === exp.file &&
          other.kind === "function" &&
          referencedElsewhere(other.name, other.file),
      );
    if (usedInOwnFactory) continue;
  }
  unwired.push(exp);
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

// ── Rule 2: mutator 归属登记强制(index.ts)──────────────────────────────────
// index.ts 的 enabledSchedulers / v5 fail-closed 不变量由 schedulerRegistry 派生;
// 该登记表靠创建点包 trackScheduler(...) 填充。若某个 scheduler 工厂调用没包
// trackScheduler,它就成了不变量断言的盲区(前科:subscriptionRollover / imagePromote
// 漏登记 → v5 下 gate 被误改也不会拒启)。本规则物理消灭"创建了但忘登记"。
// 判定按行:工厂调用行(startXxxScheduler( / getHealthPoller() / makeWechatBroker( 等
// lifecycle 命名)必须同行含 trackScheduler(。import 行不算调用。
{
  const INDEX = "index.ts";
  const idxSrc = sourcesCode.get(INDEX);
  if (!idxSrc) {
    console.error("✗ check-schedulers rule 2: packages/commercial/src/index.ts not found");
    process.exit(1);
  }
  // lifecycle 工厂调用形态:start*/get*/make* + Scheduler|Poller|Worker|Sweeper|Monitor|
  // Expirer|Actor|Reaper|Broker 后缀,后随 "("。
  const FACTORY_CALL_RE =
    /\b((?:start|get|make)\w*(?:Scheduler|Poller|Worker|Sweeper|Monitor|Expirer|Actor|Reaper|Broker))\s*\(/;
  const untracked: string[] = [];
  const lines = idxSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FACTORY_CALL_RE.exec(line);
    if (!m) continue;
    // import 行不是调用(逐名导入 / from 子句)。
    if (/^\s*(import\b|\}?\s*from\b)/.test(line) || /\bfrom\s+["']/.test(line)) continue;
    // shutdown 路径(getXxx().stop())不是创建,豁免。
    if (line.includes(".stop()")) continue;
    if (line.includes("trackScheduler(")) continue;
    untracked.push(`  index.ts:${i + 1}  ${m[1]}(...)  未包 trackScheduler(name, domain, ...)`);
  }
  if (untracked.length > 0) {
    console.error(`✗ ${untracked.length} scheduler factory call(s) in index.ts missing trackScheduler registration:`);
    console.error("");
    for (const u of untracked) console.error(u);
    console.error("");
    console.error("每个后台 mutator 创建必须登记归属域(shared|v5-owned|local),否则");
    console.error("enabledSchedulers 派生与 v5 fail-closed 不变量出现盲区。");
    console.error("注:本规则按行判定,要求工厂调用与 trackScheduler( 写在同一行。");
    process.exit(1);
  }
  console.log("✓ index.ts scheduler factory calls all registered via trackScheduler.");
}
