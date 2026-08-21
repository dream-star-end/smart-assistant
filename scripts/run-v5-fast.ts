#!/usr/bin/env tsx
/**
 * run-v5-fast.ts — `npm run check:v5:fast` 的调度器。
 *
 * 流程:
 *   1. 收集变更文件(默认 `origin/feat/v5-aurora-rewrite...HEAD` ∪ 工作区);
 *   2. 交给 select-gates.ts 裁门;
 *   3. 按 cheap → medium → expensive → very-expensive 分波;
 *   4. 同波内:无锁门并行,带 `commercial` 锁的门彼此串行(不与无锁门互斥)。
 *
 * 失败尽早:前一波红了就不启动后一波。同波内任一门红则杀掉仍在跑的无锁兄弟,
 * 但会等已经拿到 commercial 锁的那一门收尾(避免 flock 持有者被中途 SIGKILL
 * 后留下难诊断的半截 TAP)。
 *
 * 本脚本**不得**被加进 `check:v5` 链或 `.github/workflows/v5-ci.yml`,
 * 否则 check:ci-parity 会要求 CI 也改成快车道 —— 那是削弱 CI。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALL_GATE_IDS,
  type GateId,
  type GateMeta,
  type GateSelection,
  groupByPhase,
  selectGates,
} from "./select-gates.ts";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DEFAULT_BASE = "origin/feat/v5-aurora-rewrite";

export interface FastCliOptions {
  dryRun: boolean;
  files?: string[];
  base: string;
  cwd: string;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): FastCliOptions {
  const opts: FastCliOptions = {
    dryRun: env.CHECK_V5_FAST_DRY_RUN === "1",
    base: env.CHECK_V5_FAST_BASE || DEFAULT_BASE,
    cwd: REPO_ROOT,
  };
  if (env.CHECK_V5_FAST_FILES) {
    opts.files = env.CHECK_V5_FAST_FILES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run" || a === "--list") opts.dryRun = true;
    else if (a === "--base") opts.base = argv[++i] || opts.base;
    else if (a === "--files") {
      const raw = argv[++i] || "";
      opts.files = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--cwd") opts.cwd = argv[++i] || opts.cwd;
    else if (a === "--help" || a === "-h") {
      opts.dryRun = true;
      (opts as FastCliOptions & { help?: boolean }).help = true;
    }
  }
  return opts;
}

function git(cwd: string, args: string[]): string[] {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) return [];
  return (r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function collectChangedFiles(cwd: string, base: string): { files: string[]; source: string } {
  const committed = git(cwd, ["diff", "--name-only", `${base}...HEAD`]);
  const unstaged = git(cwd, ["diff", "--name-only"]);
  const staged = git(cwd, ["diff", "--name-only", "--cached"]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set([...committed, ...unstaged, ...staged, ...untracked])].sort();
  return {
    files,
    source: `${base}...HEAD ∪ working tree (unstaged/staged/untracked)`,
  };
}

function uniqueReasons(triggers: GateSelection["triggers"], id: GateId): string[] {
  const rows = triggers[id] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of rows) {
    const key = `${t.file} :: ${t.ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function formatSelection(sel: GateSelection, source: string): string {
  const lines: string[] = [];
  lines.push(`[check:v5:fast] change source: ${source}`);
  lines.push(`[check:v5:fast] changed files (${sel.files.length}):`);
  if (sel.files.length === 0) lines.push("  (none)");
  else for (const f of sel.files) lines.push(`  - ${f}`);
  lines.push(`[check:v5:fast] selected gates (${sel.selected.length}/${ALL_GATE_IDS.length}):`);
  if (sel.selected.length === 0) {
    lines.push("  (none — docs/文案类改动,本地快车道不跑质量门)");
  } else {
    for (const id of sel.selected) {
      const why = uniqueReasons(sel.triggers, id);
      lines.push(`  + ${id}`);
      for (const w of why.slice(0, 8)) lines.push(`      triggered by ${w}`);
      if (why.length > 8) lines.push(`      … ${why.length - 8} more`);
    }
  }
  if (sel.selected.includes("typecheck")) {
    const tc = sel.typecheck;
    if (tc.fullComposite && tc.webReact) {
      lines.push("  typecheck plan: full `npm run typecheck` (all composite + web-react)");
    } else {
      lines.push(
        `  typecheck plan: tsc --build ${tc.projects.join(" ") || "(none)"}` +
          `${tc.webReact ? " && web-react tsc -b" : ""}`,
      );
    }
  }
  lines.push(`[check:v5:fast] skipped gates (${sel.skipped.length}):`);
  for (const id of sel.skipped) lines.push(`  - ${id}`);
  return lines.join("\n");
}

function prefixLines(chunk: Buffer | string, prefix: string): string {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!text) return "";
  const endsWithNl = text.endsWith("\n");
  const parts = text.split("\n");
  if (endsWithNl) parts.pop();
  return parts.map((l) => `${prefix}${l}`).join("\n") + (endsWithNl ? "\n" : "");
}

interface RunningProc {
  label: string;
  child: ChildProcess;
  done: Promise<number>;
}

function spawnLogged(label: string, command: string, args: string[], cwd: string): RunningProc {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${label}] `;
  child.stdout?.on("data", (b: Buffer) => {
    process.stdout.write(prefixLines(b, prefix));
  });
  child.stderr?.on("data", (b: Buffer) => {
    process.stderr.write(prefixLines(b, prefix));
  });
  const done = new Promise<number>((resolve) => {
    child.on("close", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
    child.on("error", () => resolve(1));
  });
  return { label, child, done };
}

function killProc(p: RunningProc): void {
  if (p.child.killed || p.child.exitCode !== null) return;
  try {
    p.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function typecheckCommands(sel: GateSelection, cwd: string): { label: string; command: string; args: string[] }[] {
  const tc = sel.typecheck;
  if (tc.fullComposite && tc.webReact) {
    return [{ label: "typecheck", command: "npm", args: ["run", "typecheck"] }];
  }
  const out: { label: string; command: string; args: string[] }[] = [];
  if (tc.projects.length > 0) {
    const tsc = existsSync(join(cwd, "node_modules/typescript/bin/tsc"))
      ? join(cwd, "node_modules/typescript/bin/tsc")
      : "npx";
    const args = tsc.endsWith("tsc")
      ? ["--build", ...tc.projects]
      : ["tsc", "--build", ...tc.projects];
    out.push({ label: "typecheck:scoped", command: tsc, args });
  }
  if (tc.webReact) {
    out.push({
      label: "typecheck:web-react",
      command: "npm",
      args: ["run", "typecheck", "--workspace", "packages/web-react"],
    });
  }
  return out;
}

function gateCommand(gate: GateMeta): { command: string; args: string[] } {
  const args = ["run", gate.npmScript];
  if (gate.npmArgs?.length) args.push("--", ...gate.npmArgs);
  return { command: "npm", args };
}

async function runPhase(
  phaseLabel: string,
  items: { label: string; command: string; args: string[]; lock: GateMeta["lock"] }[],
  cwd: string,
): Promise<{ failed: string | null; elapsedMs: number }> {
  const started = Date.now();
  if (items.length === 0) return { failed: null, elapsedMs: 0 };

  const unlocked = items.filter((i) => !i.lock);
  const locked = items.filter((i) => i.lock);

  let failed: string | null = null;
  const running: RunningProc[] = [];

  const startOne = (item: (typeof items)[number]): RunningProc => {
    console.log(`[check:v5:fast] ▶ ${phaseLabel} start ${item.label}: ${item.command} ${item.args.join(" ")}`);
    const proc = spawnLogged(item.label, item.command, item.args, cwd);
    running.push(proc);
    return proc;
  };

  const unlockedPromise = (async () => {
    const procs = unlocked.map(startOne);
    for (const p of procs) {
      const code = await p.done;
      if (code !== 0 && !failed) {
        failed = p.label;
        for (const sib of running) {
          if (sib.label === p.label) continue;
          // 不杀 commercial 锁持有者,让它自己收尾
          const item = items.find((i) => i.label === sib.label);
          if (item?.lock) continue;
          killProc(sib);
        }
      }
    }
  })();

  const lockedPromise = (async () => {
    for (const item of locked) {
      if (failed) break;
      const p = startOne(item);
      const code = await p.done;
      if (code !== 0 && !failed) failed = p.label;
    }
  })();

  await Promise.all([unlockedPromise, lockedPromise]);
  return { failed, elapsedMs: Date.now() - started };
}

export async function runFast(opts: FastCliOptions): Promise<number> {
  const t0 = Date.now();
  let files: string[];
  let source: string;
  if (opts.files) {
    files = opts.files;
    source = `--files (${files.length} paths)`;
  } else {
    const collected = collectChangedFiles(opts.cwd, opts.base);
    files = collected.files;
    source = collected.source;
  }

  const sel = selectGates(files);
  console.log(formatSelection(sel, source));

  if (sel.selected.length === 0) {
    const ms = Date.now() - t0;
    console.log(`[check:v5:fast] nothing to run. total ${ms}ms`);
    return 0;
  }

  if (opts.dryRun) {
    const phases = groupByPhase(sel.selected);
    console.log("[check:v5:fast] dry-run schedule:");
    for (const phase of phases) {
      const locked = phase.gates.filter((g) => g.lock).map((g) => g.id);
      const unlocked = phase.gates.filter((g) => !g.lock).map((g) => g.id);
      console.log(
        `  phase ${phase.cost}: parallel [${unlocked.join(", ") || "—"}]` +
          (locked.length ? ` ; serial-lock [${locked.join(" → ")}]` : ""),
      );
    }
    console.log(`[check:v5:fast] dry-run total ${Date.now() - t0}ms`);
    return 0;
  }

  const phases = groupByPhase(sel.selected);
  for (const phase of phases) {
    const items: { label: string; command: string; args: string[]; lock: GateMeta["lock"] }[] = [];
    for (const gate of phase.gates) {
      if (gate.id === "typecheck") {
        for (const cmd of typecheckCommands(sel, opts.cwd)) {
          items.push({ ...cmd, lock: null });
        }
        continue;
      }
      const { command, args } = gateCommand(gate);
      items.push({ label: gate.id, command, args, lock: gate.lock });
    }
    const result = await runPhase(phase.cost, items, opts.cwd);
    console.log(
      `[check:v5:fast] phase ${phase.cost} ${result.failed ? "FAIL " + result.failed : "ok"} (${result.elapsedMs}ms)`,
    );
    if (result.failed) {
      console.error(
        `[check:v5:fast] stopped after phase ${phase.cost}: ${result.failed} failed. ` +
          `later phases not started. total ${Date.now() - t0}ms`,
      );
      return 1;
    }
  }

  console.log(`[check:v5:fast] all ${sel.selected.length} selected gates passed. total ${Date.now() - t0}ms`);
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? fileURLToPath(pathToFileURL(resolve(process.argv[1]))) : "";
if (invoked === thisFile) {
  runFast(parseArgs(process.argv.slice(2))).then((code) => process.exit(code));
}
