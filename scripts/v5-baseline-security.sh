#!/usr/bin/env bash
# V5 CCB baseline release guard.
#
# This script is intentionally standalone so deploy-v5.sh can stream the
# current, trusted validator to kl-mirror while checking an older release.
# Never execute a validator shipped inside the release being admitted.

set -euo pipefail

BASELINE_REL="packages/commercial/agent-sandbox/ccb-baseline"

# Keep in lock-step with V3_CCB_BASELINE_SKILL_NAMES in v3supervisor.ts.
# scripts/__tests__/v5ReleaseSafety.test.ts enforces the mirror.
EXPECTED_SKILLS=(
  system-info
  memory-management
  platform-capabilities
  scheduled-tasks
  wechat-notify
  skill-management
  skill-search
  scansci-pdf
  web-context
  browser
  document-writing
  minimax-media
  market
  oc-lit
  oc-cite
  oc-ingest
  oc-litrag
  research-report
  scientific-writing
  scientific-figures
  research-slides
  research-tournament
  research-experiment-loop
  research-writing-style
  office-spreadsheet
  office-pdf
  office-suite
  coding-suite
  cursor-cli
  code-review
  debugging
  testing
  skill-authoring
  oc-vision
  app-connectors
  connector-authoring
  manage-taskboard
  ssh
)

# Serving predecessor compatibility only: pre-admin/taskboard releases may lack
# the two admin prompt variants and the cursor/taskboard skills. New releases
# remain exact-manifest strict.
ALLOW_LEGACY_BASELINE_GAPS=0

die() {
  printf 'FATAL: V5 CCB baseline guard: %s\n' "$*" >&2
  exit 1
}

sorted_lines() {
  LC_ALL=C sort
}

assert_exact_lines() { # <label> <expected> <actual>
  local label="$1" expected="$2" actual="$3"
  [[ "$actual" == "$expected" ]] || {
    printf 'FATAL: V5 CCB baseline guard: %s mismatch\nexpected:\n%s\nactual:\n%s\n' \
      "$label" "$expected" "$actual" >&2
    exit 1
  }
}

assert_structure() { # <baseline-dir>
  local root="$1" top_expected top_actual skills_expected skills_actual skill entries
  [[ "$root" == /* ]] || die "baseline path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "baseline root missing/not a real directory: $root"

  # Reject symlinks, sockets, devices, FIFOs and every other non regular type
  # before hardening.  The tree comes from git archive and must be data-only.
  local special
  special="$(find -P "$root" -mindepth 1 ! \( -type d -o -type f \) -print -quit)"
  [[ -z "$special" ]] || die "symlink/special node is forbidden: $special"

  top_expected="$(printf '%s\n' AGENTS.admin.md AGENTS.md CLAUDE.admin.md CLAUDE.md skills | sorted_lines)"
  if [[ "$ALLOW_LEGACY_BASELINE_GAPS" == 1 && ! -e "$root/AGENTS.admin.md" && ! -e "$root/CLAUDE.admin.md" ]]; then
    top_expected="$(printf '%s\n' AGENTS.md CLAUDE.md skills | sorted_lines)"
  fi
  top_actual="$(find -P "$root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
  assert_exact_lines "baseline top-level entries" "$top_expected" "$top_actual"
  [[ -f "$root/AGENTS.md" && -f "$root/CLAUDE.md" && -d "$root/skills" ]] \
    || die "AGENTS.md, CLAUDE.md and skills/ are required"
  if [[ "$ALLOW_LEGACY_BASELINE_GAPS" != 1 || -e "$root/AGENTS.admin.md" || -e "$root/CLAUDE.admin.md" ]]; then
    [[ -f "$root/AGENTS.admin.md" && -f "$root/CLAUDE.admin.md" ]] \
      || die "AGENTS.admin.md and CLAUDE.admin.md must be both present or both absent only in legacy mode"
  fi

  skills_expected="$(printf '%s\n' "${EXPECTED_SKILLS[@]}")"
  if [[ "$ALLOW_LEGACY_BASELINE_GAPS" == 1 ]]; then
    [[ -e "$root/skills/cursor-cli" ]] || skills_expected="$(grep -vx cursor-cli <<<"$skills_expected")"
    [[ -e "$root/skills/manage-taskboard" ]] || skills_expected="$(grep -vx manage-taskboard <<<"$skills_expected")"
  fi
  skills_expected="$(sorted_lines <<<"$skills_expected")"
  # Runtime resolveCcbBaselineMounts() enumerates every skills/ entry before it
  # validates directories. Mirror that exact boundary: an undeclared regular
  # file at this level is manifest drift too, not something to silently ignore.
  skills_actual="$(find -P "$root/skills" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
  assert_exact_lines "skill manifest" "$skills_expected" "$skills_actual"

  # 与 runtime resolveCcbBaselineMounts() 同一白名单(2026-07-16 扩展):
  # skill 目录允许恰好 {SKILL.md} 或 {SKILL.md, evals/};evals/ 内恰好一个 evals.json。
  for skill in "${EXPECTED_SKILLS[@]}"; do
    if [[ "$ALLOW_LEGACY_BASELINE_GAPS" == 1 && ! -e "$root/skills/$skill" && ( "$skill" == cursor-cli || "$skill" == manage-taskboard ) ]]; then
      continue
    fi
    [[ -d "$root/skills/$skill" ]] || die "missing skill directory: $skill"
    entries="$(find -P "$root/skills/$skill" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
    if [[ "$entries" == "SKILL.md" ]]; then
      [[ -f "$root/skills/$skill/SKILL.md" ]] \
        || die "skill $skill must contain a regular SKILL.md"
    elif [[ "$entries" == "$(printf 'SKILL.md\nevals')" ]]; then
      [[ -f "$root/skills/$skill/SKILL.md" && -d "$root/skills/$skill/evals" ]] \
        || die "skill $skill entries must be regular SKILL.md + evals dir"
      eval_entries="$(find -P "$root/skills/$skill/evals" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
      [[ "$eval_entries" == "evals.json" && -f "$root/skills/$skill/evals/evals.json" ]] \
        || die "skill $skill/evals must contain exactly one regular evals.json"
    else
      die "skill $skill must contain exactly SKILL.md (optionally plus evals/), got: $entries"
    fi
  done
}

assert_owner_modes() { # <baseline-dir>
  local root="$1" item uid mode list
  list="$(mktemp)" || die "cannot allocate baseline traversal list"
  trap 'rm -f -- "$list"' RETURN
  find -P "$root" -print0 > "$list" \
    || die "cannot enumerate the complete baseline tree: $root"
  while IFS= read -r -d '' item; do
    uid="$(stat -c '%u' -- "$item")"
    mode="$(stat -c '%a' -- "$item")"
    [[ "$uid" == 0 ]] || die "not root-owned (uid=$uid): $item"
    (( (8#$mode & 8#022) == 0 )) \
      || die "group/other writable (mode=$mode): $item"
    if [[ -d "$item" ]]; then
      (( (8#$mode & 8#005) == 8#005 )) \
        || die "directory is not world-readable/traversable (mode=$mode): $item"
    else
      (( (8#$mode & 8#004) == 8#004 )) \
        || die "file is not world-readable (mode=$mode): $item"
    fi
  done < "$list"
  rm -f -- "$list"
  trap - RETURN
}

check_baseline() { # <baseline-dir>
  local root="$1"
  assert_structure "$root"
  assert_owner_modes "$root"
  printf 'ok baseline=%s skills=%s\n' "$root" "${#EXPECTED_SKILLS[@]}"
}

harden_baseline() { # <baseline-dir>
  local root="$1"
  assert_structure "$root"
  # The manifest is data-only (directories + Markdown files).  Deterministic
  # modes guarantee the non-root container user can traverse/read every bind,
  # while each find/exec failure propagates through errexit.
  find -P "$root" -type d -exec chown 0:0 -- {} +
  find -P "$root" -type f -exec chown 0:0 -- {} +
  find -P "$root" -type d -exec chmod 0755 -- {} +
  find -P "$root" -type f -exec chmod 0644 -- {} +
  check_baseline "$root"
}

usage() {
  cat >&2 <<'EOF'
usage:
  v5-baseline-security.sh check-release <absolute-release-root>
  v5-baseline-security.sh harden-release <absolute-release-root>
  v5-baseline-security.sh check-release-legacy-cursor <absolute-release-root>
  v5-baseline-security.sh harden-release-legacy-cursor <absolute-release-root>
  v5-baseline-security.sh check-dir <absolute-baseline-dir>
  v5-baseline-security.sh harden-dir <absolute-baseline-dir>
EOF
  exit 2
}

[[ $# == 2 ]] || usage
mode="$1"
path="$2"
case "$mode" in
  check-release)   check_baseline "${path%/}/$BASELINE_REL" ;;
  harden-release)  harden_baseline "${path%/}/$BASELINE_REL" ;;
  check-release-legacy-cursor) ALLOW_LEGACY_BASELINE_GAPS=1; check_baseline "${path%/}/$BASELINE_REL" ;;
  harden-release-legacy-cursor) ALLOW_LEGACY_BASELINE_GAPS=1; harden_baseline "${path%/}/$BASELINE_REL" ;;
  check-dir)       check_baseline "${path%/}" ;;
  harden-dir)      harden_baseline "${path%/}" ;;
  *) usage ;;
esac
