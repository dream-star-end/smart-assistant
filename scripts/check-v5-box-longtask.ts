#!/usr/bin/env tsx
/** Pinned-candidate gate for #21fdeea1. Runs the actual journal, launch fences,
 * Stop route and fetch regression paths with synthetic model results only.
 * The explicit private test DSN is checked before any product code is loaded. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestDatabase } from "./check-v5-box-success-recovery.js";
import { scaledMs } from "./lib/gateLoadScale.js";

const ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const TESTS = [
  "packages/commercial/src/http/proxy/boxToolRollover.integ.test.ts",
  "packages/commercial/src/http/proxy/boxToolRollover.test.ts",
  "packages/commercial/src/http/proxy/boxUserStopHandler.test.ts",
] as const;
const ANCHORS = [
  "260 paid-result boundaries span three bounded generations and finish idle",
  "resource boundaries apply to one generation and reserve a complete next message",
  "only a durable stopped generation reaches fresh launch; unknown and cancellation keep the claim",
  "an authenticated Stop durably cancels the rollover gap before looking for another run",
] as const;
const PRODUCT = ["boxToolRollover.ts","boxToolResumeClaim.ts","boxDurableJournal.ts",
  "boxToolFetch.ts","boxToolResumePublish.ts","boxUserStopHandler.ts","boxIdleChain.ts",
  "boxCliCompaction.ts","boxToolCapacity.ts"].map((name) => `packages/commercial/src/http/proxy/${name}`);
const PASS = "[biz-longtask-box-generations] PASS — 260 requests span 128/128/4 physical generations; proven stops preserve prior usage, gap cancellation and capacity fences hold, and final idle converges";
const MAX_OUTPUT = 8 * 1024 * 1024;
function fail(reason: string): never { throw new Error(`[box-longtask] ${reason}`); }
function candidateFile(path: string): string {
  const file = realpathSync(join(ROOT,path)), rel = relative(ROOT,file);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) fail("CANDIDATE_ESCAPE");
  return file;
}
function sha256(file: string): string { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function parseArgs(): string {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--expect-sha" || !/^[a-f0-9]{40}$/.test(args[1]!)) {
    fail("usage: check-v5-box-longtask.ts --expect-sha <40-hex>");
  }
  return args[1]!;
}
function number(tap: string, name: string): number {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} ([0-9]+)$`,"gm"))];
  if (matches.length !== 1) fail(`TAP_${name.toUpperCase()}_MISSING_OR_DUPLICATE`);
  return Number(matches[0]![1]);
}
export function assertLongTaskTap(tap: string): { tests: number; pass: number; skipped: number } {
  const plans = [...tap.matchAll(/^1\.\.([0-9]+)$/gm)];
  const points = [...tap.matchAll(/^(ok|not ok) ([0-9]+)(?: - [^\n]*)?$/gm)];
  const tests = number(tap,"tests"), pass = number(tap,"pass");
  if (plans.length !== 1 || Number(plans[0]![1]) !== points.length
    || points.length === 0 || points.some((p,i) => p[1] !== "ok" || Number(p[2]) !== i+1)
    || tests < 7 || pass !== tests) fail("TAP_EXECUTION_INCOMPLETE");
  for (const name of ["fail","cancelled","skipped","todo"]) if (number(tap,name) !== 0) fail(`TAP_${name.toUpperCase()}_NONZERO`);
  if (/^ok\b[^\n]*#\s*(?:SKIP|TODO)\b/im.test(tap)) fail("TAP_SKIP_DIRECTIVE");
  for (const anchor of ANCHORS) {
    if (!points.some((point) => point[0] === `ok ${point[2]} - ${anchor}`)) fail("TAP_REQUIRED_BEHAVIOR_NOT_EXECUTED");
  }
  return { tests,pass,skipped: 0 };
}

async function main(): Promise<void> {
  const expectSha = parseArgs();
  if (existsSync(join(ROOT,".git"))) {
    const head = execFileSync("git",["-C",ROOT,"rev-parse","HEAD"],{ encoding: "utf8",timeout: 5_000 }).trim();
    if (head !== expectSha) fail("PINNED_SHA_MISMATCH");
  }
  // No fallback to DATABASE_URL or a caller's ambient journal override.
  const database = parseTestDatabase(process.env.TEST_DATABASE_URL);
  const home = mkdtempSync(join(tmpdir(),"ocv5-longtask-gate-"));
  try {
  mkdirSync(join(home,"state")); mkdirSync(join(home,"tmp"));
  const env: NodeJS.ProcessEnv = { HOME: home,OPENCLAUDE_HOME: join(home,"state"),
    TMPDIR: join(home,"tmp"),TMP: join(home,"tmp"),TEMP: join(home,"tmp"),NO_COLOR: "1",
    TEST_DATABASE_URL: database.raw };
  for (const key of ["PATH","LANG","LC_ALL","TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  // In particular no NODE_OPTIONS/NODE_PATH, production PG/Redis/Box credentials,
  // OCV5_289_JOURNAL_TEST_DATABASE_URL or OC_V5_PROOF_TEST_DATABASE_URL survive.
  const files = TESTS.map(candidateFile);
  const hashes = [...TESTS,...PRODUCT,"scripts/check-v5-box-longtask.ts",
    "scripts/check-v5-box-success-recovery.ts","scripts/lib/gateLoadScale.ts"]
    .map((path) => ({ path,sha256: sha256(candidateFile(path)) }));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve,reject) => {
      const child = spawn(process.execPath,["--import","tsx","--test","--test-concurrency=1","--test-force-exit",...files],
        { cwd: ROOT,env,stdio: ["ignore","pipe","pipe"],detached: true });
      let stdout = "",stderr = "",bytes = 0,timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
        try { process.kill(-child.pid,"SIGTERM"); } catch { /* own child already exited */ }
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null && child.pid) {
            try { process.kill(-child.pid,"SIGKILL"); } catch { /* own child already exited */ }
          }
        },1_000);
      };
      const deadline = setTimeout(() => { timedOut = true; stop(); },scaledMs(120_000));
      const collect = (chunk: Buffer, target: "stdout"|"stderr") => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) { stop(); return; }
        if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data",(chunk: Buffer) => collect(chunk,"stdout"));
      child.stderr.on("data",(chunk: Buffer) => collect(chunk,"stderr"));
      child.on("error",(error) => { clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); reject(error); });
      child.on("close",(code,signal) => {
        clearTimeout(deadline); if (killTimer) clearTimeout(killTimer);
        if (timedOut || bytes > MAX_OUTPUT) reject(new Error(timedOut ? "LONGTASK_DEADLINE" : "LONGTASK_OUTPUT_BOUND"));
        else resolve({ code,signal,stdout,stderr });
      });
    });
    const redact = (value: string) => value.replaceAll(database.raw,"[test-dsn]")
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/g,"[test-dsn]");
    process.stdout.write(redact(result.stdout));
    if (result.stderr) process.stderr.write(redact(result.stderr));
    if (result.code !== 0 || result.signal !== null) fail("REGRESSION_PROCESS_FAILED");
    const summary = assertLongTaskTap(result.stdout);
    // Archives have no .git: identity is the caller-pinned SHA plus actual candidate hashes.
    process.stdout.write(`${PASS}\n${JSON.stringify({ ok: true,expectSha,candidate: ROOT,
      archived: !existsSync(join(ROOT,".git")),summary,hashes })}\n`);
  } finally { rmSync(home,{ recursive: true,force: true }); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`[gate-failure] ${message.split("\n")[0]}`);
    process.exitCode = 1;
  });
}
