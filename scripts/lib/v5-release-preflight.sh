# shellcheck shell=bash
# OCV5-581 (release reliability P0-1): read-only L0 departure preflight.
#
# A release is a chain of gates run in order; a host precondition that is already broken
# (workspace link missing, proof database cannot provide pgcrypto, unregistered or breaking
# migration, disk too small) used to surface only when the train reached that gate, 5–25 minutes
# in, and only one at a time. L0 runs every such check before anything is built and reports all
# failures together. It does not replace any gate: the build/cutover gates still run unchanged.
#
# Read-only by construction:
#   - no database, schema, role, extension or table is created; the PG probe runs one
#     BEGIN READ ONLY transaction against the catalog and rolls it back;
#   - no chmod/chown, no lock, lease, marker, queue or train row is written;
#   - the only files written are a private mktemp directory (git show of the target's migration
#     files for the DDL detector), removed before returning;
#   - workspace links are checked with ws_links_ensure under DRY=1 (prints, changes nothing).
# Secrets: the proof DSN is passed to the probe through the environment only, never argv, and the
# probe never prints it.
#
# Usage (sourced): rpf_reset; rpf_check_* ...; rpf_report  → rc 1 when any check failed.
# Callers run under set -Eeuo pipefail: every pipeline here that may legitimately find nothing
# ends in `|| true`, so a healthy result never aborts the caller.
# Each result is one line: "  ✓|⚠|✗ preflight <check>: <detail>".

# shellcheck disable=SC2034  # read by callers (assert_master_releases_disk, selfhost_release_preflight)
RPF_MIN_FREE_KB=$((8 * 1024 * 1024))   # same threshold as the build gate (assert_master_releases_disk)
RPF_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPF_INODE_FACTOR=2                      # staging + runtime copy of the live release, worst case
RPF_STATUS=()
RPF_CHECK=()
RPF_DETAIL=()

rpf_reset() { RPF_STATUS=(); RPF_CHECK=(); RPF_DETAIL=(); }

rpf_add() { # <ok|warn|fail> <check> <detail>
  RPF_STATUS+=("$1"); RPF_CHECK+=("$2"); RPF_DETAIL+=("$3")
}

rpf_failed() { # → rc 0 when at least one check failed
  local s
  for s in "${RPF_STATUS[@]}"; do [[ "$s" == fail ]] && return 0; done
  return 1
}

rpf_report() { # prints every result; rc 1 when any failed
  local i mark
  for i in "${!RPF_STATUS[@]}"; do
    case "${RPF_STATUS[$i]}" in ok) mark="✓" ;; warn) mark="⚠" ;; *) mark="✗" ;; esac
    printf '  %s preflight %s: %s\n' "$mark" "${RPF_CHECK[$i]}" "${RPF_DETAIL[$i]}"
  done
  ! rpf_failed
}

rpf_summary() { # one token per result for the train summary (tsum_clean keeps [A-Za-z0-9._:/@+=-])
  local i out=()
  for i in "${!RPF_STATUS[@]}"; do out+=("${RPF_CHECK[$i]}=${RPF_STATUS[$i]}"); done
  local IFS=+
  printf '%s' "${out[*]}"
}

# Pinned source: the tree the gates will read must be exactly the target commit.
rpf_check_source_pin() { # <repo> <target-sha>
  local repo="$1" want="$2" head
  if [[ ! "$want" =~ ^[0-9a-f]{40}$ ]]; then
    rpf_add fail source-pin "target is not a 40-hex sha: ${want:-<empty>}"; return 0
  fi
  if ! git -C "$repo" cat-file -e "${want}^{commit}" 2>/dev/null; then
    rpf_add fail source-pin "target ${want:0:12} is not a commit in $repo"; return 0
  fi
  head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$head" != "$want" ]]; then
    rpf_add fail source-pin "$repo HEAD ${head:0:12} ≠ target ${want:0:12} (the shared tree moved after pinning)"
    return 0
  fi
  rpf_add ok source-pin "HEAD = target ${want:0:12}"
}

# Workspace links: node_modules/<workspace> must resolve to that workspace (realpath ENOENT on
# @openclaude/kernel failed a commercial train on 2026-10-22). repairable=1 when the caller's own
# later step (selfhost ensure_node_modules) creates missing links; a wrong link is always a failure.
rpf_check_workspace_links() { # <repo> <repairable 0|1>
  local repo="$1" repairable="$2" out rc=0 planned bad
  if ! declare -F ws_links_ensure >/dev/null; then
    rpf_add fail workspace-links "ws_links_ensure not loaded (scripts/lib/v5-selfhost-workspace-links.sh)"; return 0
  fi
  if [[ ! -d "$repo/node_modules" ]]; then
    rpf_add warn workspace-links "$repo has no node_modules (a full npm ci runs first)"; return 0
  fi
  out="$(DRY=1 ws_links_ensure "$repo" 2>&1)" || rc=$?
  planned="$(grep -c '\[dry-run\] ln -s' <<<"$out" || true)"
  bad="$(grep '✗' <<<"$out" | sed 's/^ *✗ *//' | head -3 | paste -sd ';' - || true)"
  if [[ "$rc" != 0 || -n "$bad" ]]; then
    rpf_add fail workspace-links "${bad:-ws_links_ensure rc=$rc}"
  elif [[ "$planned" != 0 && "$repairable" != 1 ]]; then
    rpf_add fail workspace-links "$planned workspace link(s) missing: $(grep -o 'node_modules/[^ ]*' <<<"$out" | head -3 | paste -sd ' ' - || true)"
  elif [[ "$planned" != 0 ]]; then
    rpf_add warn workspace-links "$planned missing link(s) will be created by ensure_node_modules"
  else
    rpf_add ok workspace-links "all workspace links resolve"
  fi
}

# Migrations: the cutover migration gate's file rules (listed in requiredMigrations, no breaking
# DDL without OC_V5_ALLOW_BREAKING_MIGRATION=1), run by the gate's own classify function against a
# private copy of the target's files. The DB gap half of that gate stays in cutover.
rpf_check_migrations() { # <repo> <from-sha|""> <target-sha>
  local repo="$1" from="$2" to="$3" changed tmp f out errs=() n=0
  if ! declare -F classify_pending_migration_file >/dev/null; then
    rpf_add fail migrations "classify_pending_migration_file not loaded (master release lib)"; return 0
  fi
  if [[ ! "$from" =~ ^[0-9a-f]{40}$ ]]; then
    rpf_add warn migrations "no live sourceCommit to diff against; cutover gate decides"; return 0
  fi
  if ! git -C "$repo" cat-file -e "${from}^{commit}" 2>/dev/null; then
    rpf_add fail migrations "live sourceCommit ${from:0:12} is not a commit in $repo (cutover gate fails closed)"; return 0
  fi
  if ! changed="$(git -C "$repo" diff --name-only "$from" "$to" -- '**/migrations/**')"; then
    rpf_add fail migrations "git diff ${from:0:12}..${to:0:12} failed"; return 0
  fi
  if [[ -z "$changed" ]]; then
    rpf_add ok migrations "no migration changes since live ${from:0:12}"; return 0
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/oc-preflight-mig.XXXXXX")" || { rpf_add fail migrations "mktemp failed"; return 0; }
  mkdir -p "$tmp/deploy/v5"
  if ! git -C "$repo" show "$to:deploy/v5/release-metadata.json" >"$tmp/deploy/v5/release-metadata.json" 2>/dev/null; then
    rm -rf -- "$tmp"; rpf_add fail migrations "target has no deploy/v5/release-metadata.json"; return 0
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    n=$((n + 1))
    if git -C "$repo" cat-file -e "$to:$f" 2>/dev/null; then
      mkdir -p "$tmp/$(dirname "$f")"
      git -C "$repo" show "$to:$f" >"$tmp/$f" || true
    fi
    # the gate's die/mlog, captured: a refusal becomes one reason instead of an exit
    out="$( (die() { printf '%s\n' "$*"; exit 1; }; mlog() { :; }
             classify_pending_migration_file "$tmp" "$f") 2>/dev/null )" || errs+=("${out:-$f refused}")
  done <<<"$changed"
  rm -rf -- "$tmp"
  if (( ${#errs[@]} > 0 )); then
    rpf_add fail migrations "$(printf '%s; ' "${errs[@]:0:3}")"
  else
    rpf_add ok migrations "$n migration path(s) since live ${from:0:12} pass the cutover file rules"
  fi
}

# Proof database: the probe reads the catalog in one read-only transaction (pgcrypto availability
# and schema, public.digest EXECUTE, CREATE DATABASE / CREATE rights). DSN only via the environment.
rpf_check_proof_db() { # <repo> <gate-db|shared-db> <dsn>
  local repo="$1" mode="$2" dsn="$3" out rc=0 line s detail any=0 failed=0
  local probe="$RPF_LIB_DIR/proofDbPreflight.mjs"
  if [[ -z "$dsn" ]]; then
    rpf_add fail proof-db "no proof database DSN configured"; return 0
  fi
  # OC_V5_PREFLIGHT_PROOF_PROBE replaces the probe only in tests that have no Postgres. It is never
  # silent: the replacement is reported, and a probe that gives no verdict is a refusal (Codex #992).
  if [[ -n "${OC_V5_PREFLIGHT_PROOF_PROBE:-}" ]]; then
    probe="$OC_V5_PREFLIGHT_PROOF_PROBE"
    rpf_add warn proof-db "probe replaced by OC_V5_PREFLIGHT_PROOF_PROBE=$probe (test-only; a real departure must not set it)"
  fi
  # cwd = the repo so `pg` resolves from its node_modules; the probe itself ships with this lib.
  # 75 s covers the probe's worst case: two connects (10 s each) + a 10 s read + one 30 s retry after a
  # statement timeout (OCV5-583; proofDbPreflight.test.mjs pins the two budgets together).
  out="$(cd "$repo" && OC_V5_PREFLIGHT_PROOF_DSN="$dsn" timeout 75 node "$probe" "$mode" 2>&1)" || rc=$?
  while IFS=$'\t' read -r s detail; do
    case "$s" in
      ok|warn|fail) rpf_add "$s" proof-db "$detail"; any=1; [[ "$s" != fail ]] || failed=1 ;;
    esac
  done <<<"$out"
  if [[ "$any" == 0 || ( "$rc" != 0 && "$failed" == 0 ) ]]; then
    line="$(tail -n 1 <<<"$out" | sed -E 's#(postgres(ql)?://)[^ "]+#\1<redacted>#g')"
    rpf_add fail proof-db "probe gave no usable verdict (rc=$rc): ${line:-no output}"
  fi
}

# Disk: free bytes against the build gate's threshold and free inodes against a peak estimate
# (RPF_INODE_FACTOR × the live release), for every distinct filesystem a build writes to.
rpf_check_disk() { # <min-free-kb> <inode-reference-dir|""> <path>...
  local min_kb="$1" ref="$2" p seen=" " dev avail_kb free_i need_i=0 ref_i
  shift 2
  if [[ -n "$ref" && -d "$ref" ]]; then
    ref_i="$(du --inodes -sx -- "$ref" 2>/dev/null | awk '{print $1}' || true)"
    [[ "$ref_i" =~ ^[0-9]+$ ]] && need_i=$((ref_i * RPF_INODE_FACTOR))
  fi
  for p in "$@"; do
    while [[ ! -e "$p" && "$p" != / ]]; do p="$(dirname -- "$p")"; done
    dev="$(stat -c %d -- "$p" 2>/dev/null)" || { rpf_add fail disk "cannot stat $p"; continue; }
    [[ "$seen" == *" $dev "* ]] && continue
    seen+="$dev "
    avail_kb="$(df -Pk -- "$p" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
    free_i="$(df -Pi -- "$p" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
    if [[ ! "$avail_kb" =~ ^[0-9]+$ ]]; then
      rpf_add fail disk "cannot read free space of $p"; continue
    fi
    if (( avail_kb < min_kb )); then
      rpf_add fail disk "$p free ${avail_kb}KiB < ${min_kb}KiB (build gate threshold); free space first"
    elif [[ "$free_i" =~ ^[0-9]+$ ]] && (( need_i > 0 && free_i < need_i )); then
      rpf_add fail disk "$p free inodes $free_i < estimated peak $need_i (${RPF_INODE_FACTOR}× live release)"
    else
      rpf_add ok disk "$p free $((avail_kb / 1024 / 1024))GiB ≥ $((min_kb / 1024 / 1024))GiB, inodes ${free_i:-?} ≥ ${need_i}"
    fi
  done
}
