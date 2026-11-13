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
 *             run), with `npm run <script>` followed through package.json; a step a PR may skip
 *             or whose failure CI ignores (if:, continue-on-error, shell, runner, needs, trigger
 *             filters) is not counted (see workflowSteps).
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
/** A quoted `NAME=…` word (the scanner keeps the NAME= of a quoted string): an assignment only as an
 * `env` argument. At command position any quoted word, `"X=1"` included, IS the command (`"echo"
 * node …` prints; Codex fresh r1/r2); a bare assignment is an unquoted NAME= (value may be quoted). */
const QUOTED_ASSIGN = String.raw`(?:'[A-Za-z_][A-Za-z0-9_]*='|"[A-Za-z_][A-Za-z0-9_]*=[^"\n]*")`;
const PREFIX = String.raw`(?:^|[;&|(])\s*(?:sudo\s+)?(?:(?:env(?:\s+(?:-u\s+\S+|${QUOTED_ASSIGN}|[A-Za-z_][A-Za-z0-9_]*=\S*))*|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*`;
const SCRIPT_RUN = new RegExp(
  `${PREFIX}(?:npx(?:\\s+--no-install)?\\s+tsx|tsx|node|bash)\\s+((?:packages\\/[\\w.-]+\\/)?scripts\\/[\\w./-]+)`, "g");
const NPM_RUN = new RegExp(`${PREFIX}npm run (\\S+)((?:\\s+--workspace\\s+\\S+)?)`, "g");

/** Shell text → executable text, one state machine for quotes, comments, escapes and heredocs
 * (Codex fresh r1–r3 bypasses all came from handling them separately). Line breaks are preserved
 * one-for-one, so line k of the result is line k of the input.
 *  - single-quoted strings are literals → '' (a leading NAME= is kept: `env 'X=1'`);
 *  - inside double quotes only `$( … )` / backtick substitutions and `$NAME` / `${NAME}` survive,
 *    so `"run; node scripts/x"` is no command while `"$("$GATE" …)"` still is;
 *  - escaped characters are literals; a continuation survives;
 *  - `#` starts a comment only at a word start outside quotes;
 *  - every heredoc a line opens (in code, not in a comment or quote) is queued, and their bodies,
 *    which are data, become blank lines.
 * Unbalanced input fails closed: the rest reads as one literal, so nothing after it runs. */
export function stripShell(text: string): string {
  return scanCode(text, 0, false, { heredocs: [] })[0];
}

interface ScanState { heredocs: { tag: string; dash: boolean }[] }
/** The line breaks inside a quoted span, as continuations: line k stays line k, but the text after
 * the closing quote is still the same command's arguments, not a new command (Codex item8 final). */
const newlines = (s: string) => s.replace(/[^\n]/g, "").replace(/\n/g, "\\\n");
/** `<<` / `<<-` and its delimiter: one bash word, quoted parts and unquoted parts mixed (`E"OF"` is
 * EOF; Codex final4 r1). */
const HEREDOC = /^<<(-?)[ \t]*((?:'[^'\n]*'|"(?:\\.|[^"\\\n])*"|\\.|[^\s;&|<>()'"])+)/;
/** Quote removal on a heredoc delimiter word. */
function unquoteWord(w: string): string {
  return w.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g, (_m, sq: string | undefined, dq: string | undefined, esc: string | undefined) =>
    sq ?? (dq !== undefined ? dq.replace(/\\([$`"\\])/g, "$1") : esc!));
}

function scanCode(text: string, from: number, inSub: boolean, st: ScanState): [string, number] {
  let out = "";
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") {
      out += "\n"; i++;
      while (st.heredocs.length > 0 && i < text.length) {
        const h = st.heredocs.shift()!;
        while (i < text.length) {
          const j = text.indexOf("\n", i);
          const line = text.slice(i, j < 0 ? text.length : j);
          i = j < 0 ? text.length : j + 1;
          if (j >= 0) out += "\n";
          if ((h.dash ? line.replace(/^\t+/, "") : line) === h.tag) break;
        }
      }
      continue;
    }
    if (c === "\\") { out += text[i + 1] === "\n" ? "\\\n" : "_"; i += 2; continue; }
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      const raw = text.slice(i + 1, j < 0 ? text.length : j);
      const assign = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(raw);
      out += `'${assign ? assign[0] : ""}'${newlines(raw)}`; i = j < 0 ? text.length : j + 1; continue;
    }
    if (c === '"') {
      const [kept, j] = scanDouble(text, i + 1, st);
      out += `"${kept.replace(/\n/g, "; ")}"${newlines(text.slice(i, j))}`; i = j; continue;
    }
    if (c === "`") {
      const j = backtickEnd(text, i + 1);
      const raw = text.slice(i + 1, j);
      out += `$(${stripShell(raw).replace(/\n/g, "; ")})${newlines(raw)}`; i = j + 1; continue;
    }
    if (c === "#" && (i === from || /[\s;&|(]/.test(text[i - 1]!))) {
      const j = text.indexOf("\n", i);
      i = j < 0 ? text.length : j; continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<" && text[i - 1] !== "<") {
      // any bash word is a delimiter (END-OF-TEXT, 42, 'a b'); `<<<` is a here-string
      const m = HEREDOC.exec(text.slice(i));
      if (m) {
        st.heredocs.push({ tag: unquoteWord(m[2]!), dash: m[1] === "-" });
        out += "<<''"; i += m[0].length; continue;
      }
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

function scanDouble(text: string, from: number, st: ScanState): [string, number] {
  // keep a leading NAME= so an `env "NAME=$X"` argument stays an assignment, not a command word
  const assign = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text.slice(from));
  let out = assign ? assign[0] : "";
  let i = from + out.length;
  while (i < text.length && text[i] !== '"') {
    const c = text[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && text[i + 1] === "(") {
      const [inner, j] = scanCode(text, i + 2, true, st);
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

/** Shell text → command lines (stripShell, then continuations joined). */
export function shellCommands(text: string): string[] {
  return stripShell(text).replace(/\\\n/g, " ").split("\n");
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

/** The branch selfhost PRs target: a gate workflow must run on pull requests into it. */
const PR_BASE = "feat/v5-selfhost";
/** The only `if:` values that keep a job or step running whenever the PR workflow runs. Anything
 * else (`false`, `${{ false }}`, `github.event_name == 'push'`, `failure()`, …) may skip it. */
const RUNS_IF = /^(?:\$\{\{\s*)?(?:always|success|!\s*cancelled)\(\)(?:\s*\}\})?$/;

type Yaml = Record<string, unknown>;
export interface SkippedStep { where: string; why: string; run: string }
const isMap = (v: unknown): v is Yaml => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why the workflow does not run on every pull request into PR_BASE, or null when it does.
 * Filters (paths, paths-ignore, branches-ignore, types, negated branch patterns) may skip a PR, so
 * any filter other than `branches` listing PR_BASE literally, with no `!` pattern, counts as "may
 * not run". */
function prTriggerGap(on: unknown): string | null {
  if (on === "pull_request" || (Array.isArray(on) && on.includes("pull_request"))) return null;
  if (!isMap(on) || !("pull_request" in on)) return "on: has no pull_request trigger";
  const pr = on.pull_request;
  if (pr === null || pr === undefined) return null;
  if (!isMap(pr)) return "on.pull_request is not a map";
  const extra = Object.keys(pr).filter((k) => k !== "branches");
  if (extra.length) return `on.pull_request filters by ${extra.join(", ")}`;
  if (!("branches" in pr)) return null;
  const b = Array.isArray(pr.branches) ? pr.branches : [pr.branches];
  // a later `!pattern` can exclude the base again (patterns apply in order; Codex item8 r1)
  if (b.some((x) => typeof x !== "string" || x.startsWith("!"))) return "on.pull_request.branches has a negated pattern";
  return b.includes(PR_BASE) ? null : `on.pull_request.branches does not list ${PR_BASE}`;
}

/** Why a job or step may not run, or may fail without failing CI; null when it always runs and
 * fails CI on a non-zero exit (bash -e: the runner default on Linux and for `shell: bash`). */
function runGap(node: Yaml, level: "job" | "step"): string | null {
  if ("if" in node && !(typeof node.if === "string" && RUNS_IF.test(node.if.trim()))) return `${level} if: ${String(node.if)}`;
  if ("continue-on-error" in node && node["continue-on-error"] !== false) {
    return `${level} continue-on-error: ${String(node["continue-on-error"])}`;
  }
  const shell = level === "step" ? node.shell : isMap(node.defaults) && isMap(node.defaults.run) ? node.defaults.run.shell : undefined;
  if (shell !== undefined && shell !== "bash") return `${level} shell: ${String(shell)}`;
  if (level === "job" && !(typeof node["runs-on"] === "string" && node["runs-on"].startsWith("ubuntu-"))) {
    return `job runs-on: ${JSON.stringify(node["runs-on"])} (default shell is bash only on ubuntu-*)`;
  }
  return null;
}

/** The `run:` steps of a workflow that really run on a pull request and fail CI when the command
 * fails (YAML comments, names and `if:` text are never a run). A step is not counted when its
 * workflow trigger, job or step may skip it or ignore its failure (Codex final4 r2 list item 8):
 * an `if:` other than always()/success()/!cancelled(), continue-on-error other than false, a
 * non-bash shell (step, job or workflow defaults), a non-ubuntu runner, a needed job that is not
 * counted, or a pull_request trigger with filters. `skipped` says why, for the problem message. */
export function workflowSteps(yml: string): { runs: string[]; skipped: SkippedStep[] } {
  // merge keys on: `<<: *anchor` can carry an `if:`/continue-on-error into a job or step
  const doc = parseYaml(yml, { merge: true }) as unknown;
  const runs: string[] = [];
  const skipped: SkippedStep[] = [];
  const root = isMap(doc) ? doc : {};
  const jobs = isMap(root.jobs) ? root.jobs : {};
  const wfShell = isMap(root.defaults) && isMap(root.defaults.run) ? root.defaults.run.shell : undefined;
  const wfGap = prTriggerGap(root.on) ?? (wfShell !== undefined && wfShell !== "bash" ? `workflow shell: ${String(wfShell)}` : null);
  const jobGapMemo = new Map<string, string | null>();
  const jobGap = (id: string, seen: Set<string>): string | null => {
    if (jobGapMemo.has(id)) return jobGapMemo.get(id)!;
    const job = jobs[id];
    if (!isMap(job)) return `needs unknown job ${id}`;
    if (seen.has(id)) return `needs cycle at ${id}`;
    let gap = runGap(job, "job");
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    for (const n of needs) {
      if (gap) break;
      const g = typeof n === "string" ? jobGap(n, new Set([...seen, id])) : "needs is not a job id";
      if (g) gap = `needs ${String(n)} (${g})`;
    }
    jobGapMemo.set(id, gap);
    return gap;
  };
  for (const [id, job] of Object.entries(jobs)) {
    const steps = isMap(job) && Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step: unknown, k) => {
      if (!isMap(step) || typeof step.run !== "string") return;
      const why = wfGap ?? jobGap(id, new Set()) ?? runGap(step, "step");
      if (why) skipped.push({ where: `${id}/${typeof step.name === "string" ? step.name : `step ${k + 1}`}`, why, run: step.run });
      else runs.push(step.run);
    });
  }
  return { runs, skipped };
}

/** The counted `run:` steps of a workflow, joined (see workflowSteps). */
export function workflowRuns(yml: string): string {
  return workflowSteps(yml).runs.join("\n");
}

/** What each workflow's `run:` steps execute, `npm run x` followed through package.json
 * (cycle-safe) with the same command-position rule. */
export function ciRuns(workflows: Record<string, string>, pkgScripts: Record<string, string>):
  Record<string, { scripts: Set<string>; npm: Set<string>; skipped: SkippedStep[] }> {
  const out: Record<string, { scripts: Set<string>; npm: Set<string>; skipped: SkippedStep[] }> = {};
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
    const steps = workflowSteps(yml);
    visit(steps.runs.join("\n"), new Set());
    out[file] = { scripts, npm, skipped: steps.skipped };
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
  // every assignment of the variable that bash executes (not in a heredoc body, quote or comment)
  // must be exactly the script path, so a decoy or a later reassignment fails (Codex fresh r3)
  const want = `${v}="$SCRIPT_DIR/${gate.script.replace(/^scripts\//, "")}"`;
  const raw = deployScript.split("\n");
  const code = stripShell(deployScript).split("\n");
  // leading indentation is still command position (Codex final4 r1: `  VAR=/bin/true`)
  const assignAt = new RegExp(`(?:^\\s*|[;&|(]\\s*|\\b(?:export|local|declare|readonly)\\s+)${v}=`);
  const assigns = code.flatMap((line, k) => (assignAt.test(line) ? [raw[k]!.replace(/(^|\s)#.*$/, "$1").trim()] : []));
  return assigns.length > 0 && assigns.every((line) => line === want);
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
        const why = runs.skipped.filter((s) => s.run.includes(key)).map((s) => `${s.where}: ${s.why}`);
        const note = why.length ? ` (not counted: ${why.join("; ")})` : "";
        problems.push({ kind: "ci-missing", message: `${gate.id}: ${gate.ci} does not run ${key}${note}` });
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
