import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// All filesystem, SQLite and flock operations are private. Never source deploy's top level.
const root = fileURLToPath(new URL("../../", import.meta.url));
const deploy = readFileSync(join(root, "scripts/deploy-v5-selfhost.sh"), "utf8");
const worker = readFileSync(join(root, "scripts/v5-lease-worker.sh"), "utf8");
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
function fn(src, name) {
  const match = src.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, name);
  return match[0];
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-prewarm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LC_ALL: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  for (const path of ["scripts/deploy-v5-selfhost.sh", "scripts/v5-selfhost-master-release-lib.sh", "scripts/v5-runtime-release-lib.sh", "scripts/lib/v5-selfhost-runtime-build.sh", "scripts/lib/v5-selfhost-prewarm.sh", "scripts/lib/assert-flavor.sh", "packages/commercial/agent-sandbox/runtime-src-excludes.txt"]) {
    put(path, readFileSync(join(root, path)));
  }
  put("packages/web-react/src/marker", "pinned-A");
  put("packages/protocol/src/marker", "protocol");
  put("packages/mcp-memory/src/marker", "mcp");
  put("deploy/v5/release-metadata.json", '{"runtimeCapabilities":["test-cap"]}');
  put("package.json", '{"workspaces":[]}'); put("package-lock.json", "{}");
  git("init", "-q"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  git("add", "."); git("commit", "-qm", "fixture");
  const sha = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/feat/v5-selfhost", sha);
  writeFileSync(join(dir, "bun"), "#!/bin/sh\necho 1.3.14\n"); chmodSync(join(dir, "bun"), 0o755);
  return { dir, repo, env, git, sha, put };
}
function run(f, body, extra = "") {
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", `
    SCRIPT_DIR=${q(join(root, "scripts"))}; REPO_ROOT=${q(f.repo)}; T=${q(f.dir)}; SHA=${q(f.sha)}
    source "$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"
    source "$SCRIPT_DIR/v5-runtime-release-lib.sh"
    source "$SCRIPT_DIR/lib/assert-flavor.sh"
    source "$SCRIPT_DIR/lib/v5-selfhost-prewarm.sh"
    source "$SCRIPT_DIR/lib/v5-selfhost-runtime-build.sh"
    export OC_V5_SELFHOST_PREWARM_CACHE="$T/cache"
    OC_HOTCFG_RELEASES_ROOT="$T/official"; OC_BUN_BIN="$T/bun"; V5_ENV="$T/env"
    MASTER_RELEASES_ROOT="$T/master"; MASTER_LIVE_LINK="$T/live"
    SELFHOST_DEPLOY_LOCK_DIR="$T/run"; SELFHOST_DEPLOY_LOCK="$T/run/deploy.lock"
    EXCLUDES="$REPO_ROOT/packages/commercial/agent-sandbox/runtime-src-excludes.txt"
    IMAGE=sha256:${"a".repeat(64)}; RUNTIME_IMAGE=fixture
    mkdir -p "$T/cache" "$T/run"; chmod 700 "$T/cache" "$T/run"; touch "$V5_ENV"
    log() { echo "$*" >&2; }; die() { echo "$*" >&2; exit 73; }
    timeout() { [[ "$1" == 20 ]]; shift; "$@"; }
    ${extra}
    ${body}
  `], { env: f.env, encoding: "utf8", timeout: 30000, detached: true });
  if (result.error && result.pid) {
    try { process.kill(-result.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  return result;
}
function ok(r) { assert.equal(r.status, 0, `${r.error || ""}\n${r.stdout}\n${r.stderr}`); return r.stdout.trim(); }
const db = `
  export OC_V5_LEASE_DB="$T/lease.db"
  sqlite3 "$OC_V5_LEASE_DB" 'CREATE TABLE train(resource TEXT,status TEXT); CREATE TABLE lease(resource TEXT,status TEXT);'
`;
const mode = `
  export OC_V5_LEASE_DB="$T/lease.db"
  DRY=0; MODE=prewarm-artifacts; INVOCATION_ID=fixture; LEASE_TARGET_SHA="$SHA"
  ${fn(deploy, "selfhost_lock_py")}
  systemctl() { [[ "$1" == show ]] && echo "$$"; }
  release_policy_context_present() { return 1; }
  master_gate_busy_reason() { :; }
  prewarm_budget_ok() { return 0; }
  trap prewarm_cleanup_invocation EXIT
`;
const runtimeFixture = `
  rel="$T/cache/runtime/rel-0123456789ab"; mkdir -p "$rel/packages/mcp-memory/dist"
  echo cli >"$rel/packages/mcp-memory/dist/oc-memory.cjs"
  echo mcp >"$rel/packages/mcp-memory/dist/oc-memory-mcp.cjs"
  oc_hotcfg_build_manifest "$rel" 1 "$SHA" 1.3.14 deps ccb test-cap >/dev/null
  prewarm_runtime_publish "$SHA" "$IMAGE" "$rel"
`;

test("read-only admission rejects every open state, pending/granted work and unreadable DB", (t) => {
  const f = fixture(t);
  ok(run(f, `${db}
    prewarm_idle_db "$OC_V5_LEASE_DB"
    for status in planned building recovery_required; do
      sqlite3 "$OC_V5_LEASE_DB" "INSERT INTO train VALUES('deploy:selfhost','$status');"
      if prewarm_idle_db "$OC_V5_LEASE_DB"; then exit 1; fi
      sqlite3 "$OC_V5_LEASE_DB" 'DELETE FROM train;'
    done
    for status in registered granted; do
      sqlite3 "$OC_V5_LEASE_DB" "INSERT INTO lease VALUES('deploy:selfhost','$status');"
      if prewarm_idle_db "$OC_V5_LEASE_DB"; then exit 1; fi
      sqlite3 "$OC_V5_LEASE_DB" 'DELETE FROM lease;'
    done
    sqlite3 "$OC_V5_LEASE_DB" "INSERT INTO train VALUES('deploy:selfhost','committed'),('deploy:selfhost','failed');"
    prewarm_idle_db "$OC_V5_LEASE_DB"
    if prewarm_idle_db "$T/missing.db"; then exit 1; fi
    test ! -e "$T/missing.db"
    echo broken >"$T/broken.db"
    if prewarm_idle_db "$T/broken.db"; then exit 1; fi
  `));
});

test("real warm entry refuses active train and held deploy lock before invoking any builder", (t) => {
  const f = fixture(t);
  ok(run(f, `${db}${mode}
    build_runtime_release() { echo BAD >"$T/build"; }
    sqlite3 "$OC_V5_LEASE_DB" "INSERT INTO train VALUES('deploy:selfhost','building');"
    cmd_prewarm_artifacts; test ! -e "$T/build"
    sqlite3 "$OC_V5_LEASE_DB" 'DELETE FROM train;'
    ( exec 7<>"$SELFHOST_DEPLOY_LOCK"; flock 7; cmd_prewarm_artifacts )
    test ! -e "$T/build"; test ! -e "$T/cache/attempt.json"
  `));
});

test("runtime cache adopts only exact keys and full verified bytes; existing targets are reverified", (t) => {
  const f = fixture(t);
  ok(run(f, `${runtimeFixture}
    if prewarm_runtime_donor "$SHA" sha256:${"b".repeat(64)} test-cap; then exit 1; fi
    if prewarm_runtime_donor ${"c".repeat(40)} "$IMAGE" test-cap; then exit 1; fi
    if prewarm_runtime_donor "$SHA" "$IMAGE" wrong-cap; then exit 1; fi
    got="$(prewarm_runtime_donor "$SHA" "$IMAGE" test-cap)"
    test "$got" = "$T/official/rel-0123456789ab"; test ! -d "$rel"
    test "$(prewarm_runtime_donor "$SHA" "$IMAGE" test-cap)" = "$got"
    echo tampered >"$got/packages/mcp-memory/dist/oc-memory.cjs"
    if prewarm_runtime_donor "$SHA" "$IMAGE" test-cap; then exit 1; fi
  `));
});

test("corrupt or partial warm runtime cannot populate official releases", (t) => {
  const f = fixture(t);
  ok(run(f, `${runtimeFixture}
    echo changed >"$rel/packages/mcp-memory/dist/oc-memory-mcp.cjs"
    if prewarm_runtime_donor "$SHA" "$IMAGE" test-cap; then exit 1; fi
    test ! -e "$T/official"
    rm "$T/cache/runtime.json"
    if prewarm_runtime_donor "$SHA" "$IMAGE" test-cap; then exit 1; fi
    test ! -e "$T/official"
  `));
});

test("actual warm entry builds archived web A outside deploy lock, defers Docker deps and seals only cache", (t) => {
  const f = fixture(t);
  f.put("packages/web-react/src/marker", "dirty-B");
  ok(run(f, `${db}${mode}
    docker() { [[ "$1 $2" == 'image inspect' ]] || { echo BAD >"$T/docker-run"; return 1; }; echo "$IMAGE"; }
    # Actual runtime builder/archive calls its installer; warm mode must replace it with refusal.
    # Only the deploy-frame mint authorization is stubbed; archive and installer dispatch are real.
    write_flavor_manifest() { [[ "$2" == selfhost && "$3" == "$SHA" ]]; echo '{}' >"$1/flavor.manifest.json"; }
    oc_hotcfg_finalize_release() { touch "$T/finalizer-called"; oc_hotcfg_install_deps_in_image "$1" "$2"; }
    oc_hotcfg_install_deps_in_image() { echo BAD >"$T/docker-run"; }
    find_master_release_donor() { return 1; }
    npm() {
      ( exec 7<>"$SELFHOST_DEPLOY_LOCK"; flock -n 7 ) || return 1
      if [[ "$1" == ci ]]; then mkdir node_modules; return 0; fi
      [[ "$*" == 'run build --workspace packages/web-react' && "$NODE_OPTIONS" == --max-old-space-size=4096 ]] || return 1
      mkdir -p packages/web-react/dist
      echo '<meta name="oc-build" content="abcdef123456">' > packages/web-react/dist/index.html
      cp packages/web-react/src/marker packages/web-react/dist/pin.txt
    }
    rc=0; cmd_prewarm_artifacts || rc=$?
    test "$rc" = 73
    prewarm_cleanup_invocation "$rc" || :
    jq -e '.status == "partial" and .runtimeExitCode == 73 and .exitCode == 73 and .retryAfter > 0' "$T/cache/attempt.json" >/dev/null
    test -e "$T/finalizer-called"; test ! -e "$T/docker-run"; test ! -e "$T/official"; test ! -e "$T/master"
    key="$(master_web_dist_key "$SHA")"; bucket="$(find_web_dist_donor "$key")"
    test "$(cat "$bucket/packages/web-react/dist/pin.txt")" = pinned-A
    test ! -e "$bucket/node_modules"; test ! -e "$bucket/VERSION.json"
    # Still not a deployable candidate even if a caller points E1 at this cache bucket.
    if ( assert_master_release_static_gate "$bucket" "$SHA" ); then exit 1; fi
    echo corrupted >"$bucket/packages/web-react/dist/pin.txt"
    if find_web_dist_donor "$key"; then exit 1; fi
    # Rewriting the dist record does not repair the full seal.
    write_web_dist_reuse_record "$bucket" "$key" built "$SHA"
    if find_web_dist_donor "$key"; then exit 1; fi
  `));
});

test("quiesce waits for own prewarm process group including grandchildren; refuses unknown holder", (t) => {
  const f = fixture(t);
  const child = join(f.dir, "child.sh");
  writeFileSync(child, `#!/bin/bash\nexec 9<>"$1.prewarm"\nflock 9\nsleep 120 &\necho $! >"$2/grandchild"\ntouch "$2/ready"\nwait\n`);
  ok(run(f, `
    setsid bash ${q(child)} "$SELFHOST_DEPLOY_LOCK" "$T" & child=$!
    trap 'kill -KILL -- -"$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true' EXIT
    for _ in {1..100}; do test -f "$T/ready" && break; sleep .02; done
    test -f "$T/ready"
    systemctl() { [[ "$*" == "stop $(prewarm_unit "$SELFHOST_DEPLOY_LOCK").service" ]] || return 1; kill -TERM -- -"$child"; }
    exec 8<>"$SELFHOST_DEPLOY_LOCK"; flock 8
    prewarm_quiesce "$SELFHOST_DEPLOY_LOCK"
    wait "$child" 2>/dev/null || true
    ( exec 7<>"$SELFHOST_DEPLOY_LOCK.prewarm"; flock -n 7 )
    # A late warmer acquires the guard but cannot pass the still-held official lock.
    ( exec 7<>"$SELFHOST_DEPLOY_LOCK.prewarm"; flock -n 7; exec 6<>"$SELFHOST_DEPLOY_LOCK"; ! flock -n 6 )
    rm "$T/ready"; setsid bash ${q(child)} "$SELFHOST_DEPLOY_LOCK" "$T" & child=$!
    for _ in {1..100}; do test -f "$T/ready" && break; sleep .02; done
    systemctl() { return 1; }
    if prewarm_quiesce "$SELFHOST_DEPLOY_LOCK"; then exit 1; fi
  `));
});

test("idle tick launches nice bounded cgroup for pushed tip, never on read failure or completed attempt", (t) => {
  const f = fixture(t);
  ok(run(f, `${db}
    DRY=0; INVOCATION_ID=fixture; LEASE_BRANCH=feat/v5-selfhost; LEASE_DB="$OC_V5_LEASE_DB"
    LEASE_REPO_ROOT="$REPO_ROOT"; LEASE_DEPLOY_LOCK="$SELFHOST_DEPLOY_LOCK"; DEPLOY_BIN=fixture-deploy
    lease_release_policy_held() { return 1; }; lease_in_cutover_grace() { return 1; }; lease_deploy_process_running() { return 1; }
    lease_remote_tip() { echo "$SHA"; }; git() { [[ "$*" == *'fetch -q origin feat/v5-selfhost' ]]; }
    systemd-run() { printf '%s\n' "$@" >"$T/spawn"; }
    prewarm_idle_tick
    grep -qx -- '--property=Nice=15' "$T/spawn"
    grep -qx -- '--property=KillMode=control-group' "$T/spawn"
    grep -qx -- '--property=RuntimeMaxSec=20min' "$T/spawn"
    grep -qx -- "--target-sha=$SHA" "$T/spawn"
    rm "$T/spawn"
    prewarm_attempt_begin "$T/cache" "$SHA"
    PREWARM_RUNTIME_STATUS=ready; PREWARM_WEB_STATUS=ready
    prewarm_cleanup_invocation 0
    prewarm_idle_tick; test ! -e "$T/spawn"
    rm "$T/cache/attempt.json"; mv "$LEASE_DB" "$T/old.db"; prewarm_idle_tick; test ! -e "$T/spawn"
  `));
});

test("disk/inode measurements fail closed and recipes cannot warm a different driver", (t) => {
  const f = fixture(t);
  ok(run(f, `
    prewarm_budget_ok 0 0 "$T"
    if prewarm_budget_ok 999999999999 0 "$T"; then exit 1; fi
    if prewarm_budget_ok 0 999999999999 "$T"; then exit 1; fi
    if prewarm_budget_ok 0 0 "$T/missing"; then exit 1; fi
    prewarm_recipe_matches "$SHA"
    echo changed >>"$REPO_ROOT/scripts/lib/v5-selfhost-prewarm.sh"
    if prewarm_recipe_matches "$SHA"; then exit 1; fi
  `));
});

test("production dispatch cannot insert planned train if prewarm quiescence fails", (t) => {
  const f = fixture(t);
  ok(run(f, `
    RESOURCE=deploy:selfhost; LEASE_DEPLOY_LOCK="$SELFHOST_DEPLOY_LOCK"; LEASE_REPO_ROOT="$REPO_ROOT"; LEASE_BRANCH=feat/v5-selfhost
    lease_release_policy_held() { return 1; }; lease_deploy_process_running() { return 1; }; lease_in_cutover_grace() { return 1; }
    lease_remote_tip() { echo "$SHA"; }; lease_sha_contained() { return 0; }; lease_q() { printf %s "$1"; }
    lease_sql() { case "$*" in *'COUNT(*)'*) echo 1;; *'SELECT want_sha'*) echo "$SHA";; esac; }
    lease_tx() { echo BAD >"$T/planned"; }; prewarm_quiesce() { return 1; }; wlog() { :; }
    ${fn(worker, "dispatch_train")}
    dispatch_train
    test ! -e "$T/planned"
    ( exec 7<>"$SELFHOST_DEPLOY_LOCK"; flock -n 7 )
  `));
});


test("budget watchdog cancels its own job before a partial artifact can be published", (t) => {
  const f = fixture(t);
  const r = run(f, `${db}${mode}
    prewarm_budget_ok() { test ! -f "$T/build-started"; }
    systemctl() {
      if [[ "$1" == show ]]; then echo "$$"; return 0; fi
      [[ "$*" == "kill --signal=KILL --kill-whom=all $(prewarm_unit "$SELFHOST_DEPLOY_LOCK").service" ]] || return 1
      echo cancelled >"$T/cancelled"
      kill -KILL -- -"$$"
    }
    docker() { echo "$IMAGE"; }
    build_runtime_release() { touch "$T/build-started"; sleep 120 & wait; }
    cmd_prewarm_artifacts
    echo BAD >"$T/published"
  `);
  assert.equal(r.signal, "SIGKILL", `${r.stdout}\n${r.stderr}`);
  assert.equal(readFileSync(join(f.dir, "cancelled"), "utf8").trim(), "cancelled");
  assert.equal(existsSync(join(f.dir, "cache/runtime.json")), false);
  assert.equal(existsSync(join(f.dir, "published")), false);
  const attempt = JSON.parse(readFileSync(join(f.dir, "cache/attempt.json"), "utf8"));
  assert.equal(attempt.status, "running");
  assert.equal(attempt.attempt, 1);
  assert.equal(attempt.exitCode, null);
  assert.ok(attempt.retryAfter > attempt.startedAt);
});

test("ordinary runtime builder consumes warm evidence without executing the cold finalizer", (t) => {
  const f = fixture(t);
  ok(run(f, `${runtimeFixture}
    DRY=0
    docker() { [[ "$1 $2" == 'image inspect' ]]; echo "$IMAGE"; }
    oc_hotcfg_finalize_release() { echo BAD >"$T/cold"; return 1; }
    build_runtime_release "$SHA"
    test "$BUILT_RUNTIME_RELEASE" = "$T/official/rel-0123456789ab"
    test ! -e "$T/cold"
  `));
});

const webBuild = `
  find_master_release_donor() { return 1; }
  npm() {
    if [[ "$1" == ci ]]; then mkdir node_modules; return 0; fi
    mkdir -p packages/web-react/dist
    echo '<meta name="oc-build" content="abcdef123456">' > packages/web-react/dist/index.html
    cp packages/web-react/src/marker packages/web-react/dist/pin.txt
  }
`;
const webFixture = `
  key="$(master_web_dist_key "$SHA")"; bucket="$T/cache/web-$key"
  mkdir -p "$bucket/packages/web-react/dist" "$T/staging/packages/web-react"
  echo '<meta name="oc-build" content="abcdef123456">' > "$bucket/packages/web-react/dist/index.html"
  echo original > "$bucket/packages/web-react/dist/pin.txt"
  write_web_dist_reuse_record "$bucket" "$key" built "$SHA"
  digest="$(release_artifact_digest "$bucket")"
  jq -n --arg sha "$SHA" --arg digest "$digest" \
    '{schemaVersion:2,sourceCommit:$sha,artifactSha256:$digest}' > "$bucket/.complete"
`;

test("retry accounting bounds failures and interrupted attempts, cools down, and resets only for a new SHA", (t) => {
  const f = fixture(t);
  ok(run(f, `
    test_epoch=1000; date() { [[ "$*" == +%s ]]; echo "$test_epoch"; }
    test "$(prewarm_attempt_next "$T/cache" "$SHA")" = 1
    prewarm_attempt_begin "$T/cache" "$SHA"
    jq -e '.attempt == 1 and .status == "running" and .exitCode == null and .retryAfter == 2800' "$T/cache/attempt.json"
    if prewarm_attempt_next "$T/cache" "$SHA"; then exit 1; fi
    PREWARM_RUNTIME_STATUS=failed; PREWARM_RUNTIME_RC=47
    rc=0; prewarm_cleanup_invocation 47 || rc=$?; test "$rc" = 47
    jq -e '.status == "failed" and .exitCode == 47 and .runtimeExitCode == 47' "$T/cache/attempt.json"
    test_epoch=2799; if prewarm_attempt_next "$T/cache" "$SHA"; then exit 1; fi
    test_epoch=2800; prewarm_attempt_begin "$T/cache" "$SHA"
    jq -e '.attempt == 2 and .retryAfter == 6400' "$T/cache/attempt.json"
    # No finish: model a SIGKILL/restart. Durable running still counts as an attempt.
    test_epoch=6400; prewarm_attempt_begin "$T/cache" "$SHA"
    test_epoch=999999; if prewarm_attempt_next "$T/cache" "$SHA"; then exit 1; fi
    test "$(prewarm_attempt_next "$T/cache" ${"b".repeat(40)})" = 1
    prewarm_cleanup_invocation 9 || :
    prewarm_attempt_begin "$T/cache" ${"b".repeat(40)}
    PREWARM_RUNTIME_STATUS=ready; PREWARM_WEB_STATUS=ready; prewarm_cleanup_invocation 0
    if prewarm_attempt_next "$T/cache" ${"b".repeat(40)}; then exit 1; fi
    jq -e '.attempt == 1 and .status == "ready" and .exitCode == 0' "$T/cache/attempt.json"
    # A legacy record upgrades once; malformed schema-2 state never resets the budget.
    jq -n --arg sha "$SHA" '{sha:$sha,done:true}' > "$T/cache/attempt.json"
    test "$(prewarm_attempt_next "$T/cache" "$SHA")" = 1
    for json in '{' '[]' '{"schema":2}' '{"schema":2,"sha":"${"b".repeat(40)}","attempt":-1}' '{} {}'; do
      echo "$json" > "$T/cache/attempt.json"
      if prewarm_attempt_next "$T/cache" "$SHA"; then exit 1; fi
    done
    rm "$T/cache/attempt.json"; ln -s "$T/missing" "$T/cache/attempt.json"
    if prewarm_attempt_next "$T/cache" "$SHA"; then exit 1; fi
  `));
});

test("service admission rechecks retry budget, post-lock DB/policy and failed host probes before any build", (t) => {
  for (const refusal of [
    'master_gate_busy_reason() { return 41; }',
    'master_gate_busy_reason() { echo busy; }',
    'release_policy_context_present() { return 0; }',
    'prewarm_idle_db() { if [[ -e "$T/db-seen" ]]; then return 1; fi; touch "$T/db-seen"; }',
    'prewarm_attempt_begin "$T/cache" "$SHA"; PREWARM_ATTEMPT_CACHE=""',
    'prewarm_attempt_begin "$T/cache" "$SHA"; PREWARM_ATTEMPT=3; PREWARM_RETRY_AFTER=0; prewarm_attempt_save failed 8; PREWARM_ATTEMPT_CACHE=""',
  ]) {
    const f = fixture(t);
    ok(run(f, `${db}${mode}
      build_runtime_release() { touch "$T/build"; }
      ${refusal}
      before="$(cat "$T/cache/attempt.json" 2>/dev/null || true)"
      cmd_prewarm_artifacts
      test ! -e "$T/build"; test ! -e "$T/cache/.work"
      test "$(cat "$T/cache/attempt.json" 2>/dev/null || true)" = "$before"
    `));
  }
});

test("failed runtime builder cannot publish; web success keeps real failure and EXIT removes partial files", (t) => {
  const f = fixture(t);
  const r = run(f, `${db}${mode}${webBuild}
    docker() { echo "$IMAGE"; }
    build_runtime_release() { mkdir -p "$OC_HOTCFG_RELEASES_ROOT/.staging-failed"; touch "$OC_HOTCFG_RELEASES_ROOT/.staging-failed/partial"; return 47; }
    prewarm_runtime_publish() { echo BAD > "$T/publish-after-failure"; }
    cmd_prewarm_artifacts
  `);
  assert.equal(r.status, 47, r.stderr);
  const record = JSON.parse(readFileSync(join(f.dir, "cache/attempt.json"), "utf8"));
  assert.equal(record.status, "partial");
  assert.equal(record.runtimeExitCode, 47);
  assert.equal(record.exitCode, 47);
  assert.equal(record.web, "ready");
  for (const path of ["cache/runtime", "cache/runtime.json", "cache/.work", "publish-after-failure", "official"]) {
    assert.equal(existsSync(join(f.dir, path)), false, path);
  }
});

test("web failure retains verified private runtime; next admitted attempt reuses it and reports ready", (t) => {
  const f = fixture(t);
  const setup = `${mode}
    docker() { echo "$IMAGE"; }
    build_runtime_release() { echo BAD > "$T/rebuilt"; return 49; }
  `;
  const r = run(f, `${db}${setup}${runtimeFixture}
    find_master_release_donor() { return 1; }
    npm() { return 61; }
    cmd_prewarm_artifacts
  `);
  assert.equal(r.status, 73, r.stderr);
  const statePath = join(f.dir, "cache/attempt.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.status, "partial");
  assert.equal(state.runtime, "ready");
  assert.equal(state.exitCode, 73);
  assert.equal(existsSync(join(f.dir, "cache/.work")), false);
  assert.equal(existsSync(join(f.dir, "cache/runtime.json")), true);
  // Advance only the fixture's retry deadline; production uses real elapsed time.
  writeFileSync(statePath, JSON.stringify({ ...state, retryAfter: 0 }));
  const retry = run(f, `${setup}${webBuild} cmd_prewarm_artifacts`);
  ok(retry);
  const ready = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(ready.status, "ready", retry.stderr);
  assert.equal(ready.attempt, 2);
  assert.equal(ready.exitCode, 0);
  assert.equal(existsSync(join(f.dir, "rebuilt")), false);
  assert.equal(existsSync(join(f.dir, "official")), false);
  assert.equal(existsSync(join(f.dir, "cache/.work")), false);
});

test("runtime publication validates source, capability, manifest and MCP before minting a receipt", (t) => {
  const f = fixture(t);
  ok(run(f, `${runtimeFixture}
    rm "$T/cache/runtime.json"
    cp "$rel/MANIFEST.json" "$T/original-manifest"
    for field in sourceCommit capabilities; do
      jq --arg field "$field" 'if $field == "sourceCommit" then .sourceCommit = "${"b".repeat(40)}" else .capabilities = ["wrong"] end' "$T/original-manifest" > "$rel/MANIFEST.json"
      if prewarm_runtime_publish "$SHA" "$IMAGE" "$rel"; then exit 1; fi
      test ! -e "$T/cache/runtime.json"
    done
    cp "$T/original-manifest" "$rel/MANIFEST.json"
    echo changed > "$rel/packages/mcp-memory/dist/oc-memory.cjs"
    if prewarm_runtime_publish "$SHA" "$IMAGE" "$rel"; then exit 1; fi
    test ! -e "$T/cache/runtime.json"
    rm "$rel/packages/mcp-memory/dist/oc-memory.cjs"
    oc_hotcfg_build_manifest "$rel" 1 "$SHA" 1.3.14 deps ccb test-cap >/dev/null
    if prewarm_runtime_publish "$SHA" "$IMAGE" "$rel"; then exit 1; fi
    test ! -e "$T/cache/runtime.json"
  `));
});

test("runtime and web reject digest commands that print the expected digest but fail", (t) => {
  const f = fixture(t);
  ok(run(f, `${runtimeFixture}${webFixture}
    expected="$(jq -r .artifactSha256 "$T/cache/runtime.json")"
    original_digest="$(declare -f release_artifact_digest)"
    release_artifact_digest() { echo "$expected"; return 44; }
    if prewarm_runtime_donor "$SHA" "$IMAGE" test-cap; then exit 1; fi
    test ! -e "$T/official"
    eval "$original_digest"
    expected="$(jq -r .distDigest "$bucket/$WEB_DIST_REUSE_RECORD")"
    web_dist_digest() { echo "$expected"; return 44; }
    if prewarm_web_donor "$key"; then exit 1; fi
    if copy_verified_web_dist "$bucket" "$T/staging"; then exit 1; fi
    # Empty digest record + failed empty digest used to pass a string-only comparison.
    jq '.distDigest = ""' "$bucket/$WEB_DIST_REUSE_RECORD" > "$T/record"
    mv "$T/record" "$bucket/$WEB_DIST_REUSE_RECORD"
    digest="$(release_artifact_digest "$bucket")"
    jq --arg digest "$digest" '.artifactSha256=$digest' "$bucket/.complete" > "$T/seal"
    mv "$T/seal" "$bucket/.complete"
    web_dist_digest() { return 44; }
    if prewarm_web_donor "$key"; then exit 1; fi
  `));
});

test("web copy rejects corruption and donor mutation after lookup using frozen verified evidence", (t) => {
  const f = fixture(t);
  ok(run(f, `${webFixture}
    test "$(prewarm_web_donor "$key")" = "$bucket"
    cp() { command cp "$@"; echo corrupted > "$T/staging/packages/web-react/dist/pin.txt"; }
    if copy_verified_web_dist "$bucket" "$T/staging"; then exit 1; fi
    rm -rf "$T/staging/packages/web-react/dist"
    cp() {
      echo mutated > "$bucket/packages/web-react/dist/pin.txt"
      write_web_dist_reuse_record "$bucket" "$key" built "$SHA"
      command cp "$@"
    }
    if copy_verified_web_dist "$bucket" "$T/staging"; then exit 1; fi
    rm -rf "$T/staging/packages/web-react/dist"; unset -f cp
    # A donor changed between lookup and copy is rejected by the full seal before copying.
    if copy_verified_web_dist "$bucket" "$T/staging"; then exit 1; fi
    test ! -e "$T/staging/packages/web-react/dist"
  `));
});
