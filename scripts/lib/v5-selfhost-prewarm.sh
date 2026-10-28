#!/usr/bin/env bash
# shellcheck disable=SC2034 # Globals are consumed by the sourced runtime builder/deploy driver.
# P1: speculative artifacts, never a gate receipt or deployable master release.
# Only the dedicated systemd cgroup builds; trains stop it under deploy.lock BEFORE planning.
# All deletion stays in the private cache. Official runtime GC remains the only release GC.
PREWARM_WATCHDOG_PID=""
PREWARM_WORK=""
PREWARM_RUNTIME_BUILD=0
PREWARM_ATTEMPT_CACHE=""
PREWARM_PHASE=admission
PREWARM_RUNTIME_STATUS=pending
PREWARM_RUNTIME_RC=0
PREWARM_WEB_STATUS=pending

prewarm_cache_root() { printf '%s' "${OC_V5_SELFHOST_PREWARM_CACHE:-/var/lib/openclaude-v5-selfhost/artifact-cache}"; }
prewarm_unit() { # Different test locks cannot address the real service.
  printf 'oc-v5-selfhost-prewarm-%s' "$(printf '%s' "$1" | sha256sum | cut -c1-16)"
}
prewarm_trusted_dir() {
  local uid gid mode
  [[ -d "$1" && ! -L "$1" ]] || return 1
  read -r uid gid mode < <(stat -c '%u %g %a' -- "$1") || return 1
  [[ "$uid:$gid" == 0:0 && $((8#$mode & 8#22)) == 0 ]]
}

prewarm_skip() { echo "prewarm: admission refused ($1)" >&2; }

prewarm_attempt_next() { # <cache> <sha>; stdout next attempt, or fail closed (also used under guard).
  local cache="$1" sha="$2" now
  [[ ! -e "$cache" && ! -L "$cache" ]] || prewarm_trusted_dir "$cache" || return 1
  [[ -e "$cache/attempt.json" || -L "$cache/attempt.json" ]] || { echo 1; return 0; }
  [[ -f "$cache/attempt.json" && ! -L "$cache/attempt.json" ]] || return 1
  now="$(date +%s)" || return 1
  jq -ser --arg sha "$sha" --argjson now "$now" '
    def uint: type == "number" and . >= 0 and . == floor;
    if length != 1 then error("invalid attempt record") else .[0] end |
    if type != "object" or (.sha | type) != "string" then error("invalid attempt record")
    elif (.sha | test("^[0-9a-f]{40}$") | not) then error("invalid SHA")
    # Upgrade the old unbounded SHA-only record once; it is not schema-2 evidence.
    elif .schema == null and (has("done") or has("retryAfter")) then 1
    elif .schema != 2 or (.attempt | uint | not) or .attempt < 1 or .attempt > 3
      or (.retryAfter | uint | not) then error("invalid attempt record")
    elif (.status != "running" and .status != "failed" and .status != "partial" and .status != "ready") then error("invalid status")
    elif .sha != $sha then 1
    elif .status == "ready" or .attempt >= 3 or $now < .retryAfter then empty
    else .attempt + 1 end' "$cache/attempt.json" 2>/dev/null
}

prewarm_attempt_save() { # <status> <exit-code|null>; one atomic, bounded diagnostic record.
  local status="$1" rc="$2" ended=null
  [[ "$status" == running ]] || ended="$(date +%s)" || return 1
  jq -n --arg sha "$PREWARM_SHA" --argjson attempt "$PREWARM_ATTEMPT" \
    --argjson start "$PREWARM_STARTED" --argjson after "$PREWARM_RETRY_AFTER" \
    --argjson end "$ended" --arg status "$status" --arg phase "$PREWARM_PHASE" \
    --arg runtime "$PREWARM_RUNTIME_STATUS" --argjson runtimeRC "$PREWARM_RUNTIME_RC" \
    --arg web "$PREWARM_WEB_STATUS" --argjson rc "$rc" \
    '{schema:2,sha:$sha,attempt:$attempt,retryAfter:$after,startedAt:$start,endedAt:$end,
      status:$status,phase:$phase,runtime:$runtime,runtimeExitCode:$runtimeRC,web:$web,exitCode:$rc}' \
    >"$PREWARM_ATTEMPT_CACHE/attempt.json.tmp" || return 1
  mv -f "$PREWARM_ATTEMPT_CACHE/attempt.json.tmp" "$PREWARM_ATTEMPT_CACHE/attempt.json"
}

prewarm_attempt_begin() { # caller holds guard; interrupted attempts already consume their allowance.
  local cache="$1" sha="$2"
  PREWARM_ATTEMPT="$(prewarm_attempt_next "$cache" "$sha")" || return 1
  PREWARM_SHA="$sha"; PREWARM_STARTED="$(date +%s)" || return 1
  PREWARM_RETRY_AFTER=$((PREWARM_STARTED + 1800 * PREWARM_ATTEMPT))
  PREWARM_PHASE=runtime; PREWARM_RUNTIME_STATUS=running; PREWARM_RUNTIME_RC=0; PREWARM_WEB_STATUS=pending
  PREWARM_ATTEMPT_CACHE="$cache"
  prewarm_attempt_save running null || { PREWARM_ATTEMPT_CACHE=""; return 1; }
  echo "prewarm: attempt=$PREWARM_ATTEMPT/3 sha=${sha:0:12} retryAfter=$PREWARM_RETRY_AFTER" >&2
}

prewarm_idle_db() { # Read-only, missing/corrupt/locked DB is NOT idle; never creates a DB.
  local db="$1" count
  [[ -f "$db" && ! -L "$db" ]] || return 1
  count="$(sqlite3 -readonly -cmd '.timeout 1000' "$db" "SELECT
    (SELECT count(*) FROM train WHERE resource='deploy:selfhost' AND status NOT IN ('committed','failed')) +
    (SELECT count(*) FROM lease WHERE resource='deploy:selfhost' AND status IN ('registered','granted'));")" || return 1
  [[ "$count" == 0 ]]
}

prewarm_quiesce() ( # <deploy.lock>; caller already holds that lock. Never sends a signal by PID search.
  local lock="$1" guard="$1.prewarm" unit
  [[ -e "$guard" || -L "$guard" ]] || return 0
  [[ -f "$guard" && ! -L "$guard" ]] || return 1
  exec 9<>"$guard" || return 1
  flock -n 9 && return 0
  unit="$(prewarm_unit "$lock")"
  # systemctl stop waits for KillMode=control-group, including compiler grandchildren.
  timeout 20 systemctl stop "$unit.service" || return 1
  flock -w 15 9
)

prewarm_idle_tick() {
  [[ "${OC_V5_SELFHOST_PREWARM:-1}" == 1 && "${DRY:-0}" != 1 ]] || return 0
  [[ "${LEASE_BRANCH:-}" == feat/v5-selfhost && -n "${INVOCATION_ID:-}" ]] || return 0
  prewarm_idle_db "$LEASE_DB" || return 0
  lease_release_policy_held && return 0
  lease_in_cutover_grace && return 0
  lease_deploy_process_running && return 0
  local tip cache unit
  # Do not build an unpushed/local head. A failed fetch cannot warm a stale remote ref.
  git -C "$LEASE_REPO_ROOT" fetch -q origin "$LEASE_BRANCH" || return 0
  tip="$(lease_remote_tip)" || return 0
  [[ "$tip" =~ ^[0-9a-f]{40}$ ]] || return 0
  cache="$(prewarm_cache_root)"
  prewarm_attempt_next "$cache" "$tip" >/dev/null || return 0
  unit="$(prewarm_unit "$LEASE_DEPLOY_LOCK")"
  # No inherited worker/deploy/DB fds. A running same-name unit prevents duplicate warmers.
  systemd-run --quiet --collect --unit="$unit" --property=Nice=15 --property=CPUWeight=1 \
    --property=IOWeight=1 --property=KillMode=control-group --property=TimeoutStopSec=10s \
    --property=RuntimeMaxSec=20min --setenv=OC_V5_LEASE_DB="$LEASE_DB" \
    --setenv=OC_V5_SELFHOST_DEPLOY_LOCK="$LEASE_DEPLOY_LOCK" \
    --setenv=OC_V5_SELFHOST_PREWARM_CACHE="$cache" \
    --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$DEPLOY_BIN" --prewarm-artifacts --target-sha="$tip" </dev/null >/dev/null 2>&1 \
    || echo "prewarm: service start unavailable for ${tip:0:12}" >&2
}

prewarm_budget_ok() { # <free-KiB> <free-inodes> <path>; statvfs failure is fatal to speculation.
  python3 - "$@" <<'PY'
import os, sys
try:
    space, inodes, root = sys.argv[1:]
    s = os.statvfs(root)
    ok = s.f_bavail * s.f_frsize >= int(space) * 1024 and s.f_favail >= int(inodes)
except (OSError, ValueError):
    ok = False
sys.exit(0 if ok else 1)
PY
}

prewarm_recipe_matches() { # The current driver must be the recipe pinned by the requested tip.
  local sha="$1" p want have
  for p in scripts/deploy-v5-selfhost.sh scripts/v5-selfhost-master-release-lib.sh \
    scripts/v5-runtime-release-lib.sh scripts/lib/v5-selfhost-runtime-build.sh \
    scripts/lib/v5-selfhost-prewarm.sh scripts/lib/assert-flavor.sh \
    packages/commercial/agent-sandbox/runtime-src-excludes.txt; do
    want="$(git -C "$REPO_ROOT" rev-parse --verify "$sha:$p")" || return 1
    have="$(git hash-object "$REPO_ROOT/$p")" || return 1
    [[ "$want" == "$have" ]] || return 1
  done
}

prewarm_runtime_key() { # exact tip + immutable toolchain + actual recipe, no secret values in logs
  local sha="$1" image="$2" nodev bunv recipe envkey
  [[ "$sha" =~ ^[0-9a-f]{40}$ && "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  nodev="$(node --version)" || return 1
  bunv="$("$OC_BUN_BIN" --version)" || return 1
  recipe="$(sha256sum "$SCRIPT_DIR/deploy-v5-selfhost.sh" "$SCRIPT_DIR/v5-runtime-release-lib.sh" \
    "$SCRIPT_DIR/lib/v5-selfhost-runtime-build.sh" "$SCRIPT_DIR/lib/v5-selfhost-prewarm.sh" \
    "$SCRIPT_DIR/lib/assert-flavor.sh" "$EXCLUDES" | cut -d' ' -f1)" || return 1
  envkey="$(env | LC_ALL=C grep -E '^(NODE_ENV|BROWSERSLIST[A-Za-z0-9_]*|VITE_[A-Za-z0-9_]*)=' | LC_ALL=C sort || true)"
  printf '%s\0' runtime-prewarm-v1 "$sha" "$image" "$nodev" "$bunv" "$recipe" "$envkey" | sha256sum | cut -d' ' -f1
}

prewarm_verify_runtime() { # <root> <sha> <caps> <full-artifact-digest>
  local rel="$1" sha="$2" caps="$3" digest="$4" want got
  prewarm_trusted_dir "$rel" || return 1
  [[ -f "$rel/MANIFEST.json" && ! -L "$rel/MANIFEST.json" && "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  want="$(printf '%s' "$caps" | tr ' ' '\n' | jq -Rsc 'split("\n") | map(select(length > 0)) | sort')" || return 1
  jq -e --arg sha "$sha" --argjson caps "$want" \
    '.sourceCommit == $sha and ((.capabilities | sort) == $caps)' "$rel/MANIFEST.json" >/dev/null || return 1
  got="$(release_artifact_digest "$rel")" || return 1
  [[ "$got" == "$digest" ]] || return 1
  oc_hotcfg_verify_manifest_sampled "$rel" 64 || return 1
  oc_hotcfg_assert_runtime_mcp_cjs "$rel"
}

prewarm_runtime_receipt() { # <sha> <image>; stdout validated name + digest (no adoption).
  local sha="$1" image="$2" cache key name digest
  cache="$(prewarm_cache_root)"
  prewarm_trusted_dir "$cache" || return 1
  [[ -f "$cache/runtime.json" && ! -L "$cache/runtime.json" ]] || return 1
  key="$(prewarm_runtime_key "$sha" "$image")" || return 1
  name="$(jq -er --arg k "$key" 'select(.schema == 1 and .key == $k) | .name' "$cache/runtime.json")" || return 1
  [[ "$name" =~ ^rel-[0-9a-f]{12}$ ]] || return 1
  digest="$(jq -er .artifactSha256 "$cache/runtime.json")" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s %s\n' "$name" "$digest"
}

prewarm_private_runtime_ready() {
  local receipt name digest cache
  receipt="$(prewarm_runtime_receipt "$1" "$2")" || return 1
  read -r name digest <<<"$receipt"
  cache="$(prewarm_cache_root)"
  prewarm_trusted_dir "$cache/runtime" || return 1
  prewarm_verify_runtime "$cache/runtime/$name" "$1" "$3" "$digest"
}

prewarm_runtime_donor() { # <sha> <image> <caps>; stdout only official adopted path
  local sha="$1" image="$2" caps="$3" cache receipt name digest rel target stage
  receipt="$(prewarm_runtime_receipt "$sha" "$image")" || return 1
  read -r name digest <<<"$receipt"
  cache="$(prewarm_cache_root)"
  rel="$cache/runtime/$name"; target="$OC_HOTCFG_RELEASES_ROOT/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    prewarm_verify_runtime "$target" "$sha" "$caps" "$digest" || return 1
  else
    prewarm_trusted_dir "$cache/runtime" || return 1
    prewarm_verify_runtime "$rel" "$sha" "$caps" "$digest" || return 1
    # Train owns deploy.lock and has stopped the warmer. Never expose a partial rel-* on EXDEV.
    mkdir -p "$OC_HOTCFG_RELEASES_ROOT" || return 1
    stage="$(mktemp -d "$OC_HOTCFG_RELEASES_ROOT/.staging-prewarm-XXXXXXXX")" || return 1
    if ! mv -T -- "$rel" "$stage" || ! prewarm_verify_runtime "$stage" "$sha" "$caps" "$digest" \
      || ! mv -T -- "$stage" "$target"; then
      rm -rf -- "$stage"
      return 1
    fi
  fi
  printf '%s\n' "$target"
}

prewarm_runtime_publish() { # only called for a private, successfully finalized runtime artifact
  local sha="$1" image="$2" rel="$3" cache key digest name caps
  cache="$(prewarm_cache_root)"; name="$(basename "$rel")"
  [[ "$rel" == "$cache/runtime/$name" && "$name" =~ ^rel-[0-9a-f]{12}$ ]] || return 1
  prewarm_recipe_matches "$sha" || return 1
  key="$(prewarm_runtime_key "$sha" "$image")" || return 1
  digest="$(release_artifact_digest "$rel")" || return 1
  caps="$(runtime_caps_from_metadata "$sha")" || return 1
  prewarm_verify_runtime "$rel" "$sha" "$caps" "$digest" || return 1
  jq -n --arg key "$key" --arg name "$name" --arg digest "$digest" \
    '{schema:1,key:$key,name:$name,artifactSha256:$digest}' >"$cache/runtime.json.tmp" || return 1
  mv -f "$cache/runtime.json.tmp" "$cache/runtime.json"
}

prewarm_web_donor() { # same web key, dist digest and full seal as ordinary release donors
  local key="$1" cand rec digest got
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || return 1
  cand="$(prewarm_cache_root)/web-$key"; rec="$cand/$WEB_DIST_REUSE_RECORD"
  prewarm_trusted_dir "$cand" || return 1
  [[ -f "$rec" && ! -L "$rec" ]] || return 1
  jq -e --arg s "$WEB_DIST_REUSE_SCHEMA" --arg k "$key" '.schema == $s and .key == $k' "$rec" >/dev/null || return 1
  digest="$(jq -er .distDigest "$rec")" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  grep -q 'name="oc-build"' "$cand/packages/web-react/dist/index.html" || return 1
  got="$(web_dist_digest "$cand/packages/web-react/dist")" || return 1
  [[ "$got" == "$digest" ]] || return 1
  web_dist_donor_sealed "$cand" || return 1
  printf '%s\n' "$cand"
}

prewarm_cleanup_invocation() {
  local rc="${1:-$?}" status=failed cache="$PREWARM_ATTEMPT_CACHE"
  if [[ -n "$PREWARM_WATCHDOG_PID" ]]; then
    kill "$PREWARM_WATCHDOG_PID" 2>/dev/null || true
    wait "$PREWARM_WATCHDOG_PID" 2>/dev/null || true
    PREWARM_WATCHDOG_PID=""
  fi
  # This exact workspace is assigned only after admission and the exclusive prewarm guard.
  if [[ -n "$PREWARM_WORK" ]]; then
    rm -rf -- "$PREWARM_WORK" || echo 'prewarm: scratch cleanup failed' >&2
    PREWARM_WORK=""
  fi
  if [[ -n "$cache" ]]; then
    if [[ "$PREWARM_PHASE" == runtime && "$PREWARM_RUNTIME_STATUS" == running ]]; then
      PREWARM_RUNTIME_STATUS=failed; PREWARM_RUNTIME_RC="$rc"
    fi
    if [[ "$PREWARM_PHASE" == web && "$PREWARM_WEB_STATUS" == running ]]; then PREWARM_WEB_STATUS=failed; fi
    # Retain only a runtime verified in THIS invocation, including when web failed later.
    if [[ "$PREWARM_RUNTIME_STATUS" != ready ]]; then
      rm -rf -- "$cache/runtime" "$cache/runtime.json" || echo 'prewarm: runtime cleanup failed' >&2
    fi
    rm -f -- "$cache/runtime.json.tmp" "$cache/attempt.json.tmp" || true
    if [[ "$rc" == 0 && "$PREWARM_RUNTIME_STATUS:$PREWARM_WEB_STATUS" == ready:ready ]]; then status=ready
    elif [[ "$PREWARM_RUNTIME_STATUS" == ready || "$PREWARM_WEB_STATUS" == ready ]]; then status=partial; fi
    prewarm_attempt_save "$status" "$rc" || echo 'prewarm: outcome write failed; running attempt remains counted' >&2
    echo "prewarm: outcome=$status phase=$PREWARM_PHASE runtime=$PREWARM_RUNTIME_STATUS runtime_rc=$PREWARM_RUNTIME_RC web=$PREWARM_WEB_STATUS exit=$rc" >&2
    PREWARM_ATTEMPT_CACHE=""
  fi
  return "$rc"
}

cmd_prewarm_artifacts() {
  local sha="${LEASE_TARGET_SHA:-}" cache unit db key donor staging bucket digest pid busy image caps
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "prewarm requires exact target SHA"
  [[ "$DRY" != 1 ]] || { log "[dry-run] prewarm $sha (private cache only)"; return 0; }
  [[ "${OC_V5_SELFHOST_PREWARM:-1}" == 1 && -n "${INVOCATION_ID:-}" ]] || return 0
  unit="$(prewarm_unit "$SELFHOST_DEPLOY_LOCK")"
  pid="$(systemctl show --property=MainPID --value "$unit.service")" || return 0
  [[ "$pid" == "$$" ]] || die "prewarm only runs in its own dedicated service"
  prewarm_recipe_matches "$sha" || { log "prewarm: driver differs from tip; wait for canonical alignment"; return 0; }
  [[ "$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/feat/v5-selfhost)" == "$sha" ]] \
    || { prewarm_skip stale-tip; return 0; }
  db="${OC_V5_LEASE_DB:-/var/lib/openclaude-v5-selfhost/lease.db}"
  prewarm_idle_db "$db" || { prewarm_skip lease-db; return 0; }
  # Guard -> short nonblocking official-lock probe; never hold official lock during a build.
  selfhost_lock_py prepare "$SELFHOST_DEPLOY_LOCK.prewarm" "$SELFHOST_DEPLOY_LOCK_DIR"
  exec 9<>"$SELFHOST_DEPLOY_LOCK.prewarm"
  flock -n 9 || { prewarm_skip prewarm-guard; return 0; }
  selfhost_lock_py prepare "$SELFHOST_DEPLOY_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR"
  exec 8<>"$SELFHOST_DEPLOY_LOCK"
  if ! flock -n 8; then exec 8>&-; prewarm_skip deploy-lock; return 0; fi
  if ! prewarm_idle_db "$db" || release_policy_context_present; then
    exec 8>&-; prewarm_skip lease-or-policy; return 0
  fi
  exec 8>&-
  # P4 preparation adopts these caches without deploy.lock. Share its artifact
  # mutex before any cache write; fd9 remains the speculative worker guard.
  selfhost_lock_py prepare "$SELFHOST_PREPARE_LOCK" "$SELFHOST_DEPLOY_LOCK_DIR"
  exec 10<>"$SELFHOST_PREPARE_LOCK"
  flock -n 10 || { prewarm_skip artifact-lock; return 0; }
  busy="$(master_gate_busy_reason)" || { prewarm_skip host-probe-failed; return 0; }
  [[ -z "$busy" ]] || { prewarm_skip host-busy; return 0; }
  cache="$(prewarm_cache_root)"
  prewarm_attempt_next "$cache" "$sha" >/dev/null || { prewarm_skip retry-policy; return 0; }
  [[ ! -L "$cache" ]] || die "prewarm cache cannot be a symlink"
  ( umask 077; mkdir -p "$cache" )
  prewarm_trusted_dir "$cache" || die "untrusted prewarm cache"
  PREWARM_WORK="$cache/.work"
  rm -rf -- "$PREWARM_WORK" # stale scratch from this dedicated service only; no official releases
  mkdir -m 0700 "$PREWARM_WORK"
  key="$(master_web_dist_key "$sha")" || { prewarm_skip web-key; return 0; }
  for bucket in "$cache"/web-*; do
    [[ "$bucket" == "$cache/web-$key" ]] || rm -rf -- "$bucket"
  done
  prewarm_budget_ok $((12*1024*1024)) 500000 "$cache" || { log "prewarm: disk/inode budget unavailable"; return 0; }
  prewarm_attempt_begin "$cache" "$sha" || die 'prewarm attempt accounting failed'
  # At 9 GiB, cancel with 1 GiB slack above the train's 8 GiB floor. No production PID lookup.
  (
    while prewarm_budget_ok $((9*1024*1024)) 300000 "$cache"; do sleep 1 || break; done
    systemctl kill --signal=KILL --kill-whom=all "$unit.service" || kill -KILL "$$"
  ) &
  PREWARM_WATCHDOG_PID=$!
  export TMPDIR="$PREWARM_WORK/tmp"
  export npm_config_cache="$PREWARM_WORK/npm-cache" BUN_INSTALL_CACHE_DIR="$PREWARM_WORK/bun-cache"
  mkdir -p "$TMPDIR"
  # The normal builder is used unchanged below its cache entry. NEVER launch a Docker install
  # from speculation: killing a Docker client does not prove its daemon-owned container stopped.
  image="$(docker image inspect --format '{{.Id}}' "$RUNTIME_IMAGE")" || die 'prewarm image inspect failed'
  caps="$(runtime_caps_from_metadata "$sha")" || die 'prewarm capabilities unavailable'
  if prewarm_private_runtime_ready "$sha" "$image" "$caps"; then
    PREWARM_RUNTIME_STATUS=ready
    log 'prewarm: retaining verified private runtime for web retry'
  else
    # One speculative runtime at most; never remove official releases.
    rm -rf -- "$cache/runtime" "$cache/runtime.json" "$cache/runtime.json.tmp"
    if (
      trap - EXIT
      PREWARM_RUNTIME_BUILD=1
      OC_HOTCFG_RELEASES_ROOT="$cache/runtime"
      # shellcheck disable=SC2317 # Called indirectly by the shared finalizer.
      oc_hotcfg_install_deps_in_image() { mlog "prewarm: cold runtime deps deferred to train"; return 75; }
      build_runtime_release "$sha" || exit "$?"
      prewarm_runtime_publish "$sha" "$RUNTIME_IMAGE_ID" "$BUILT_RUNTIME_RELEASE"
    ); then
      PREWARM_RUNTIME_STATUS=ready
    else
      PREWARM_RUNTIME_RC=$?; PREWARM_RUNTIME_STATUS=failed
      rm -rf -- "$cache/runtime" "$cache/runtime.json" "$cache/runtime.json.tmp"
      log "prewarm: runtime failed rc=$PREWARM_RUNTIME_RC; ordinary train build remains authoritative"
    fi
  fi
  PREWARM_PHASE=web; PREWARM_WEB_STATUS=running
  prewarm_attempt_save running null || die 'prewarm phase accounting failed'
  if prewarm_web_donor "$key" >/dev/null 2>&1; then
    PREWARM_WEB_STATUS=ready
    return "$PREWARM_RUNTIME_RC"
  fi
  staging="$PREWARM_WORK/web-source"
  mkdir -p "$staging"
  git -C "$REPO_ROOT" archive "$sha" | tar -x -C "$staging" || die "prewarm web archive failed"
  donor="$(find_master_release_donor "$staging/package-lock.json" || true)"
  if [[ -n "$donor" ]]; then
    cp -al "$donor/node_modules" "$staging/node_modules" || die "prewarm deps copy failed"
    break_hardlink_restore_exec "$staging" || die "prewarm deps executables failed"
  else
    ( cd "$staging" && npm ci --no-audit --no-fund ) || die "prewarm npm ci failed"
  fi
  # Keep the exact official command visible to the existing train/CI gate-parity scanner.
  # Both this recipe and the train recipe are included in master_web_dist_key.
  ( cd "$staging" && NODE_OPTIONS='--max-old-space-size=4096' npm run build --workspace packages/web-react ) \
    || die "prewarm web build failed"
  grep -q 'name="oc-build" content="[0-9a-f]\{8,32\}"' "$staging/packages/web-react/dist/index.html" \
    || die "prewarm web build missing oc-build"
  bucket="$PREWARM_WORK/web-bucket"
  mkdir -p "$bucket/packages/web-react"
  mv "$staging/packages/web-react/dist" "$bucket/packages/web-react/dist"
  write_web_dist_reuse_record "$bucket" "$key" built "$sha" || die "prewarm web record failed"
  prewarm_recipe_matches "$sha" || die "prewarm driver changed during build; discard result"
  harden_unique_release_tree "$bucket" || die "prewarm web hardening failed"
  digest="$(release_artifact_digest "$bucket")" || die "prewarm web seal failed"
  jq -n --arg sha "$sha" --arg digest "$digest" \
    '{schemaVersion:2,sourceCommit:$sha,artifactSha256:$digest}' >"$bucket/.complete"
  rm -rf -- "$cache/web-$key"
  mv -T "$bucket" "$cache/web-$key"
  prewarm_web_donor "$key" >/dev/null || die 'prewarm published web verification failed'
  PREWARM_WEB_STATUS=ready
  log "prewarm: web ready, runtime=$PREWARM_RUNTIME_STATUS for ${sha:0:12}; train must reverify and run all gates"
  return "$PREWARM_RUNTIME_RC"
}
