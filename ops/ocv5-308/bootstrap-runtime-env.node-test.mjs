import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureUrl = "postgresql://test:test@127.0.0.1:55432/openclaude_test";
// Root/PG entry proof is a local release prerequisite, not a fake-root unit.
// Run through the official commercial mutex; never against production.
assert.equal(process.getuid(), 0, "requires real root for private root0600 env/holder");
const base = {
  DATABASE_URL: fixtureUrl, MODEL_AUTHORITY_DEPLOY_DATABASE_URL: fixtureUrl,
  MODEL_CATALOG_ADMIN_DATABASE_URL: fixtureUrl,
  REDIS_URL: "redis://127.0.0.1:56379", COMMERCIAL_ENABLED: "1",
  COMMERCIAL_JWT_SECRET: "j".repeat(32), OC_RUNTIME_CHANNEL: "v5",
  OC_RUNTIME_IMAGE: "openclaude/runtime:fixture", OC_EGRESS_SPLIT: "1",
  INTERNAL_CONTROL_BIND: "127.0.0.1", INTERNAL_CONTROL_PORT: "18894",
  OC_EGRESS_SECRET: "e".repeat(32),
};
function run(change = {}, mode = 0o600, corruptDigest = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "v5-bootstrap-entry-"));
  try {
    const bin = path.join(dir, "bin"); mkdirSync(bin);
    const fakeSsh = path.join(bin, "ssh");
    writeFileSync(fakeSsh, [
      "#!/bin/bash", "set -e",
      'while [[ "$1" == -o ]]; do shift 2; done',
      '[[ "$1" == offline-bootstrap ]] || exit 99',
      "shift",
      // Exact official remote shell, substitute only the SSH transport.
      'if [[ "$1" == bash && "$2" == -s ]]; then',
      '  if [[ "${OC_BOOTSTRAP_CORRUPT_DIGEST:-0}" == 1 && "${5:-}" =~ ^[0-9a-f]{64}$ ]]; then',
      '    set -- "$1" "$2" "$3" "$4" "$(printf "%064d" 0)" "$6"',
      "  fi",
      '  exec "$@"',
      "fi",
      'exec bash -c "$1" 2> >(tee -a "$OC_BOOTSTRAP_PHASE_LOG" >&2)',
    ].join("\n") + "\n"); chmodSync(fakeSsh, 0o755);
    const values = { ...base, ...change };
    const envFile = path.join(dir, "v5.env");
    writeFileSync(envFile, Object.entries(values).filter(([,v]) => v !== undefined)
      .map(([k,v]) => k + "=" + JSON.stringify(v)).join("\n") + "\n", { mode });
    const effect = path.join(dir, "installed");
    const observed = path.join(dir, "proof-observed.json");
    const lock = path.join(dir, "mutation.lock");
    const script = [
      "V5_DEPLOY_SOURCE_ONLY=1 source scripts/deploy-v5.sh",
      "set -e",
      "V5_ENV=" + JSON.stringify(envFile),
      "MODE=bootstrap",
      "trap 'release_production_mutation_lease >/dev/null 2>&1 || true' EXIT",
      "acquire_production_mutation_lease 3",
      "install_v5_slot_units() {",
      "  flock -n " + JSON.stringify(lock) + " true && exit 98",
      "  cp " + JSON.stringify(lock + ".admission-nonce.db") + " " + JSON.stringify(observed),
      "  : >" + JSON.stringify(effect),
      "  exit 0",
      "}",
      "bootstrap",
    ].join("\n");
    const out = spawnSync("bash", ["-c", script], {
      cwd: root, encoding: "utf8", timeout: 35_000,
      env: {
        PATH: bin + ":" + process.env.PATH, HOME: process.env.HOME,
        KL_HOST: "offline-bootstrap", ALLOW_ANY_BRANCH: "1",
        OC_V5_PRODUCTION_MUTATION_LOCK: lock,
        OC_V5_MUTATION_LEASE_TTL_SECONDS: "60",
        OC_BOOTSTRAP_CORRUPT_DIGEST: corruptDigest ? "1" : "0",
        OC_BOOTSTRAP_PHASE_LOG: path.join(dir, "phase.log"),
      },
    });
    const result = { status: out.status, error: out.error?.message, effects: existsSync(effect),
      proof: existsSync(observed) ? JSON.parse(readFileSync(observed,"utf8")) : null,
      stderr: out.stderr, stdout: out.stdout,
      phase: existsSync(path.join(dir,"phase.log")) ? readFileSync(path.join(dir,"phase.log"),"utf8") : "" };
    assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0, "real OS lease not released");
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test("official bootstrap reaches first effect after real root holder + PG admission + complete config", () => {
  const out = run();
  assert.equal(out.status, 0, out.stderr + "\n" + out.stdout);
  assert.equal(out.effects, true);
  assert.equal(out.proof.schema, 1);
  assert.match(out.proof.nonce, /^[0-9a-f]{32}$/);
  assert.match(out.proof.holderStart, /^[1-9][0-9]*$/);
  assert.equal(out.proof.database, "openclaude_test");
  assert.equal(out.proof.inRecovery, false);
});
for (const [name, changes] of [
  ["missing JWT", { COMMERCIAL_JWT_SECRET: undefined }],
  ["missing Redis", { REDIS_URL: undefined }],
  ["missing split control", { INTERNAL_CONTROL_PORT: undefined }],
  ["dangerous flag under dev shell", { NODE_ENV: "development", TURNSTILE_TEST_BYPASS: "1" }],
]) {
  test("official bootstrap rejects " + name + " before first install/rsync effect", () => {
    const out = run(changes);
    assert.notEqual(out.status, 0, out.stdout);
    assert.equal(out.effects, false);
    assert.match(out.stderr, /incomplete or invalid/);
  });
}
test("official bootstrap refuses non-root0600 env before admission/effects", () => {
  const out = run({}, 0o644);
  assert.notEqual(out.status, 0);
  assert.equal(out.effects, false);
  assert.match(out.phase, /V5 env must be root-owned 0600/);
});
test("official bootstrap rejects tampered transmitted bundle digest before first effect", () => {
  const out = run({}, 0o600, true);
  assert.notEqual(out.status, 0);
  assert.equal(out.effects, false);
  assert.match(out.stdout, /已取得.*production-mutation lease/);
  assert.match(out.stderr, /validator SHA-256 mismatch/);
  assert.ok(!out.stderr.includes(base.COMMERCIAL_JWT_SECRET));
});
