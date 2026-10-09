import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// OCV5-357: release gates in staging must not share (or grow) the global tsx compile cache.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lib = readFileSync(path.join(root, "scripts/v5-selfhost-master-release-lib.sh"), "utf8");

function fn(name: string): string {
  const m = lib.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(m, name);
  return m[0];
}

const fns = ["create_master_gate_tmpdir", "cleanup_master_gate_tmpdir", "sweep_stale_master_gate_tmpdirs", "prune_shared_tsx_cache"]
  .map(fn)
  .join("\n");

function run(dir: string, body: string, env: Record<string, string> = {}) {
  const script = [
    'mlog() { echo "$*" >&2; }',
    `MASTER_GATE_TMP_PREFIX=${JSON.stringify(path.join(dir, "gate"))}`,
    'MASTER_GATE_TMPDIR=""',
    'TSX_SHARED_CACHE_MAX_AGE_MIN="${TSX_SHARED_CACHE_MAX_AGE_MIN:-2880}"',
    fns,
    body,
  ].join("\n");
  return spawnSync("bash", ["-eu", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: dir, ...env },
  });
}

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-gate-tsx-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("selfhost release gates use a per-build tsx cache (OCV5-357)", () => {
  test("every gate in the staging block runs with the private TMPDIR, and the dir is removed after", () => {
    const a = lib.indexOf('mlog "  Box success recovery behavioral gate');
    const b = lib.indexOf('web_key="$(master_web_dist_key');
    assert.ok(a > 0 && b > a);
    const block = lib.slice(a, b);
    const gates = block.match(/\( cd "\$staging" && [^\n]*/g) ?? [];
    assert.ok(gates.length >= 8, `found ${gates.length} gates`);
    for (const g of gates) assert.match(g, /^\( cd "\$staging" && TMPDIR="\$MASTER_GATE_TMPDIR" /, g);
    assert.match(block, /\n {2}cleanup_master_gate_tmpdir\n/);
    const before = lib.slice(0, a);
    assert.ok(before.lastIndexOf("create_master_gate_tmpdir") > before.lastIndexOf("build_master_release() {"));
  });

  test("every failure path cleans the gate dir: cleanup_master_staging calls it first", () => {
    const body = fn("cleanup_master_staging");
    const call = body.indexOf("cleanup_master_gate_tmpdir");
    assert.ok(call > 0 && call < body.indexOf("return 0"), "cleanup_master_gate_tmpdir must run before any early return");
  });

  test("create + cleanup round trip, and tsx really writes its cache under the private TMPDIR", (t) => {
    const dir = fixture(t);
    const tsx = path.join(root, "node_modules/.bin/tsx");
    // -e input is not cached; a real module graph is.
    const src = path.join(dir, "src");
    mkdirSync(src);
    writeFileSync(path.join(src, "b.ts"), "export const n: number = 1;\n");
    writeFileSync(path.join(src, "a.ts"), 'import { n } from "./b.ts";\nconsole.log("tsx-ok", n);\n');
    const r = run(
      dir,
      `create_master_gate_tmpdir
d="$MASTER_GATE_TMPDIR"
echo "dir=$d"
TMPDIR="$d" ${JSON.stringify(tsx)} ${JSON.stringify(path.join(src, "a.ts"))} | sed 's/^/out=/'
ls "$d" | sed 's/^/entry=/'
find "$d/tsx-$(id -u)" -type f | head -1 | sed 's/^/cached=/'
cleanup_master_gate_tmpdir
test ! -e "$d" && echo gone
test -z "$MASTER_GATE_TMPDIR" && echo cleared`,
    );
    assert.equal(r.status, 0, r.stderr);
    const gateDir = r.stdout.match(/^dir=(.*)$/m)?.[1] ?? "";
    assert.ok(gateDir.startsWith(path.join(dir, "gate") + "."), gateDir);
    assert.match(r.stdout, new RegExp(`^entry=tsx-${process.getuid?.()}$`, "m"));
    assert.match(r.stdout, /^out=tsx-ok 1$/m);
    assert.match(r.stdout, /^cached=/m);
    assert.match(r.stdout, /^gone$/m);
    assert.match(r.stdout, /^cleared$/m);
  });

  test("cleanup refuses a dir this build did not create", (t) => {
    const dir = fixture(t);
    const other = path.join(dir, "elsewhere");
    mkdirSync(other);
    const r = run(dir, `MASTER_GATE_TMPDIR=${JSON.stringify(other)}; cleanup_master_gate_tmpdir`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(other));
    assert.match(r.stderr, /拒绝 rm/);
  });

  test("sweep removes dirs of dead pids only, never live pids, symlinks or other names", (t) => {
    const dir = fixture(t);
    const prefix = path.join(dir, "gate");
    const dead = `${prefix}.999999999.abc`;
    const live = `${prefix}.${process.pid}.abc`;
    const odd = `${prefix}.notapid.abc`;
    const target = path.join(dir, "target");
    for (const d of [dead, live, odd, target]) mkdirSync(d);
    symlinkSync(target, `${prefix}.999999998.lnk`);
    const r = run(dir, "sweep_stale_master_gate_tmpdirs");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(dead), false);
    for (const d of [live, odd, target, `${prefix}.999999998.lnk`]) assert.ok(existsSync(d), d);
  });

  test("shared cache prune deletes only old tsx cache files", (t) => {
    const dir = fixture(t);
    const cache = path.join(dir, `tsx-${process.getuid?.()}`);
    mkdirSync(cache);
    const old = path.join(cache, "17915-" + "a".repeat(40));
    const fresh = path.join(cache, "17915-" + "b".repeat(40));
    const pipe = path.join(cache, "123.pipe");
    const other = path.join(cache, "keep-me");
    for (const f of [old, fresh, pipe, other]) writeFileSync(f, "{}");
    const threeDaysAgo = Date.now() / 1000 - 3 * 86400;
    for (const f of [old, pipe, other]) utimesSync(f, threeDaysAgo, threeDaysAgo);
    const r = run(dir, "prune_shared_tsx_cache");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(cache).sort(), ["123.pipe", "17915-" + "b".repeat(40), "keep-me"].sort());
    assert.match(r.stderr, /2 → 1 个条目/);
  });

  test("shared cache prune never fails the build on a bad threshold", (t) => {
    const dir = fixture(t);
    mkdirSync(path.join(dir, `tsx-${process.getuid?.()}`));
    const r = run(dir, "prune_shared_tsx_cache; echo after", { TSX_SHARED_CACHE_MAX_AGE_MIN: "soon" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /after/);
  });
});
