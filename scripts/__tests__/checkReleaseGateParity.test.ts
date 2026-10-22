// OCV5-582: release gate parity (train ↔ manifest ↔ CI). Each red case is the minimal drift the
// check exists for; the real repository must be green.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Manifest, check, functionCommands, runsIn, workflowRuns } from "../check-release-gate-parity.ts";

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
