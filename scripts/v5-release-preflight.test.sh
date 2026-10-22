#!/usr/bin/env bash
# OCV5-581: scripts/lib/v5-release-preflight.sh (L0 departure preflight) and its selfhost wiring.
# Every check is driven red by a minimal fault and green by the same fixture repaired; each check
# must also leave its inputs untouched (the preflight is read-only).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/lib/v5-release-preflight.sh"
MASTER="$ROOT/scripts/v5-selfhost-master-release-lib.sh"
DEPLOY="$ROOT/scripts/deploy-v5-selfhost.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# shellcheck source=scripts/lib/v5-release-preflight.sh
source "$LIB"
# shellcheck source=scripts/lib/v5-selfhost-workspace-links.sh
source "$ROOT/scripts/lib/v5-selfhost-workspace-links.sh"
# shellcheck source=scripts/lib/v5-migration-ddl.sh
source "$ROOT/scripts/lib/v5-migration-ddl.sh"
# the cutover gate's own file classifier, extracted from the master release lib
eval "$(sed -n '/^classify_pending_migration_file() {/,/^}/p' "$MASTER")"
declare -F classify_pending_migration_file >/dev/null || { echo "cannot extract classify_pending_migration_file"; exit 1; }

expect() { # <name> <check> <want-status> [detail-regex]
  local name="$1" check="$2" want="$3" re="${4:-}" i got="" detail=""
  for i in "${!RPF_CHECK[@]}"; do
    [[ "${RPF_CHECK[$i]}" == "$check" ]] || continue
    got="${RPF_STATUS[$i]}"; detail="${RPF_DETAIL[$i]}"
  done
  if [[ "$got" == "$want" && ( -z "$re" || "$detail" =~ $re ) ]]; then ok "$name"; else bad "$name (got $got: $detail)"; fi
}
g() { git -C "$1" "${@:2}"; }
newrepo() { mkdir -p "$1" && g "$1" init -q && g "$1" config user.email t@t && g "$1" config user.name t; }

# ── source-pin ────────────────────────────────────────────────────────
R="$T/pin"; newrepo "$R"
echo a >"$R/f"; g "$R" add f; g "$R" commit -qm one; C1="$(g "$R" rev-parse HEAD)"
echo b >"$R/f"; g "$R" commit -qam two; C2="$(g "$R" rev-parse HEAD)"
rpf_reset; rpf_check_source_pin "$R" "$C2"; expect "source-pin green: HEAD = target" source-pin ok
rpf_reset; rpf_check_source_pin "$R" "$C1"; expect "source-pin red: HEAD moved after pin (seq556)" source-pin fail "≠ target"
rpf_reset; rpf_check_source_pin "$R" "$(printf '%040d' 0)"; expect "source-pin red: target not a commit" source-pin fail "not a commit"
rpf_reset; rpf_check_source_pin "$R" "abc"; expect "source-pin red: short sha" source-pin fail "40-hex"

# ── workspace-links ───────────────────────────────────────────────────
W="$T/ws"; mkdir -p "$W/packages/kernel" "$W/packages/app" "$W/node_modules/dep"
echo '{"workspaces":["packages/kernel","packages/app"]}' >"$W/package.json"
echo '{"name":"@openclaude/kernel","dependencies":{"dep":"1"}}' >"$W/packages/kernel/package.json"
echo '{"name":"app"}' >"$W/packages/app/package.json"
ln -s ../packages/app "$W/node_modules/app"
before="$(find "$W/node_modules" | sort)"
rpf_reset; rpf_check_workspace_links "$W" 0
expect "workspace-links red: @openclaude/kernel link missing (seq365 attempt 1)" workspace-links fail "node_modules/@openclaude/kernel"
[[ "$(find "$W/node_modules" | sort)" == "$before" ]] && ok "workspace-links strict check created nothing" || bad "workspace-links strict check wrote"
rpf_reset; rpf_check_workspace_links "$W" 1
expect "workspace-links warn: missing link repairable by ensure_node_modules" workspace-links warn "ensure_node_modules"
[[ "$(find "$W/node_modules" | sort)" == "$before" ]] && ok "workspace-links repairable check created nothing" || bad "workspace-links repairable check wrote"
mkdir -p "$W/node_modules/@openclaude"; ln -s ../../packages/app "$W/node_modules/@openclaude/kernel"
rpf_reset; rpf_check_workspace_links "$W" 1; expect "workspace-links red: link points elsewhere" workspace-links fail "不指向"
rm "$W/node_modules/@openclaude/kernel"; ln -s ../../packages/kernel "$W/node_modules/@openclaude/kernel"
rpf_reset; rpf_check_workspace_links "$W" 0; expect "workspace-links green: links resolve" workspace-links ok

# ── migrations ────────────────────────────────────────────────────────
M="$T/mig"; newrepo "$M"; MD="packages/commercial/src/db/migrations"
mkdir -p "$M/$MD" "$M/deploy/v5"
echo 'CREATE TABLE a (x int);' >"$M/$MD/0001_a.sql"
echo '{"requiredMigrations":["0001_a"]}' >"$M/deploy/v5/release-metadata.json"
g "$M" add -A; g "$M" commit -qm base; LIVE="$(g "$M" rev-parse HEAD)"
echo 'ALTER TABLE a ADD COLUMN y int;' >"$M/$MD/0002_b.sql"
g "$M" add -A; g "$M" commit -qm unlisted; UNLISTED="$(g "$M" rev-parse HEAD)"
echo '{"requiredMigrations":["0001_a","0002_b"]}' >"$M/deploy/v5/release-metadata.json"
g "$M" add -A; g "$M" commit -qm listed; LISTED="$(g "$M" rev-parse HEAD)"
echo 'ALTER TABLE a DROP COLUMN y;' >"$M/$MD/0003_c.sql"
echo '{"requiredMigrations":["0001_a","0002_b","0003_c"]}' >"$M/deploy/v5/release-metadata.json"
g "$M" add -A; g "$M" commit -qm breaking; BREAKING="$(g "$M" rev-parse HEAD)"
rpf_reset; rpf_check_migrations "$M" "$LIVE" "$LIVE"; expect "migrations green: no change since live" migrations ok "no migration changes"
rpf_reset; rpf_check_migrations "$M" "$LIVE" "$UNLISTED"; expect "migrations red: not in requiredMigrations" migrations fail "0002_b 未列入"
rpf_reset; rpf_check_migrations "$M" "$LIVE" "$LISTED"; expect "migrations green: listed, non-breaking" migrations ok "pass the cutover file rules"
rpf_reset; OC_V5_ALLOW_BREAKING_MIGRATION=0 rpf_check_migrations "$M" "$LIVE" "$BREAKING"
expect "migrations red: breaking DDL without approval (seq268)" migrations fail "破坏性 DDL"
rpf_reset; OC_V5_ALLOW_BREAKING_MIGRATION=1 rpf_check_migrations "$M" "$LIVE" "$BREAKING"
expect "migrations green: breaking DDL with OC_V5_ALLOW_BREAKING_MIGRATION=1" migrations ok
rpf_reset; rpf_check_migrations "$M" "" "$LISTED"; expect "migrations warn: no live sourceCommit" migrations warn
rpf_reset; rpf_check_migrations "$M" "$(printf 'f%039d' 0)" "$LISTED"; expect "migrations red: live commit unknown" migrations fail "not a commit"
[[ -z "$(g "$M" status --porcelain)" ]] && ok "migrations check left the repo clean" || bad "migrations check dirtied the repo"
left="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'oc-preflight-mig.*' -newer "$M/deploy/v5/release-metadata.json" 2>/dev/null | wc -l)"
[[ "$left" == 0 ]] && ok "migrations check removed its private temp dir" || bad "migrations check left $left temp dir(s)"

# ── disk ──────────────────────────────────────────────────────────────
mkdir -p "$T/ref/a" "$T/ref/b"; : >"$T/ref/a/f"
rpf_reset; rpf_check_disk 1 "$T/ref" "$T" "$T/does/not/exist/yet"
expect "disk green: one result per filesystem" disk ok
[[ "${#RPF_CHECK[@]}" == 1 ]] && ok "disk de-duplicates paths on the same filesystem" || bad "disk results ${#RPF_CHECK[@]}"
rpf_reset; rpf_check_disk $((1 << 50)) "" "$T"; expect "disk red: below the build gate threshold (11 trains)" disk fail "build gate threshold"
rpf_reset; RPF_INODE_FACTOR=1000000000000; rpf_check_disk 1 "$T/ref" "$T"; RPF_INODE_FACTOR=2
expect "disk red: free inodes below the peak estimate" disk fail "inodes"

# ── proof-db plumbing (decisions are in proofDbPreflight.test.mjs) ─────
rpf_reset; rpf_check_proof_db "$ROOT" gate-db ""; expect "proof-db red: no DSN configured" proof-db fail "no proof database DSN"
rpf_reset; rpf_check_proof_db "$ROOT" shared-db "postgres://u:p@10.9.9.9/x_test"
expect "proof-db red: non-loopback DSN refused before connecting" proof-db fail "not loopback"
out="$(rpf_report 2>&1)"; [[ "$out" != *"u:p@"* ]] && ok "proof-db report never echoes the DSN" || bad "DSN echoed"

rpf_reset; rpf_check_proof_db "$W" gate-db "postgres://u:p@127.0.0.1/x_test"
expect "proof-db warn: tree without pg yet (npm ci after L0 stays supported)" proof-db warn "pg not installed"
rpf_reset; rpf_check_proof_db "$W" shared-db "postgres://u:p@10.9.9.9/x_test"
expect "proof-db red: non-loopback DSN refused even in a tree without pg" proof-db fail "not loopback"

# Codex #992: the test-only probe override is never silent and a probe without a verdict refuses
rpf_reset; OC_V5_PREFLIGHT_PROOF_PROBE=/dev/null rpf_check_proof_db "$W" gate-db "postgres://u:p@10.9.9.9/x_test"
expect "proof-db red: replaced probe that prints nothing" proof-db fail "no usable verdict"
rpf_report >/dev/null && bad "report passed with a silent probe" || ok "report refuses a silent probe"
printf '%s\n' 'process.stdout.write("ok\tfake\n"); process.exit(3)' >"$T/rc3.mjs"
rpf_reset; OC_V5_PREFLIGHT_PROOF_PROBE="$T/rc3.mjs" rpf_check_proof_db "$W" gate-db "postgres://u:p@127.0.0.1/x_test"
expect "proof-db red: probe exits non-zero without a fail line" proof-db fail "rc=3"
printf '%s\n' 'process.stdout.write("ok\tfake\n")' >"$T/ok.mjs"
rpf_reset; OC_V5_PREFLIGHT_PROOF_PROBE="$T/ok.mjs" rpf_check_proof_db "$W" gate-db "postgres://u:p@127.0.0.1/x_test"
[[ "$(rpf_report)" == *"⚠ preflight proof-db: probe replaced by OC_V5_PREFLIGHT_PROOF_PROBE"* ]] \
  && ok "an overridden probe is always reported" || bad "override not reported"

# ── errexit: the deploy script runs under set -Eeuo pipefail ──────────
# Healthy and failing paths of every check must return to the caller (the result is the verdict,
# never an abort). Codex r1 P1: a no-match grep in the healthy workspace path aborted the train.
CLASSIFY="$(sed -n '/^classify_pending_migration_file() {/,/^}/p' "$MASTER")"
strict() { # <label> <snippet>
  local out
  out="$(bash -Eeuo pipefail -c "source '$LIB'; source '$ROOT/scripts/lib/v5-selfhost-workspace-links.sh'
    source '$ROOT/scripts/lib/v5-migration-ddl.sh'; $CLASSIFY
    rpf_reset; $2; rpf_report >/dev/null || true; echo REACHED" 2>&1)"
  if [[ "$out" == *REACHED* ]]; then ok "set -Eeuo pipefail survives: $1"; else bad "set -Eeuo pipefail aborted: $1 :: $(tail -n 2 <<<"$out")"; fi
}
strict "source-pin green" "rpf_check_source_pin '$R' '$C2'"
strict "source-pin red" "rpf_check_source_pin '$R' '$C1'"
strict "workspace-links green (no ✗ lines)" "rpf_check_workspace_links '$W' 0"
W2="$T/ws2"; cp -a "$W" "$W2"; rm "$W2/node_modules/@openclaude/kernel"
strict "workspace-links missing (strict)" "rpf_check_workspace_links '$W2' 0"
strict "workspace-links missing (repairable)" "rpf_check_workspace_links '$W2' 1"
strict "migrations no change" "rpf_check_migrations '$M' '$LIVE' '$LIVE'"
strict "migrations listed" "rpf_check_migrations '$M' '$LIVE' '$LISTED'"
strict "migrations breaking" "OC_V5_ALLOW_BREAKING_MIGRATION=0 rpf_check_migrations '$M' '$LIVE' '$BREAKING'"
strict "disk green" "rpf_check_disk 1 '$T/ref' '$T'"
strict "disk red" "rpf_check_disk $((1 << 50)) '' '$T'"
strict "proof-db without pg" "rpf_check_proof_db '$W' gate-db 'postgres://u:p@127.0.0.1/x_test'"
strict "proof-db non-loopback" "rpf_check_proof_db '$ROOT' shared-db 'postgres://u:p@10.9.9.9/x_test'"

# ── report / summary ──────────────────────────────────────────────────
rpf_reset; rpf_add ok a x; rpf_add warn b y
rpf_report >/dev/null && ok "report rc 0 with ok+warn" || bad "report rc with ok+warn"
rpf_add fail c z; rpf_report >/dev/null && bad "report rc 0 despite a failure" || ok "report rc 1 when any check failed"
[[ "$(rpf_summary)" == "a=ok+b=warn+c=fail" ]] && ok "summary token" || bad "summary $(rpf_summary)"
[[ "$(rpf_report)" == *"✗ preflight c: z"* ]] && ok "report prints every failed reason" || bad "report format"

# ── selfhost wiring ───────────────────────────────────────────────────
body="$(sed -n '/^cmd_deploy() {/,/^}/p' "$DEPLOY")"
line_of() { grep -n -- "$1" <<<"$body" | head -1 | cut -d: -f1; }
pf="$(line_of 'selfhost_release_preflight')"; begin="$(line_of '^    lease_train_begin "\$sha"')"
trailer="$(line_of 'assert_fix_trailers "\$sha"')"; build="$(line_of 'build_master_release "\$sha"')"
# 2026-10-22 18:4x: L0 ran before lease_train_begin, so its refusal was not a deploy-reported train
# failure and the worker re-dispatched the same target every ~30 s (117 trains in an hour).
if [[ -n "$pf" && -n "$begin" && -n "$trailer" && -n "$build" ]] && (( begin < pf && pf <= trailer && pf < build )); then
  ok "cmd_deploy runs L0 after lease_train_begin (refusal is deploy-reported) and before the build"
else
  bad "cmd_deploy wiring order begin=$begin pf=$pf trailer=$trailer build=$build"
fi
grep -q 'selfhost_release_preflight "${LEASE_TARGET_SHA:-$sha}"' <<<"$body" && ok "L0 gets the train's pinned target" || bad "L0 target"
grep -qE 'avail_kb < RPF_MIN_FREE_KB' "$MASTER" && ok "build disk gate and L0 share one threshold" || bad "disk threshold not shared"
wrap="$(sed -n '/^selfhost_release_preflight() {/,/^}/p' "$MASTER")"
for c in rpf_check_source_pin rpf_check_workspace_links rpf_check_migrations rpf_check_proof_db rpf_check_disk; do
  grep -q "$c" <<<"$wrap" && ok "selfhost L0 runs $c" || bad "selfhost L0 misses $c"
done
grep -q 'rpf_check_proof_db "$REPO_ROOT" gate-db' <<<"$wrap" && ok "selfhost probes in gate-db mode" || bad "proof-db mode"
# read-only: the wrapper and the lib take no lock, lease, marker or chmod
code="$( { cat "$LIB"; printf '%s\n' "$wrap"; } | grep -vE '^[[:space:]]*#')"
if grep -qE '\b(flock|chmod|chown|lease_tx|lease_sql|lease_train_[a-z_]+|systemctl|psql)\b' <<<"$code"; then
  bad "preflight contains a write primitive"
else
  ok "preflight lib and wrapper contain no lock/lease/chmod/systemctl"
fi

echo "# pass=$PASS fail=$FAIL"
(( FAIL == 0 ))
