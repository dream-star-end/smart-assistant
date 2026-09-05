#!/usr/bin/env bash
# V5 CCB baseline release guard.
#
# This script is intentionally standalone so deploy-v5.sh can stream the
# current, trusted validator to kl-mirror while checking an older release.
# Never execute a validator shipped inside the release being admitted.

set -euo pipefail

BASELINE_REL="packages/commercial/agent-sandbox/ccb-baseline"
MANIFEST_REL=".baseline-manifest.json"

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
  multi-model-review
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

# MIN_SECURITY_POLICY: applied to every release, independent of that release's
# own manifest. Initial set = existing forbidden-class checks (no
# symlink/special nodes) plus documents every serving baseline must have.
# No extra required skills yet — those live in the release's expectedSkills.
MIN_REQUIRED_TOPLEVEL=(AGENTS.md CLAUDE.md skills)
MIN_FORBIDDEN_SKILLS=()
MIN_FORBIDDEN_RELATIVE_PATHS=()

# Serving predecessor compatibility only: pre-admin/taskboard releases may lack
# the two admin prompt variants and the cursor/taskboard skills; releases built
# before the SSH skill landed may lack that skill too; serving releases before
# the 2026-09-05 sync (2887d6d4b) may lack multi-model-review. New releases
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

assert_no_special_nodes() { # <baseline-dir>
  local root="$1" special
  special="$(find -P "$root" -mindepth 1 ! \( -type d -o -type f \) -print -quit)"
  [[ -z "$special" ]] || die "symlink/special node is forbidden: $special"
}

assert_skill_inner() { # <baseline-dir> <skill>
  local root="$1" skill="$2" entry eval_entries
  [[ -d "$root/skills/$skill" ]] || die "missing skill directory: $skill"
  [[ -f "$root/skills/$skill/SKILL.md" ]] \
    || die "skill $skill must contain a regular SKILL.md"
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    case "$entry" in
      SKILL.md) ;;
      evals)
        [[ -d "$root/skills/$skill/evals" ]] \
          || die "skill $skill/evals must be a directory"
        eval_entries="$(find -P "$root/skills/$skill/evals" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
        [[ "$eval_entries" == "evals.json" && -f "$root/skills/$skill/evals/evals.json" ]] \
          || die "skill $skill/evals must contain exactly one regular evals.json"
        ;;
      references|scripts)
        [[ -d "$root/skills/$skill/$entry" ]] \
          || die "skill $skill/$entry must be a directory"
        ;;
      *)
        die "skill $skill has undeclared entry $entry; allowed: SKILL.md, evals/, references/, scripts/"
        ;;
    esac
  done < <(find -P "$root/skills/$skill" -mindepth 1 -maxdepth 1 -printf '%f\n')
}

assert_structure() { # <baseline-dir>
  local root="$1" top_expected top_actual skills_expected skills_actual skill
  [[ "$root" == /* ]] || die "baseline path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "baseline root missing/not a real directory: $root"

  # Reject symlinks, sockets, devices, FIFOs and every other non regular type
  # before hardening.  The tree comes from git archive and must be data-only.
  assert_no_special_nodes "$root"

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
    # Serving releases before 2026-09-05 sync (2887d6d4b) have no
    # multi-model-review in baseline; legacy mode allows only that extra gap.
    # New releases remain exact-manifest strict.
    for skill in cursor-cli manage-taskboard ssh multi-model-review; do
      if [[ ! -e "$root/skills/$skill" ]]; then
        skills_expected="$(grep -vx "$skill" <<<"$skills_expected")"
      fi
    done
  fi
  skills_expected="$(sorted_lines <<<"$skills_expected")"
  # Runtime resolveCcbBaselineMounts() enumerates every skills/ entry before it
  # validates directories. Mirror that exact boundary: an undeclared regular
  # file at this level is manifest drift too, not something to silently ignore.
  skills_actual="$(find -P "$root/skills" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
  assert_exact_lines "skill manifest" "$skills_expected" "$skills_actual"

  # 与 runtime resolveCcbBaselineMounts() / ccbBaselineSkills.test.ts 同一白名单:
  # 必有 SKILL.md;可选 evals/、references/、scripts/;evals/ 内恰好一个 evals.json。
  for skill in "${EXPECTED_SKILLS[@]}"; do
    if [[ "$ALLOW_LEGACY_BASELINE_GAPS" == 1 && ! -e "$root/skills/$skill" ]]; then
      case "$skill" in
        cursor-cli|manage-taskboard|ssh|multi-model-review) continue ;;
      esac
    fi
    assert_skill_inner "$root" "$skill"
  done
}

# Question (a): the release matches its own baked expectedSkills / top-level
# list. Extra skills relative to *this checkout's* EXPECTED_SKILLS are allowed
# when the release's own manifest does not list them; extras relative to the
# manifest are not.
assert_manifest_contract() { # <baseline-dir> <manifest-json-path>
  local root="$1" manifest="$2"
  local top_expected top_actual skills_expected skills_actual skill
  local -a skills
  [[ "$root" == /* ]] || die "baseline path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "baseline root missing/not a real directory: $root"

  mapfile -t skills < <(jq -r '.expectedSkills[]' "$manifest")
  [[ ${#skills[@]} -gt 0 ]] || die "manifest expectedSkills is empty"

  if jq -e '.expectedTopLevel | type == "array" and length > 0' "$manifest" >/dev/null; then
    top_expected="$(jq -r '.expectedTopLevel[]' "$manifest" | sorted_lines)"
  else
    top_expected="$(printf '%s\n' AGENTS.admin.md AGENTS.md CLAUDE.admin.md CLAUDE.md skills | sorted_lines)"
  fi
  top_actual="$(find -P "$root" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
  assert_exact_lines "baseline top-level entries" "$top_expected" "$top_actual"
  [[ -f "$root/AGENTS.md" && -f "$root/CLAUDE.md" && -d "$root/skills" ]] \
    || die "AGENTS.md, CLAUDE.md and skills/ are required"

  skills_expected="$(printf '%s\n' "${skills[@]}" | sorted_lines)"
  skills_actual="$(find -P "$root/skills" -mindepth 1 -maxdepth 1 -printf '%f\n' | sorted_lines)"
  assert_exact_lines "skill manifest" "$skills_expected" "$skills_actual"

  for skill in "${skills[@]}"; do
    assert_skill_inner "$root" "$skill"
  done

  if jq -e '.forbiddenPaths | type == "array" and length > 0' "$manifest" >/dev/null; then
    local rel
    while IFS= read -r rel; do
      [[ -z "$rel" ]] && continue
      [[ "$rel" == /* || "$rel" == *..* ]] && die "manifest forbiddenPaths entry illegal: $rel"
      [[ ! -e "$root/$rel" ]] || die "manifest forbids path that exists: $rel"
    done < <(jq -r '.forbiddenPaths[]' "$manifest")
  fi
}

# Question (b): current checkout MIN_SECURITY_POLICY against any release.
assert_min_security_policy() { # <baseline-dir>
  local root="$1" item rel
  [[ "$root" == /* ]] || die "baseline path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "baseline root missing/not a real directory: $root"
  assert_no_special_nodes "$root"
  for item in "${MIN_REQUIRED_TOPLEVEL[@]}"; do
    [[ -e "$root/$item" ]] || die "MIN_SECURITY_POLICY required path missing: $item"
  done
  for item in "${MIN_FORBIDDEN_SKILLS[@]}"; do
    [[ ! -e "$root/skills/$item" ]] || die "MIN_SECURITY_POLICY forbids skill: $item"
  done
  for rel in "${MIN_FORBIDDEN_RELATIVE_PATHS[@]}"; do
    [[ -z "$rel" ]] && continue
    [[ ! -e "$root/$rel" ]] || die "MIN_SECURITY_POLICY forbids path: $rel"
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

write_manifest() { # <release-root> <40-hex sourceCommit>
  local root="$1" source_commit="$2" tmp skills_json
  [[ "$root" == /* ]] || die "release path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "release root missing/not a real directory: $root"
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || die "sourceCommit must be 40-hex: $source_commit"
  skills_json="$(jq -n --args '$ARGS.positional' -- "${EXPECTED_SKILLS[@]}")"
  tmp="$root/$MANIFEST_REL.$$"
  if ! jq -n -c \
    --argjson schemaVersion 1 \
    --arg sourceCommit "$source_commit" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson expectedSkills "$skills_json" \
    --argjson forbiddenPaths '[]' \
    --argjson expectedTopLevel '["AGENTS.admin.md","AGENTS.md","CLAUDE.admin.md","CLAUDE.md","skills"]' \
    '{schemaVersion:$schemaVersion,sourceCommit:$sourceCommit,generatedAt:$generatedAt,expectedSkills:$expectedSkills,forbiddenPaths:$forbiddenPaths,expectedTopLevel:$expectedTopLevel}' \
    >"$tmp"; then
    rm -f -- "$tmp"
    die "cannot write baseline manifest"
  fi
  chmod 0644 "$tmp" || { rm -f -- "$tmp"; die "cannot chmod baseline manifest"; }
  mv -f -- "$tmp" "$root/$MANIFEST_REL" || { rm -f -- "$tmp"; die "cannot publish baseline manifest"; }
  printf 'ok wrote-manifest=%s skills=%s\n' "$root/$MANIFEST_REL" "${#EXPECTED_SKILLS[@]}"
}

verify_release() { # <release-root> <allow-legacy-missing 0|1>
  local root="$1" allow_legacy="${2:-0}"
  local manifest complete baseline want have schema complete_sha manifest_sha
  [[ "$root" == /* ]] || die "release path must be absolute: $root"
  [[ -d "$root" && ! -L "$root" ]] || die "release root missing/not a real directory: $root"
  manifest="$root/$MANIFEST_REL"
  complete="$root/.complete"
  baseline="$root/$BASELINE_REL"

  if [[ ! -e "$manifest" ]]; then
    if [[ -f "$complete" ]] && jq -e '.baselineManifestSha256 | type == "string"' "$complete" >/dev/null 2>&1; then
      die "baselineManifestSha256 present in .complete but $MANIFEST_REL is missing"
    fi
    if [[ "$allow_legacy" == 1 ]]; then
      ALLOW_LEGACY_BASELINE_GAPS=1
      check_baseline "$baseline"
      return 0
    fi
    die "baseline manifest missing (pass --allow-legacy-manifest-missing for pre-cutoff releases)"
  fi

  [[ -f "$manifest" && ! -L "$manifest" ]] || die "baseline manifest must be a regular file: $manifest"
  [[ -f "$complete" && ! -L "$complete" ]] || die ".complete missing/not a regular file: $complete"

  want="$(jq -er '.baselineManifestSha256 | select(type=="string" and test("^[0-9a-f]{64}$"))' "$complete")" \
    || die "baselineManifestSha256 missing/invalid in .complete while manifest exists"
  have="$(sha256sum -- "$manifest" | cut -d' ' -f1)"
  [[ "$want" == "$have" ]] || die "baseline manifest digest mismatch (complete=$want file=$have)"

  schema="$(jq -er '.schemaVersion' "$manifest")" || die "manifest schemaVersion missing"
  [[ "$schema" == 1 ]] || die "unsupported baseline manifest schemaVersion=$schema"
  jq -e '.expectedSkills | type=="array" and length>0 and all(.[]; type=="string" and test("^[a-z0-9-]+$"))' \
    "$manifest" >/dev/null \
    || die "manifest expectedSkills invalid"

  complete_sha="$(jq -er '.sourceCommit | select(type=="string" and test("^[0-9a-f]{40}$"))' "$complete" 2>/dev/null || true)"
  manifest_sha="$(jq -er '.sourceCommit | select(type=="string" and test("^[0-9a-f]{40}$"))' "$manifest")" \
    || die "manifest sourceCommit missing/invalid"
  if [[ -n "$complete_sha" && "$complete_sha" != "$manifest_sha" ]]; then
    die "manifest sourceCommit != .complete.sourceCommit"
  fi

  # (a) release matches its own baked contract
  assert_manifest_contract "$baseline" "$manifest"
  # (b) current checkout minimum security policy
  assert_min_security_policy "$baseline"
  assert_owner_modes "$baseline"
  printf 'ok verify-release=%s skills=%s\n' "$root" "$(jq -r '.expectedSkills | length' "$manifest")"
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
  v5-baseline-security.sh write-manifest <absolute-release-root> <40-hex-sourceCommit>
  v5-baseline-security.sh verify-release <absolute-release-root> [--allow-legacy-manifest-missing]
EOF
  exit 2
}

[[ $# -ge 2 ]] || usage
mode="$1"
path="$2"
shift 2
case "$mode" in
  check-release)
    [[ $# == 0 ]] || usage
    check_baseline "${path%/}/$BASELINE_REL"
    ;;
  harden-release)
    [[ $# == 0 ]] || usage
    harden_baseline "${path%/}/$BASELINE_REL"
    ;;
  check-release-legacy-cursor)
    [[ $# == 0 ]] || usage
    ALLOW_LEGACY_BASELINE_GAPS=1
    check_baseline "${path%/}/$BASELINE_REL"
    ;;
  harden-release-legacy-cursor)
    [[ $# == 0 ]] || usage
    ALLOW_LEGACY_BASELINE_GAPS=1
    harden_baseline "${path%/}/$BASELINE_REL"
    ;;
  check-dir)
    [[ $# == 0 ]] || usage
    check_baseline "${path%/}"
    ;;
  harden-dir)
    [[ $# == 0 ]] || usage
    harden_baseline "${path%/}"
    ;;
  write-manifest)
    [[ $# == 1 ]] || usage
    write_manifest "${path%/}" "$1"
    ;;
  verify-release)
    allow_legacy=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --allow-legacy-manifest-missing) allow_legacy=1 ;;
        *) usage ;;
      esac
      shift
    done
    verify_release "${path%/}" "$allow_legacy"
    ;;
  *) usage ;;
esac
