#!/usr/bin/env bash
# Reference-aware V5 master release GC.
#
# This trusted helper is streamed by deploy-v5.sh to the production host. It
# completes every state/container inspection before the first rm. Validation
# failures exit 75, meaning "safe skip, zero release deletions"; deletion
# failures use a normal non-zero status so deploy stays fail-loud.

set -Eeuo pipefail

SAFE_SKIP=75
MANAGED_LABEL="com.openclaude.v3.managed"
CHANNEL_LABEL="com.openclaude.runtime_channel"
BASELINE_REL="packages/commercial/agent-sandbox/ccb-baseline"

die_safe() {
  printf 'SAFE-SKIP: V5 release GC: %s\n' "$*" >&2
  exit "$SAFE_SKIP"
}

[[ $# == 12 ]] || die_safe "expected 12 arguments"
root="${1%/}"; keep="$2"; src_a="$3"; src_b="$4"; egress_src="$5"
prev_file="$6"; unit_a="$7"; unit_b="$8"; egress_unit="$9"
ds_active="${10}"; ds_candidate="${11}"; ds_previous="${12}"

[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ && -d "$root" && ! -L "$root" ]] \
  || die_safe "invalid releases root"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die_safe "invalid keep count"
command -v docker >/dev/null || die_safe "docker is unavailable"
command -v jq >/dev/null || die_safe "jq is unavailable"
command -v systemctl >/dev/null || die_safe "systemctl is unavailable"

declare -A protected=()
add_protected_path() { # absolute path or release name; absent paths are harmless
  local raw="$1" path resolved
  [[ -n "$raw" ]] || return 0
  case "$raw" in
    /*) path="$raw" ;;
    *) path="$root/$raw" ;;
  esac
  if [[ -e "$path" || -L "$path" ]]; then
    resolved="$(readlink -f -- "$path" 2>/dev/null)" \
      || die_safe "cannot resolve protected path"
    [[ -n "$resolved" ]] || die_safe "empty protected path resolution"
    protected["$resolved"]=1
  fi
}

add_protected_path "$src_a"
add_protected_path "$src_b"
add_protected_path "$egress_src"
if [[ -f "$prev_file" && ! -L "$prev_file" ]]; then
  prev_value="$(cat -- "$prev_file")" || die_safe "cannot read previous release"
  add_protected_path "$prev_value"
elif [[ -e "$prev_file" || -L "$prev_file" ]]; then
  die_safe "previous release marker is not a regular file"
fi
add_protected_path "$ds_active"
add_protected_path "$ds_candidate"
add_protected_path "$ds_previous"

protect_unit_cwd() { # unit
  local unit="$1" pid cwd
  pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null)" \
    || die_safe "cannot inspect unit PID"
  [[ "$pid" =~ ^[0-9]+$ ]] || die_safe "unit returned an invalid PID"
  if (( pid > 0 )); then
    cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null)" \
      || die_safe "cannot resolve live unit cwd"
    [[ -n "$cwd" ]] || die_safe "live unit cwd is empty"
    protected["$cwd"]=1
  fi
}
protect_unit_cwd "$unit_a"
protect_unit_cwd "$unit_b"
protect_unit_cwd "$egress_unit"

# Complete the Docker census before computing/deleting candidates. docker ps
# filters are re-verified against inspect labels to make the boundary explicit.
tmp="$(mktemp -d)" || die_safe "cannot allocate census workspace"
trap 'rm -rf -- "$tmp"' EXIT
if ! docker ps -aq \
    --filter "label=$MANAGED_LABEL=1" \
    --filter "label=$CHANNEL_LABEL=v5" > "$tmp/container-ids"; then
  die_safe "cannot enumerate managed V5 containers"
fi

while IFS= read -r cid; do
  [[ -n "$cid" ]] || continue
  [[ "$cid" =~ ^[0-9a-f]{12,64}$ ]] || die_safe "docker returned an invalid container id"
  inspect_file="$tmp/inspect-$cid.json"
  docker inspect "$cid" > "$inspect_file" \
    || die_safe "cannot inspect a managed V5 container"
  jq -e --arg managed "$MANAGED_LABEL" --arg channel "$CHANNEL_LABEL" \
    'length == 1 and .[0].Config.Labels[$managed] == "1" and .[0].Config.Labels[$channel] == "v5"' \
    "$inspect_file" >/dev/null \
    || die_safe "managed V5 container labels changed during census"

  while IFS='|' read -r destination leaves expected_type; do
    matches="$tmp/matches-$cid-$(basename "$destination").json"
    jq -c --arg destination "$destination" \
      '[.[0].Mounts[]? | select(.Destination == $destination)]' \
      "$inspect_file" > "$matches" \
      || die_safe "cannot parse container mounts"
    count="$(jq -r 'length' "$matches")" || die_safe "cannot count container mounts"
    [[ "$count" =~ ^[0-9]+$ ]] || die_safe "invalid mount count"
    (( count == 0 )) && continue
    (( count == 1 )) || die_safe "duplicate baseline destination in a V5 container"
    jq -e '.[0].Type == "bind" and .[0].RW == false and (.[0].Source | type == "string")' \
      "$matches" >/dev/null \
      || die_safe "baseline destination is not one trusted read-only bind"
    source_path="$(jq -r '.[0].Source' "$matches")" \
      || die_safe "cannot read baseline bind source"

    relative="${source_path#"$root"/}"
    [[ "$relative" != "$source_path" ]] \
      || die_safe "baseline bind source is outside the release root"
    release_name="${relative%%/*}"
    [[ "$release_name" =~ ^rel-[A-Za-z0-9._-]+$ ]] \
      || die_safe "baseline bind source has an invalid release name"
    # admin 容器同一 destination 绑 AGENTS.admin.md / CLAUDE.admin.md 变体
    # (2026-08-22 admin-host-container-spec)。按 destination 声明的候选 leaf 集匹配,
    # 任何不在集合内的 source 仍整轮 SAFE-SKIP。
    src_leaf="${source_path##*/}"
    leaf_ok=0
    IFS=':' read -ra allowed_leaves <<<"$leaves"
    for allowed_leaf in "${allowed_leaves[@]}"; do
      [[ "$src_leaf" == "$allowed_leaf" ]] && leaf_ok=1
    done
    (( leaf_ok )) || die_safe "baseline bind source does not match its destination"
    expected="$root/$release_name/$BASELINE_REL/$src_leaf"
    [[ "$source_path" == "$expected" ]] \
      || die_safe "baseline bind source does not match its destination"
    if [[ "$expected_type" == file ]]; then
      [[ -f "$source_path" && ! -L "$source_path" ]] \
        || die_safe "referenced baseline file is missing or unsafe"
    else
      [[ -d "$source_path" && ! -L "$source_path" ]] \
        || die_safe "referenced baseline directory is missing or unsafe"
    fi
    resolved_source="$(readlink -f -- "$source_path" 2>/dev/null)" \
      || die_safe "cannot resolve baseline bind source"
    [[ "$resolved_source" == "$source_path" ]] \
      || die_safe "baseline bind source is not canonical"
    release_path="$root/$release_name"
    [[ -d "$release_path" && ! -L "$release_path" && -f "$release_path/.complete" ]] \
      || die_safe "referenced baseline release is incomplete"
    protected["$release_path"]=1
  done <<'MOUNTS'
/opt/openclaude/AGENTS.md|AGENTS.md:AGENTS.admin.md|file
/run/oc/claude-config/CLAUDE.md|CLAUDE.md:CLAUDE.admin.md|file
/run/oc/claude-config/skills|skills|dir
MOUNTS
done < "$tmp/container-ids"

# Snapshot and validate every candidate before deletion. Release names are
# intentionally narrow so sorting output can never become an rm argument escape.
find -P "$root" -mindepth 1 -maxdepth 1 -type d -name 'rel-*' \
  -printf '%T@ %p\n' > "$tmp/releases.raw" \
  || die_safe "cannot enumerate releases"
sort -rn "$tmp/releases.raw" > "$tmp/releases.sorted" \
  || die_safe "cannot sort releases"

declare -a delete=()
index=0
while IFS= read -r record; do
  [[ -n "$record" ]] || continue
  release_path="${record#* }"
  release_name="${release_path#"$root"/}"
  [[ "$release_name" =~ ^rel-[A-Za-z0-9._-]+$ && "$release_path" == "$root/$release_name" ]] \
    || die_safe "release enumeration returned an unsafe path"
  (( index += 1 ))
  (( index <= keep )) && continue
  [[ -n "${protected[$release_path]:-}" ]] && continue
  [[ -f "$release_path/.complete" && ! -L "$release_path/.complete" ]] || continue
  delete+=("$release_path")
done < "$tmp/releases.sorted"

for release_path in "${delete[@]}"; do
  rm -rf -- "$release_path" || {
    printf 'FATAL: V5 release GC deletion failed: %s\n' "$release_path" >&2
    exit 1
  }
done

# Staging directories are never container bind sources. Their best-effort
# cleanup stays separate from formal release deletion.
find -P "$root" -maxdepth 1 -name '.staging-*' -type d -mtime +1 -exec rm -rf -- {} + 2>/dev/null || true
printf 'ok releases=%s protected=%s deleted=%s\n' "$index" "${#protected[@]}" "${#delete[@]}"
