import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = readFileSync(path.join(root, "scripts/deploy-v5-selfhost.sh"), "utf8");
function fn(name: string): string {
  const start = source.indexOf("\n" + name + "() {");
  assert.notEqual(start, -1, name);
  const end = source.indexOf("\n}", start) + 2;
  return source.slice(start, end);
}
const common = [
  "set -euo pipefail",
  "V5_EGRESS_SLOT_SERVICE_TPL=egress@.service",
  "V5_EGRESS_SLOT_SOCKET_TPL=egress@.socket",
  "V5_EGRESS_PORT=48159; V5_EGRESS_BIND=127.0.0.1",
  fn("egress_slot_unit"), fn("egress_slot_is_active"),
  fn("egress_stop_slot"), fn("egress_shared_listener_count"),
  fn("egress_wait_single_listener"), fn("egress_probe_shared_health"),
  'egress_listener_diagnostics() { echo "DIAGNOSTICS" >&2; }',
].join("\n");
function run(script: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ocv5-159-"));
  try {
    writeFileSync(path.join(dir, "counter"), "0");
    const result = spawnSync("bash", ["-c", common + "\n" + script], {
      cwd: root, encoding: "utf8", timeout: 15000,
      env: { ...process.env, ...env, TEST_DIR: dir, TMPDIR: dir },
    });
    return { ...result, calls: (() => {
      try { return readFileSync(path.join(dir, "calls"), "utf8"); } catch { return ""; }
    })() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("OCV5-159 stops the socket in a separate blocking transaction before service drain", () => {
  for (const mode of ["async", "wait"]) {
    const r = run('systemctl() { echo "$*" >> "$TEST_DIR/calls"; }; egress_stop_slot A ' + mode);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, "stop egress@A.socket\nstop " + (mode === "async" ? "--no-block " : "") + "egress@A.service\n");
  }
  const r = run('systemctl() { echo "$*" >> "$TEST_DIR/calls"; return 5; }; egress_stop_slot B async');
  assert.equal(r.status, 1);
  assert.equal(r.calls, "stop egress@B.socket\n", "failed socket stop must not start drain");
});

const convergence = String.raw`
systemctl() { printf "%s\n" "$TARGET_STATE"; }
sleep() { :; }
ss() {
  local i
  i=$(<"$TEST_DIR/counter")
  echo $((i+1)) > "$TEST_DIR/counter"
  echo "ss $*" >> "$TEST_DIR/calls"
  if [[ "$SS_FAIL" == 1 ]]; then return 2; fi
  local n="$COUNT"
  if [[ "$COUNT" == converge && "$i" -lt 2 ]]; then n=2; elif [[ "$COUNT" == converge ]]; then n=1; fi
  for ((j=0;j<n;j++)); do
    echo "LISTEN 0 511 127.0.0.1:48159 0.0.0.0:*"
  done
}
egress_wait_single_listener B
`;
test("OCV5-159 waits for actual kernel listener 2 to 1 convergence after asynchronous SIGTERM", () => {
  const r = run(convergence, { COUNT: "converge", TARGET_STATE: "active", SS_FAIL: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.trim().split("\n").length, 3);
  assert.match(r.stderr, /listener=1 target=B/);
});
test("OCV5-159 listener convergence fails closed on zero, stale duplicates, inactive new slot or ss error", () => {
  for (const [COUNT, TARGET_STATE, SS_FAIL] of [["0", "active", "0"], ["2", "active", "0"], ["1", "inactive", "0"], ["1", "active", "1"]]) {
    const r = run(convergence, { COUNT, TARGET_STATE, SS_FAIL });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /DIAGNOSTICS/);
    assert.ok(r.calls.trim().split("\n").length <= 50);
  }
});
test("OCV5-159 counts kernel sockets rather than duplicated node and systemd holders", () => {
  const r = run(String.raw`
ss() { echo "LISTEN 0 511 127.0.0.1:48159 0.0.0.0:* users:((node,pid=22,fd=3),(systemd,pid=1,fd=201))"; }
egress_shared_listener_count
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1");
});

const probe = String.raw`
curl() {
  echo "$*" >> "$TEST_DIR/calls"
  local out="" prev="" arg
  for arg; do if [[ "$prev" == -o ]]; then out="$arg"; fi; prev="$arg"; done
  printf "%s" "$BODY" > "$out"
  printf "http=%s elapsed=5.001s bytes=0" "$HTTP"
  printf "%s" "$CURL_ERROR" >&2
  return "$CURL_RC"
}
egress_probe_shared_health
`;
test("OCV5-159 single shared health probe preserves timeout diagnostics instead of retrying", () => {
  const r = run(probe, { BODY: "", HTTP: "000", CURL_RC: "28", CURL_ERROR: "Operation timed out with 0 bytes received" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /curl_rc=28 http=000 elapsed=5.001s/);
  assert.match(r.stderr, /Operation timed out with 0 bytes received/);
  assert.match(r.stderr, /DIAGNOSTICS/);
  assert.equal(r.calls.trim().split("\n").length, 1);
  assert.match(r.calls, /--max-time 5/);
  assert.match(r.calls, /127.0.0.1:48159\/internal\/v5\/egress-health/);
});
test("OCV5-159 health probe rejects refused, HTTP errors and non-ok JSON with bounded diagnostics", () => {
  for (const [CURL_RC, HTTP, BODY] of [["7", "000", ""], ["22", "503", ""], ["0", "200", "not-json"], ["0", "200", '{"ok":false}']]) {
    const r = run(probe, { BODY, HTTP, CURL_RC, CURL_ERROR: "x".repeat(1000) });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.length < 1000);
    assert.equal(r.calls.trim().split("\n").length, 1);
  }
});
test("OCV5-159 shared healthy result remains unpolluted JSON", () => {
  const BODY = '{"ok":true,"slot":"B","listenMode":"sd_activation"}';
  const r = run(probe, { BODY, HTTP: "200", CURL_RC: "0", CURL_ERROR: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), BODY);
  assert.equal(r.stderr, "");
});

test("OCV5-159 unit and all slot cleanup branches use listener-first ordering", () => {
  const unit = readFileSync(path.join(root, "deploy/v5-selfhost/openclaude-v5-selfhost-egress@.service"), "utf8");
  assert.match(unit, /^Wants=.*openclaude-v5-selfhost-egress@%i.socket$/m);
  assert.doesNotMatch(unit, /^Requires=.*egress@%i.socket/m);
  assert.match(unit, /^After=.*egress@%i.socket$/m);
  const flip = fn("egress_slot_flip");
  assert.ok(flip.indexOf('egress_wait_slot_ready "$target"') < flip.indexOf('egress_stop_slot "$cur" async'));
  assert.match(flip, /egress_stop_slot "\$older" wait/);
  assert.equal((flip.match(/egress_stop_slot "\$target" wait/g) || []).length, 2);
  assert.doesNotMatch(flip, /systemctl stop.*"\$new_sock".*"\$new_svc"/);
  assert.match(flip, /egress_wait_single_listener "\$target"/);
  assert.match(fn("cutover_smoke_against_release"), /egress_shared_listener_count/);
  assert.match(fn("cutover_smoke_against_release"), /egress_probe_shared_health/);
  assert.match(fn("cutover_smoke_healthz_only"), /egress_probe_shared_health/);
});

const flipMocks = String.raw`
V5_EGRESS_UNIT=legacy.service
V5_EGRESS_SLOT_A_PORT=48160; V5_EGRESS_SLOT_B_PORT=48161
echo active > "$TEST_DIR/egress@A.service"
echo inactive > "$TEST_DIR/egress@B.service"
echo active > "$TEST_DIR/egress@A.socket"
echo inactive > "$TEST_DIR/egress@B.socket"
systemctl() {
  echo "$*" >> "$TEST_DIR/calls"
  local action="$1" unit=""
  shift
  for unit; do :; done
  case "$action" in
    is-active) if [[ -f "$TEST_DIR/$unit" ]]; then cat "$TEST_DIR/$unit"; else echo inactive; fi ;;
    start) echo active > "$TEST_DIR/$unit" ;;
    stop) echo inactive > "$TEST_DIR/$unit" ;;
  esac
}
sysctl() { echo 1; }
egress_live_release_has_slots() { return 0; }
egress_wait_slot_ready() { echo "ready $1" >> "$TEST_DIR/calls"; [[ "$READY" == 1 ]]; }
egress_wait_shared_port() { return 0; }
egress_wait_single_listener() { echo "listener $1" >> "$TEST_DIR/calls"; return 0; }
tail() { :; }
`;
test("OCV5-159 flip executes readiness then socket close then async service drain", () => {
  const r = run(fn("egress_slot_private_port") + fn("egress_slot_flip") + "\n" + flipMocks + "\negress_slot_flip", { READY: "1" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.calls.trim().split("\n");
  const ready = lines.indexOf("ready B");
  const socket = lines.indexOf("stop egress@A.socket");
  const service = lines.indexOf("stop --no-block egress@A.service");
  const listener = lines.indexOf("listener B");
  assert.ok(ready >= 0 && ready < socket && socket < service && service < listener, r.calls);
});
test("OCV5-159 failed new readiness cleans its listener before service and keeps old slot running", () => {
  const r = run(fn("egress_slot_private_port") + fn("egress_slot_flip") + "\n" + flipMocks + "\negress_slot_flip", { READY: "0" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.calls, /stop egress@B.socket\nstop egress@B.service\n/);
  assert.doesNotMatch(r.calls, /stop .*egress@A/);
});
