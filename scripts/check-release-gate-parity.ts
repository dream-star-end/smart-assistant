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
 *   CI      = the `run:` steps of .github/workflows/v5-selfhost-*.yml (comments and step names do
 *             not count), with `npm run <script>` expanded through package.json.
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

const SCRIPT_RUN =
  /(?:^|[;&|(])\s*(?:(?:env(?:\s+-u\s+\S+)*|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*(?:npx(?:\s+--no-install)?\s+tsx|node|bash)\s+((?:packages\/[\w.-]+\/)?scripts\/[\w./-]+)/g;
const NPM_RUN = /\bnpm run (\S+)((?:\s+--workspace\s+\S+)?)/g;

/** Command lines of a shell function body: continuations joined, heredocs skipped, quoted text
 * and comments dropped, so a message or a file-presence test naming a gate is not a run. */
export function functionCommands(src: string, name: string): string[] {
  const lines = src.replace(/\\\n/g, " ").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{\\s*$`).test(line));
  if (start < 0) return [];
  const out: string[] = [];
  let heredoc: { tag: string; dash: boolean } | null = null;
  for (const raw of lines.slice(start + 1)) {
    if (heredoc) {
      if ((heredoc.dash ? raw.replace(/^\t+/, "") : raw) === heredoc.tag) heredoc = null;
      continue;
    }
    if (/^\}/.test(raw)) break;
    const doc = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(raw);
    if (doc) heredoc = { tag: doc[3]!, dash: doc[1] === "-" };
    // keep single-quoted env values like NODE_OPTIONS='…' harmless, drop all other quoted text
    out.push(raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/(^|\s)#.*$/, "$1"));
  }
  return out;
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

/** `run:` text of the workflows, `npm run x` expanded through package.json (cycle-safe). */
export function ciText(workflows: Record<string, string>, pkgScripts: Record<string, string>): Record<string, string> {
  const expand = (text: string, seen: Set<string>): string =>
    text.replace(/\bnpm run (\S+)/g, (whole, name: string) => {
      const body = pkgScripts[name];
      if (body === undefined || seen.has(name)) return whole;
      return `${whole} ${expand(body, new Set([...seen, name]))}`;
    });
  const out: Record<string, string> = {};
  for (const [file, yml] of Object.entries(workflows)) out[file] = expand(workflowRuns(yml), new Set());
  return out;
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
  const ci = ciText(workflows, pkgScripts);
  for (const gate of manifest.gates) {
    const key = gate.script ?? gate.command;
    if (!key) continue;
    const stage = gate.stage ?? "build";
    const inTrain = stage === "build"
      ? (gate.script ? train.scripts.has(key) : train.npm.has(key))
      : deployScript.includes(key.split("/").pop()!);
    if (!inTrain) {
      problems.push({ kind: "manifest-not-in-train", message: `${gate.id}: the ${stage} stage no longer runs ${key}` });
    }
    if (gate.ci) {
      const text = ci[gate.ci];
      if (text === undefined) {
        problems.push({ kind: "ci-missing", message: `${gate.id}: workflow ${gate.ci} does not exist` });
      } else if (!text.includes(key)) {
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
