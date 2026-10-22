// OCV5-582: release gate parity (train ↔ manifest ↔ CI). Each red case is the minimal drift the
// check exists for; the real repository must be green.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Manifest, check, functionCommands, runsIn, shellCommands, workflowRuns } from "../check-release-gate-parity.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const realWorkflows = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(ROOT, ".github/workflows"))) {
    if (/^v5-selfhost-.*\.ya?ml$/.test(f)) out[f] = read(`.github/workflows/${f}`);
  }
  return out;
};
const real = () => ({
  manifest: JSON.parse(read("deploy/v5/selfhost-release-gates.json")) as Manifest,
  masterLib: read("scripts/v5-selfhost-master-release-lib.sh"),
  deployScript: read("scripts/deploy-v5-selfhost.sh"),
  workflows: realWorkflows(),
  pkgScripts: (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts,
});
const kinds = (p: { kind: string }[]) => p.map((x) => x.kind);

test("the repository is green: every train gate is in the manifest and run by its CI workflow", () => {
  assert.deepEqual(check(real()), []);
});

test("red: a new train gate not in the manifest", () => {
  const input = real();
  input.masterLib = input.masterLib.replace(/^build_master_release\(\) \{\n/m,
    'build_master_release() {\n  ( cd "$staging" && npx --no-install tsx scripts/check-v5-new-gate.ts ) || die x\n');
  const p = check(input);
  assert.deepEqual(kinds(p), ["train-not-in-manifest"]);
  assert.match(p[0]!.message, /check-v5-new-gate\.ts/);
});

test("red: a manifest gate whose CI workflow step was removed", () => {
  const input = real();
  const wf = "v5-selfhost-release-gates.yml";
  input.workflows[wf] = input.workflows[wf]!.replace(/\n\s+- name: callback payload hash WS proof\n\s+run: node scripts\/check-v5-callback-payload-hash\.mjs/, "");
  const p = check(input);
  assert.deepEqual(kinds(p), ["ci-missing"]);
  assert.match(p[0]!.message, /callback-payload-hash/);
});

test("red: a gate named only in a workflow comment or step name is not run", () => {
  const input = real();
  const wf = "v5-selfhost-release-gates.yml";
  input.workflows[wf] = input.workflows[wf]!
    .replace("run: node scripts/check-v5-callback-payload-hash.mjs", "run: echo skipped # node scripts/check-v5-callback-payload-hash.mjs");
  assert.ok(workflowRuns(input.workflows[wf]!).includes("echo skipped"));
  assert.deepEqual(kinds(check(input)), ["ci-missing"]);
});

test("red: a CI step that only prints, quotes or comments the gate does not run it (Codex r1)", () => {
  const wf = "v5-selfhost-release-gates.yml";
  for (const fake of [
    "run: echo node scripts/check-v5-callback-payload-hash.mjs",
    "run: echo \"node scripts/check-v5-callback-payload-hash.mjs\"",
    "run: true # node scripts/check-v5-callback-payload-hash.mjs",
    "run: printf '%s' 'npx --no-install tsx scripts/check-v5-callback-payload-hash.mjs'",
  ]) {
    const input = real();
    input.workflows[wf] = input.workflows[wf]!.replace("run: node scripts/check-v5-callback-payload-hash.mjs", fake);
    const p = check(input);
    assert.deepEqual(kinds(p), ["ci-missing"], fake);
  }
  const web = real();
  web.workflows[wf] = web.workflows[wf]!.replace("run: npm run build --workspace packages/web-react", "run: echo npm run build --workspace packages/web-react");
  assert.deepEqual(kinds(check(web)), ["ci-missing"]);
});

test("red: the Codex final r3 backtick case in a CI step", () => {
  const wf = "v5-selfhost-release-gates.yml";
  const input = real();
  input.workflows[wf] = input.workflows[wf]!.replace("run: node scripts/check-v5-callback-payload-hash.mjs",
    "run: |\n          out=`printf '%s' '\\` ; node scripts/check-v5-callback-payload-hash.mjs'` # '");
  assert.deepEqual(kinds(check(input)), ["ci-missing"]);
});

test("red: the Codex fresh r1 quoted command word in a CI step", () => {
  const wf = "v5-selfhost-release-gates.yml";
  const input = real();
  input.workflows[wf] = input.workflows[wf]!.replace("run: node scripts/check-v5-callback-payload-hash.mjs",
    "run: |\n          \"echo\" node scripts/check-v5-callback-payload-hash.mjs");
  assert.deepEqual(kinds(check(input)), ["ci-missing"]);
});

test("red: a quote or heredoc spanning lines that only prints the gate does not run it (Codex r2)", () => {
  const wf = "v5-selfhost-release-gates.yml";
  const step = "run: node scripts/check-v5-callback-payload-hash.mjs";
  for (const fake of [
    "run: |\n          echo '\n          node scripts/check-v5-callback-payload-hash.mjs\n          '",
    "run: |\n          echo \"\n          node scripts/check-v5-callback-payload-hash.mjs\n          \"",
    "run: |\n          cat <<'EOF'\n          node scripts/check-v5-callback-payload-hash.mjs\n          EOF",
    // Codex r3: any bash word is a delimiter
    "run: |\n          cat <<'END-OF-TEXT'\n          node scripts/check-v5-callback-payload-hash.mjs\n          END-OF-TEXT",
    "run: |\n          cat <<42\n          node scripts/check-v5-callback-payload-hash.mjs\n          42",
    "run: |\n          cat <<\"two words\"\n          node scripts/check-v5-callback-payload-hash.mjs\n          two words",
  ]) {
    const input = real();
    input.workflows[wf] = input.workflows[wf]!.replace(step, fake);
    assert.ok(!input.workflows[wf]!.includes(step), fake);
    assert.deepEqual(kinds(check(input)), ["ci-missing"], fake);
  }
});

test("a here-string is not a heredoc: the next line still runs", () => {
  const runs = runsIn(shellCommands("grep -q x <<< \"$v\"\nnode scripts/a.mjs"));
  assert.deepEqual([...runs.scripts], ["scripts/a.mjs"]);
});

test("the scanner keeps only what bash executes inside quotes", () => {
  const runs = (t: string) => [...runsIn(shellCommands(t)).scripts];
  assert.deepEqual(runs(`log "run; node scripts/a.mjs"`), []);
  assert.deepEqual(runs(`x='$(node scripts/a.mjs)'`), []);
  assert.deepEqual(runs(`out="$(node scripts/a.mjs --x "$Y")"`), ["scripts/a.mjs"]);
  assert.deepEqual(runs("out=`node scripts/a.mjs`"), ["scripts/a.mjs"]);
  assert.deepEqual(runs(`echo "$(echo 'node scripts/a.mjs')"`), []);
  assert.deepEqual(runs(`v="$(( 1 + 2 ))"; node scripts/b.mjs`), ["scripts/b.mjs"]);
  // Codex fresh r1: a quoted word at command position is the command, not a prefix
  assert.deepEqual(runs(`"echo" node scripts/a.mjs`), []);
  assert.deepEqual(runs(`'echo' node scripts/a.mjs`), []);
  assert.deepEqual(runs(`env "echo" node scripts/a.mjs`), []);
  assert.deepEqual(runs(`env 'X=1' "Y=$Z" node scripts/a.mjs`), ["scripts/a.mjs"]);
  // Codex final r3: an escaped backtick does not close the substitution
  assert.deepEqual(runs("out=`printf '%s' '\\` ; node scripts/a.mjs'` # '"), []);
  assert.deepEqual(runs("out=`echo \\` x`; node scripts/b.mjs"), ["scripts/b.mjs"]);
});

test("a comment with an apostrophe does not swallow the next command", () => {
  const runs = runsIn(shellCommands("# don't run twice\nnode scripts/a.mjs\necho \"it's # not a comment\"\nbash scripts/b.sh # done"));
  assert.deepEqual([...runs.scripts], ["scripts/a.mjs", "scripts/b.sh"]);
});

test("sudo/env prefixes at command position still count as a run", () => {
  const runs = runsIn(shellCommands([
    'sudo env "PATH=$PATH" "HOME=$HOME" npx --no-install tsx scripts/a.ts',
    "env -u DATABASE_URL -u TEST_DATABASE_URL npx --no-install tsx scripts/b.ts --expect-sha x",
    "cd x && NODE_OPTIONS='--max' npm run build --workspace packages/web-react",
    "tsx scripts/c.ts && tsx scripts/d.ts",
  ].join("\n")));
  assert.deepEqual([...runs.scripts], ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts"]);
  assert.deepEqual([...runs.npm], ["npm run build --workspace packages/web-react"]);
});

test("red: the train stopped running a manifest gate", () => {
  const input = real();
  input.masterLib = input.masterLib.replace(/npx --no-install tsx scripts\/check-v5-cron-submit-boundary\.ts/, "true");
  assert.deepEqual(kinds(check(input)), ["manifest-not-in-train"]);
});

test("red: the production web build left the train or CI", () => {
  const input = real();
  input.masterLib = input.masterLib.replace("npm run build --workspace packages/web-react", "true");
  assert.deepEqual(kinds(check(input)), ["manifest-not-in-train"]);
  const ci = real();
  const wf = "v5-selfhost-release-gates.yml";
  ci.workflows[wf] = ci.workflows[wf]!.replace("run: npm run build --workspace packages/web-react", "run: npm run typecheck");
  assert.deepEqual(kinds(check(ci)), ["ci-missing"]);
});

test("red: the deploy-stage trailer gate is no longer really called (Codex final r1)", () => {
  const cases: [string, (d: string) => string][] = [
    ["call removed, mentions kept", (d) => d.replace(/^ {2}assert_fix_trailers "\$sha"\n/m, "")],
    ["call only in a comment", (d) => d.replace(/^ {2}assert_fix_trailers "\$sha"$/m, '  # assert_fix_trailers "$sha"')],
    ["call only echoed", (d) => d.replace(/^ {2}assert_fix_trailers "\$sha"$/m, '  echo assert_fix_trailers "$sha"')],
    ["function no longer runs the gate", (d) => d.replace(/"\$FIX_TRAILER_GATE" --repo/, "true --repo")],
    ["variable points elsewhere", (d) => d.replace(/^FIX_TRAILER_GATE=.*$/m, 'FIX_TRAILER_GATE="$SCRIPT_DIR/other.sh"')],
    // Codex final r2: a single-quoted $( … ) is a literal, not a run
    ["runner single-quoted", (d) => d.replace(/out="\$\("\$FIX_TRAILER_GATE" (.*?)\)"/, "out='$(\"$FIX_TRAILER_GATE\" $1)'")],
    ["runner only named in a double-quoted message", (d) => d.replace(/out="\$\("\$FIX_TRAILER_GATE" (.*?)\)"/, 'out="later; $FIX_TRAILER_GATE $1"')],
  ];
  for (const [name, mutate] of cases) {
    const input = real();
    const before = input.deployScript;
    input.deployScript = mutate(before);
    assert.notEqual(input.deployScript, before, `${name}: mutation applied`);
    assert.deepEqual(kinds(check(input)), ["manifest-not-in-train"], name);
  }
});

test("red: an escaped separator does not start a command (Codex final r1)", () => {
  const wf = "v5-selfhost-release-gates.yml";
  const input = real();
  input.workflows[wf] = input.workflows[wf]!.replace("run: node scripts/check-v5-callback-payload-hash.mjs",
    "run: echo \\; node scripts/check-v5-callback-payload-hash.mjs");
  assert.deepEqual(kinds(check(input)), ["ci-missing"]);
  assert.deepEqual([...runsIn(shellCommands("a \\\nnode scripts/x.mjs")).scripts], [], "continuation joins into a's arguments");
  assert.deepEqual([...runsIn(shellCommands("a;\\\nnode scripts/x.mjs")).scripts], ["scripts/x.mjs"]);
});

test("exempt needs a written reason; a real reason is accepted", () => {
  const input = real();
  const gate = input.manifest.gates.find((g) => g.id === "callback-payload-hash")!;
  gate.ci = undefined;
  gate.ciExempt = "n/a";
  assert.deepEqual(kinds(check(input)), ["ci-missing"]);
  gate.ciExempt = "needs the host's commercial test mutex and a live loopback WS listener";
  assert.deepEqual(check(input), []);
});

test("npm run in CI counts through package.json", () => {
  const input = real();
  const wf = "v5-selfhost-release-gates.yml";
  input.workflows[wf] = input.workflows[wf]!.replace("run: node scripts/check-v5-callback-payload-hash.mjs", "run: npm run proof:callback");
  input.pkgScripts = { ...input.pkgScripts, "proof:callback": "node scripts/check-v5-callback-payload-hash.mjs" };
  assert.deepEqual(check(input), []);
});

test("messages, file-presence tests and comments in build_master_release are not runs", () => {
  const lib = [
    "build_master_release() {",
    '  mlog "  run npx --no-install tsx scripts/check-v5-a.ts later"',
    '  [[ -f "$staging/scripts/check-v5-b.ts" ]] || die "missing scripts/check-v5-b.ts"',
    "  # npx --no-install tsx scripts/check-v5-c.ts",
    "  ( cd \"$staging\" && TMPDIR=\"$T\" npx --no-install tsx scripts/check-v5-d.ts \\",
    "      --flag ) || die x",
    "  ( cd \"$staging\" && NODE_OPTIONS='--max-old-space-size=4096' npm run build --workspace packages/web-react )",
    "}",
  ].join("\n");
  const r = runsIn(functionCommands(lib, "build_master_release"));
  assert.deepEqual([...r.scripts], ["scripts/check-v5-d.ts"]);
  assert.deepEqual([...r.npm], ["npm run build --workspace packages/web-react"]);
});
