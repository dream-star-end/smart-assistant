#!/usr/bin/env tsx
/** Independent offline single-ablation fixtures; never a paid Box test. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GATE = "scripts/check-v5-box-success-recovery.ts";
const mutations = [
  { key: "history-alias", file: "packages/commercial/src/http/proxy/boxMessagesMapper.ts",
    from: "if (alias) return { ...block, name: alias };", to: "if (alias) return { ...block, name };",
    error: /BOX_TOOL_HISTORY_ALIAS/ },
  { key: "system-notice", file: "packages/commercial/src/http/proxy/boxToolPlan.ts",
    from: "systemSuffix: boxToolAliasNotice(catalog)", to: 'systemSuffix: ""',
    error: /BOX_TOOL_SYSTEM_PREFIX|BOX_TOOL_SYSTEM_NOTICE/ },
  { key: "proven-stop-exit", file: "packages/commercial/src/http/proxy/boxToolFirstRound.ts",
    from: 'if (outcome === "stopped_proven") {', to: 'if (false && outcome === "stopped_proven") {',
    error: /BOX_TOOL_FIRSTROUND_PROVEN_STOP/ },
];
const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
assert.equal(sha.status, 0); const candidate = sha.stdout.trim(); assert.match(candidate, /^[0-9a-f]{40}$/);
const dsn = process.env.OC_V5_PROOF_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
assert.ok(dsn, "explicit test-only DSN required");
const names = spawnSync("git", ["ls-files", "-c", "-o", "--exclude-standard", "-z"], { cwd: ROOT });
assert.equal(names.status, 0);
const files = [...new Set(names.stdout.toString().split("\0").filter(Boolean))]
  .filter((name) => existsSync(join(ROOT, name)) && lstatSync(join(ROOT, name)).isFile());
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const original = new Map(files.map((name) => [name, hash(join(ROOT, name))]));
const clone = (dir: string) => {
  for (const name of files) { mkdirSync(dirname(join(dir, name)), { recursive: true }); cpSync(join(ROOT, name), join(dir, name)); }
  const deps = realpathSync(join(ROOT, "node_modules"));
  const local = join(dir, "node_modules"); mkdirSync(local); mkdirSync(join(local, "@openclaude"));
  for (const name of readdirSync(deps)) {
    if (name === "@openclaude" || name === ".bin") continue;
    if (name === "pg" || name === "tsx") cpSync(realpathSync(join(deps, name)), join(local, name), { recursive: true, dereference: true });
    else symlinkSync(join(deps, name), join(local, name));
  }
  const workspaces = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).workspaces as string[];
  const packages = workspaces.map((path) => ({ path: join(dir, path),
    name: JSON.parse(readFileSync(join(dir, path, "package.json"), "utf8")).name as string }));
  for (const item of packages) if (item.name.startsWith("@openclaude/")) symlinkSync(item.path, join(local, item.name));
  for (const consumer of packages) {
    mkdirSync(join(consumer.path, "node_modules", "@openclaude"), { recursive: true });
    for (const target of packages) if (target.name.startsWith("@openclaude/")) symlinkSync(target.path, join(consumer.path, "node_modules", target.name));
  }
};
const modes = process.argv.slice(2);
if (modes.length !== 1 || !["positive", "negative"].includes(modes[0]!)) throw new Error("fixture positive|negative required");
for (const mutation of modes[0] === "positive" ? [null] : mutations) {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-tool-name-ablation-"));
  try {
    clone(dir);
    if (mutation) {
      const p = join(dir, mutation.file), before = readFileSync(p, "utf8");
      assert.equal(before.split(mutation.from).length - 1, 1, "unique ablation needle");
      const after = before.replace(mutation.from, mutation.to); writeFileSync(p, after);
      assert.equal(after.replace(mutation.to, mutation.from), before, "single exact reverse");
    }
    const drift = files.filter((name) => hash(join(dir, name)) !== original.get(name));
    assert.deepEqual(drift, mutation ? [mutation.file] : [], "exact isolated source transform");
    const run = spawnSync(process.execPath, ["--import", join(dir, "node_modules/tsx/dist/esm/index.mjs"),
      join(dir, GATE), "--candidate-sha", candidate], {
      cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_DATABASE_URL: dsn },
      timeout: 96_000, maxBuffer: 16 * 1024 * 1024,
    });
    const output = (run.stdout ?? "") + (run.stderr ?? "");
    process.stdout.write(output);
    assert.ok(!run.error, "outer watchdog failed");
    if (mutation) {
      assert.notEqual(run.status, 0, "ablation unexpectedly green");
      assert.match(output, mutation.error, "specific business RED missing");
      assert.doesNotMatch(output, /ERR_MODULE|Cannot find module|SyntaxError|NS_NOT_PRIVATE|NS_PROPAGATION|STAGE_EXEC|DEADLINE|ENOTFOUND|ECONNREFUSED/, "infrastructure failure is not business RED");
      assert.ok(!output.includes("PASS candidate"));
    } else {
      assert.equal(run.status, 0, "positive formal gate failed");
      assert.ok(output.includes(`PASS candidate ${candidate}`));
    }
    for (const [name, old] of original) assert.equal(hash(join(ROOT, name)), old, `source drift ${name}`);
    process.stdout.write(`box success recovery fixtures: PASS ${mutation?.key ?? "positive"} files=${files.length} diff=${JSON.stringify(drift)} outputSha=${createHash("sha256").update(output).digest("hex")} root=${relative(ROOT, dir)}\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
