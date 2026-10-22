#!/usr/bin/env tsx
/**
 * OCV5-582 (release reliability P0-2): one gate manifest for the selfhost release train and CI.
 *
 * check-ci-parity.ts keeps `check:v5` and v5-ci.yml equal, but neither is what a selfhost train
 * runs: build_master_release runs its own pinned-staging gates (Box proofs, callback WS proof,
 * production web build with the first-screen budget, ...). Most of them never ran in selfhost CI,
 * so a deterministic defect surfaced only 5–25 minutes into a train. This check makes the three
 * sets one:
 *
 *   train   = every command line of build_master_release() that runs a repo script or the
 *             production web build (lexical, same rules as check-v5-incident-regressions.ts),
 *             plus manifest gates the deploy script itself runs (`stage: "deploy"`);
 *   manifest = deploy/v5/selfhost-release-gates.json;
 *   CI      = what the `run:` steps of .github/workflows/v5-selfhost-*.yml execute: same lexical
 *             command-position rule (an echo, a quoted string or a comment naming a gate is not a
 *             run), with `npm run <script>` followed through package.json.
 *
 * Problems (exit 1): a train gate missing from the manifest, a manifest gate the train no longer
 * runs, a manifest gate whose `ci` workflow does not run it, a gate with neither `ci` nor a
 * written `ciExempt` reason. Exit 2: the manifest or a workflow cannot be read.
 *
 * Usage: npx tsx scripts/check-release-gate-parity.ts [--root <repo>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface Gate {
  id: string;
  /** a repo script the train runs, or `command` for a non-script step */
  script?: string;
  command?: string;
  /** build (default) = build_master_release; deploy = deploy-v5-selfhost.sh itself */
  stage?: "build" | "deploy";
  /** deploy stage only: the call chain that really runs the script (Codex final r1: a file-name
   * mention is not a run). `caller` must call `function` at command position, `function` must run
   * "$<variable>" at command position, and `variable` must be assigned the script's path. */
  deploy?: { caller: string; function: string; variable: string };
  /** workflow file (under .github/workflows) that runs the same script/command */
  ci?: string;
  /** why CI cannot run it; required when `ci` is absent */
  ciExempt?: string;
}
export interface Manifest {
  schema: string;
  gates: Gate[];
  /** scripts build_master_release runs that are infrastructure, not gates (e.g. gate DB tool) */
  helpers: string[];
}
export interface Problem { kind: string; message: string }

/** What may precede a run at command position: sudo, env (-u NAME, NAME=value, emptied quotes) and
 * NAME=value assignments. Text after `echo`, inside quotes or in a comment is never a run. */
const QUOTED = String.raw`(?:''|"[^"\n]*")`;
const PREFIX = String.raw`(?:^|[;&|(])\s*(?:sudo\s+)?(?:(?:env(?:\s+(?:-u\s+\S+|${QUOTED}|[A-Za-z_][A-Za-z0-9_]*=\S*))*|[A-Za-z_][A-Za-z0-9_]*=\S*|${QUOTED})\s+)*`;
const SCRIPT_RUN = new RegExp(
  `${PREFIX}(?:npx(?:\\s+--no-install)?\\s+tsx|tsx|node|bash)\\s+((?:packages\\/[\\w.-]+\\/)?scripts\\/[\\w./-]+)`, "g");
const NPM_RUN = new RegExp(`${PREFIX}npm run (\\S+)((?:\\s+--workspace\\s+\\S+)?)`, "g");

/** Drop heredoc bodies (the opening line stays): what a heredoc feeds is data, not a command. */
function dropHeredocBodies(lines: string[]): string[] {
  const out: string[] = [];
  let heredoc: { tag: string; dash: boolean } | null = null;
  for (const raw of lines) {
    if (heredoc) {
      if ((heredoc.dash ? raw.replace(/^\t+/, "") : raw) === heredoc.tag) heredoc = null;
      continue;
    }
    // any bash word is a delimiter (END-OF-TEXT, 42, 'a b'); `<<<` is a here-string, not a heredoc
    const doc = /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([^\s;&|<>()'"]+))/.exec(raw);
    if (doc) heredoc = { tag: (doc[2] ?? doc[3] ?? doc[4])!, dash: doc[1] === "-" };
    out.push(raw);
  }
  return out;
}

/** Shell text → executable text. Single-quoted strings are literals and become ''. A
 * double-quoted string keeps only what bash executes or expands inside it — `$( … )` / backtick
 * substitutions (scanned recursively) and `$NAME` / `${NAME}` — so `"run; node scripts/x"` is no
 * command while `"$("$GATE" …)"` still is (Codex final r2: a single-quoted `$( … )` was counted).
 * Escaped characters are literals; a continuation survives; `#` starts a comment only at a word
 * start. Unbalanced input fails closed: the rest reads as one literal, so nothing after it runs. */
export function stripShell(text: string): string {
  return scanCode(text, 0, false)[0];
}

function scanCode(text: string, from: number, inSub: boolean): [string, number] {
  let out = "";
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { out += text[i + 1] === "\n" ? "\\\n" : "_"; i += 2; continue; }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      out += "''"; i = j < 0 ? text.length : j + 1; continue;
    }
    if (c === '"') {
      const [kept, j] = scanDouble(text, i + 1);
      out += `"${kept}"`; i = j; continue;
    }
    if (c === "`") {
      const j = backtickEnd(text, i + 1);
      out += `$(${stripShell(text.slice(i + 1, j))})`; i = j + 1; continue;
    }
    if (c === "#" && (i === from || /[\s;&|(]/.test(text[i - 1]!))) {
      const j = text.indexOf("\n", i);
      i = j < 0 ? text.length : j; continue;
    }
    if (inSub && c === "(") depth++;
    if (inSub && c === ")") {
      if (depth === 0) return [out, i + 1];
      depth--;
    }
    out += c; i++;
  }
  return [out, i];
}

/** Index of the backtick closing a substitution opened before `from`; `\`` inside is escaped
 * (Codex final r3). Unclosed → end of text (fails closed: the rest is one substitution). */
function backtickEnd(text: string, from: number): number {
  let j = from;
  while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
  return Math.min(j, text.length);
}

function scanDouble(text: string, from: number): [string, number] {
  let out = "";
  let i = from;
  while (i < text.length && text[i] !== '"') {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const [inner, j] = scanCode(text, i + 2, true);
      out += `$(${inner})`; i = j; continue;
    }
    if (c === "`") {
      const j = backtickEnd(text, i + 1);
      out += `$(${stripShell(text.slice(i + 1, j))})`; i = j + 1; continue;
    }
    const v = c === "$" ? /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i)) : null;
    if (v) { out += v[0]; i += v[0].length; continue; }
    i++;
  }
  return [out, i + 1];
}

/** Shell text → command lines: heredoc bodies dropped, quoted text and comments dropped (quote
 * state carried across lines), then continuations joined. */
export function shellCommands(text: string): string[] {
  return stripShell(dropHeredocBodies(text.split("\n")).join("\n")).replace(/\\\n/g, " ").split("\n");
}

/** Command lines of a shell function body, by the same rules as shellCommands, so a message or
 * a file-presence test naming a gate is not a run. */
export function functionCommands(src: string, name: string): string[] {
  const lines = src.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{\\s*$`).test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^\}/.test(line));
  return shellCommands(lines.slice(start + 1, end < 0 ? undefined : end).join("\n"));
}

/** Scripts and npm-run commands the given command lines execute. */
export function runsIn(commands: string[]): { scripts: Set<string>; npm: Set<string> } {
  const scripts = new Set<string>();
  const npm = new Set<string>();
  for (const line of commands) {
    for (const m of line.matchAll(SCRIPT_RUN)) scripts.add(m[1]!);
    for (const m of line.matchAll(NPM_RUN)) npm.add(`npm run ${m[1]}${m[2]!.replace(/\s+/g, " ")}`);
  }
  return { scripts, npm };
}

/** The `run:` steps of a workflow, joined (YAML comments, names and `if:` text excluded). */
export function workflowRuns(yml: string): string {
  const doc = parseYaml(yml) as { jobs?: Record<string, { steps?: { run?: unknown }[] }> } | null;
  const runs: string[] = [];
  for (const job of Object.values(doc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) if (typeof step?.run === "string") runs.push(step.run);
  }
  return runs.join("\n");
}

/** What each workflow's `run:` steps execute, `npm run x` followed through package.json
 * (cycle-safe) with the same command-position rule. */
export function ciRuns(workflows: Record<string, string>, pkgScripts: Record<string, string>):
  Record<string, { scripts: Set<string>; npm: Set<string> }> {
  const out: Record<string, { scripts: Set<string>; npm: Set<string> }> = {};
  for (const [file, yml] of Object.entries(workflows)) {
    const scripts = new Set<string>();
    const npm = new Set<string>();
    const visit = (text: string, seen: Set<string>): void => {
      const r = runsIn(shellCommands(text));
      for (const x of r.scripts) scripts.add(x);
      for (const x of r.npm) {
        npm.add(x);
        const name = x.split(" ")[2]!;
        const body = pkgScripts[name];
        if (body !== undefined && !x.includes("--workspace") && !seen.has(name)) visit(body, new Set([...seen, name]));
      }
    };
    visit(workflowRuns(yml), new Set());
    out[file] = { scripts, npm };
  }
  return out;
}

/** A deploy-stage gate really runs: caller → function at command position → "$variable" at
 * command position inside the function → variable assigned the script path at top level. */
export function deployRuns(deployScript: string, gate: Gate): boolean {
  const d = gate.deploy;
  if (!d || !gate.script) return false;
  const word = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "");
  const at = (name: string) => new RegExp(`${PREFIX}(?:if\\s+)?(?:!\\s*)?${word(name)}(?:\\s|$)`);
  if (!functionCommands(deployScript, d.caller).some((line) => at(d.function).test(line))) return false;
  // the runner is a quoted expansion ("$VAR" …): the scanner keeps it only where bash executes it
  const body = functionCommands(deployScript, d.function);
  const v = word(d.variable);
  const runs = new RegExp(`(?:^|[;&|(]|\\$\\()\\s*"?\\$(?:\\{${v}\\}|${v})"?(?:\\s|\\)|$)`);
  if (!body.some((line) => runs.test(line))) return false;
  const assign = new RegExp(`^${v}="\\$SCRIPT_DIR/${gate.script.replace(/^scripts\//, "").replace(/[.]/g, "\\.")}"\\s*$`, "m");
  return assign.test(deployScript);
}

export function check(input: {
  manifest: Manifest;
  masterLib: string;
  deployScript: string;
  workflows: Record<string, string>;
  pkgScripts: Record<string, string>;
}): Problem[] {
  const { manifest, masterLib, deployScript, workflows, pkgScripts } = input;
  const problems: Problem[] = [];
  const train = runsIn(functionCommands(masterLib, "build_master_release"));
  const helpers = new Set(manifest.helpers);
  const byKey = new Map<string, Gate>();
  for (const gate of manifest.gates) {
    const key = gate.script ?? gate.command;
    if (!key) { problems.push({ kind: "manifest", message: `${gate.id}: needs script or command` }); continue; }
    if (byKey.has(key)) problems.push({ kind: "manifest", message: `${gate.id}: duplicate ${key}` });
    byKey.set(key, gate);
  }
  // train → manifest
  for (const s of train.scripts) {
    if (!helpers.has(s) && !byKey.has(s)) {
      problems.push({ kind: "train-not-in-manifest", message: `build_master_release runs ${s}, which is not in the gate manifest` });
    }
  }
  for (const c of train.npm) {
    if (!byKey.has(c)) problems.push({ kind: "train-not-in-manifest", message: `build_master_release runs \`${c}\`, which is not in the gate manifest` });
  }
  // manifest → train, manifest → CI
  const ci = ciRuns(workflows, pkgScripts);
  for (const gate of manifest.gates) {
    const key = gate.script ?? gate.command;
    if (!key) continue;
    const stage = gate.stage ?? "build";
    const inTrain = stage === "build"
      ? (gate.script ? train.scripts.has(key) : train.npm.has(key))
      : deployRuns(deployScript, gate);
    if (!inTrain) {
      problems.push({ kind: "manifest-not-in-train", message: `${gate.id}: the ${stage} stage no longer runs ${key}` });
    }
    if (gate.ci) {
      const runs = ci[gate.ci];
      if (runs === undefined) {
        problems.push({ kind: "ci-missing", message: `${gate.id}: workflow ${gate.ci} does not exist` });
      } else if (!(gate.script ? runs.scripts.has(key) : runs.npm.has(key))) {
        problems.push({ kind: "ci-missing", message: `${gate.id}: ${gate.ci} does not run ${key}` });
      }
    } else if (!gate.ciExempt || gate.ciExempt.trim().length < 20) {
      problems.push({ kind: "ci-missing", message: `${gate.id}: no ci workflow and no written ciExempt reason` });
    }
  }
  return problems;
}

function main(): void {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? args[rootIdx + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p: string): string => readFileSync(join(root, p), "utf8");
  let manifest: Manifest;
  const workflows: Record<string, string> = {};
  try {
    manifest = JSON.parse(read("deploy/v5/selfhost-release-gates.json")) as Manifest;
    if (manifest.schema !== "oc.v5.selfhost.release-gates/1" || !Array.isArray(manifest.gates)) {
      throw new Error("unexpected manifest schema");
    }
    const dir = join(root, ".github/workflows");
    for (const f of readdirSync(dir)) if (/^v5-selfhost-.*\.ya?ml$/.test(f)) workflows[f] = readFileSync(join(dir, f), "utf8");
  } catch (error) {
    console.error(`release-gate-parity: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const deployPath = "scripts/deploy-v5-selfhost.sh";
  const problems = check({
    manifest,
    masterLib: read("scripts/v5-selfhost-master-release-lib.sh"),
    deployScript: existsSync(join(root, deployPath)) ? read(deployPath) : "",
    workflows,
    pkgScripts: (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts,
  });
  for (const p of problems) console.log(`✗ [${p.kind}] ${p.message}`);
  const exempt = manifest.gates.filter((g) => !g.ci).map((g) => g.id);
  console.log(`release-gate-parity: gates=${manifest.gates.length} ci=${manifest.gates.length - exempt.length}`
    + ` exempt=${exempt.length}${exempt.length ? ` (${exempt.join(",")})` : ""} problems=${problems.length}`);
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
