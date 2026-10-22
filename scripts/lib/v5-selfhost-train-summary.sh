# shellcheck shell=bash
# OCV5-539 (phase 3 P0a): every selfhost train writes <trainId>.summary.json.
#
# Record only. Nothing here decides a gate, changes an exit code or aborts a train:
# every function returns 0, and call sites use `tsum_mark X 2>/dev/null || :` so a
# function body extracted into a test (without this lib) still runs.
#
# Phases are sequential: a mark closes the open phase and opens the next. Ids are
# <letter>[.<detail>] (A prep, B deps, C.<gate>, D frontend, P.* package/seal/runtime/
# platform, E1 static gate, E2 migrations, E3.* units, E4 flip+restart, F.* user contract,
# G finish, X.* compensation); a report sums a letter over its sub-phases.
#
# The summary is rewritten after every mark once the train id is known (final=false),
# and once more from the EXIT trap (final=true). A train killed with SIGKILL keeps its
# last partial summary, whose open phase is where it died. Only the shell that called
# tsum_init writes; marks made in a subshell stay in that subshell.
#
# File: ${OC_V5_TRAIN_SUMMARY_DIR:-${OC_V5_LEASE_LOG_DIR:-/opt/openclaude/tmp/lease-trains}}/<trainId>.summary.json
# Cache hits the deploy shell cannot see directly (runtime release and platform bundle run in a
# background subshell or a command substitution) are read from the train log next to it.

TSUM_SCHEMA="oc.v5.selfhost.train-summary/1"
TSUM_ACTIVE=0
TSUM_OWNER=""
TSUM_DIR=""
TSUM_T0=0
TSUM_PRE_INIT_S=0
TSUM_IDS=()
TSUM_STARTS=()
TSUM_ENDS=()
TSUM_LOADS=()
TSUM_NOTE_KEYS=()
TSUM_NOTE_VALS=()
TSUM_LOAD_START=""
TSUM_LOAD_PEAK=""

tsum_now_ms() { # EPOCHREALTIME without a fork; its decimal mark follows the locale
  local us="${EPOCHREALTIME//[!0-9]/}"
  [[ -n "$us" ]] || us="$(date +%s%6N 2>/dev/null)" || us=0
  printf '%s' "$((10#${us:-0} / 1000))"
}

tsum_clean() { # keep a value JSON-safe and short: [A-Za-z0-9._:/@+=-] only
  local v="${1//[!A-Za-z0-9._:\/@+=-]/_}"
  printf '%s' "${v:0:160}"
}

tsum_load1() {
  local a="" rest=""
  read -r a rest </proc/loadavg 2>/dev/null || a=""
  [[ "$a" =~ ^[0-9]+(\.[0-9]+)?$ ]] && printf '%s' "$a"
  return 0
}

tsum_load_peak_update() { # <load1>
  local l="$1"
  [[ -n "$l" ]] || return 0
  if [[ -z "$TSUM_LOAD_PEAK" ]] || awk -v a="$l" -v b="$TSUM_LOAD_PEAK" 'BEGIN{exit !(a>b)}'; then
    TSUM_LOAD_PEAK="$l"
  fi
  return 0
}

tsum_init() { # start recording this deploy (no-op under dry-run or when already active)
  [[ "${DRY:-0}" == 1 || "$TSUM_ACTIVE" == 1 ]] && return 0
  TSUM_ACTIVE=1
  TSUM_OWNER="${BASHPID:-$$}"
  TSUM_DIR="${OC_V5_TRAIN_SUMMARY_DIR:-${OC_V5_LEASE_LOG_DIR:-/opt/openclaude/tmp/lease-trains}}"
  TSUM_T0="$(tsum_now_ms)"
  TSUM_PRE_INIT_S="${SECONDS:-0}"
  TSUM_LOAD_START="$(tsum_load1)"
  tsum_load_peak_update "$TSUM_LOAD_START"
  tsum_mark A
  return 0
}

tsum_mark() { # <phase-id>
  [[ "$TSUM_ACTIVE" == 1 ]] || return 0
  local id now l n
  id="$(tsum_clean "${1:-?}")"
  now="$(tsum_now_ms)"
  l="$(tsum_load1)"
  tsum_load_peak_update "$l"
  n="${#TSUM_IDS[@]}"
  if (( n > 0 )) && [[ -z "${TSUM_ENDS[n-1]}" ]]; then TSUM_ENDS[n-1]="$now"; fi
  TSUM_IDS+=("$id"); TSUM_STARTS+=("$now"); TSUM_ENDS+=(""); TSUM_LOADS+=("${l:-null}")
  tsum_write false "" 2>/dev/null || :
  return 0
}

tsum_note() { # <key> <value>  (last write wins)
  [[ "$TSUM_ACTIVE" == 1 ]] || return 0
  local k v i
  k="$(tsum_clean "${1:-}")"; v="$(tsum_clean "${2:-}")"
  [[ -n "$k" ]] || return 0
  for i in "${!TSUM_NOTE_KEYS[@]}"; do
    if [[ "${TSUM_NOTE_KEYS[i]}" == "$k" ]]; then TSUM_NOTE_VALS[i]="$v"; return 0; fi
  done
  TSUM_NOTE_KEYS+=("$k"); TSUM_NOTE_VALS+=("$v")
  return 0
}

tsum_train_id() {
  local id="${LEASE_TRAIN_ID:-}"
  [[ "$id" =~ ^tr-[A-Za-z0-9-]+$ ]] && printf '%s' "$id"
  return 0
}

tsum_phase_done() { # <phase-id> → rc 0 when that phase was entered and later closed
  local i
  for i in "${!TSUM_IDS[@]}"; do
    [[ "${TSUM_IDS[i]}" == "$1" && -n "${TSUM_ENDS[i]}" ]] && return 0
  done
  return 1
}

tsum_log_cache() { # <train-log> <regex> <phase-that-would-print-it> → hit|miss|unknown
  local logf="$1" re="$2" phase="$3"
  if [[ -n "$logf" && -r "$logf" ]] && grep -qE -- "$re" "$logf" 2>/dev/null; then
    printf hit
  elif [[ -n "$logf" && -r "$logf" ]] && tsum_phase_done "$phase"; then
    printf miss
  else
    printf unknown
  fi
}

tsum_json_str() { if [[ -n "$1" ]]; then printf '"%s"' "$1"; else printf 'null'; fi; }

tsum_write() { # <final:true|false> <exit-rc-or-empty>
  [[ "$TSUM_ACTIVE" == 1 && "${BASHPID:-$$}" == "$TSUM_OWNER" ]] || return 0
  local final="$1" rc="$2" tid out tmp now end i n s e d result failed="" cache_json notes_json phases_json logf
  tid="$(tsum_train_id)"
  [[ -n "$tid" && -d "$TSUM_DIR" && -w "$TSUM_DIR" ]] || return 0
  now="$(tsum_now_ms)"
  n="${#TSUM_IDS[@]}"
  phases_json=""
  for (( i = 0; i < n; i++ )); do
    s="${TSUM_STARTS[i]}"; e="${TSUM_ENDS[i]}"
    if [[ -n "$e" ]]; then d="$((e - s))"; else d="null"; fi
    [[ "${TSUM_IDS[i]}" == X.* ]] || failed="${TSUM_IDS[i]}"
    phases_json+="${phases_json:+,}{\"id\":\"${TSUM_IDS[i]}\",\"startMs\":$((s - TSUM_T0)),\"endMs\":$([[ -n "$e" ]] && echo "$((e - TSUM_T0))" || echo null),\"durationMs\":$d,\"load1AtStart\":${TSUM_LOADS[i]}}"
  done
  if [[ "$final" == true ]]; then
    end="$now"
    (( n > 0 )) && [[ -n "${TSUM_ENDS[n-1]}" ]] && end="${TSUM_ENDS[n-1]}"
    if [[ "$rc" == 0 ]]; then result=success; failed=""; else result=failed; fi
  else
    end=""; result=running; failed=""
  fi
  logf="$TSUM_DIR/$tid.log"
  cache_json="\"nodeModules\":$(tsum_json_str "$(tsum_clean "${MASTER_DEPS_MODE:-}")")"
  cache_json+=",\"frontend\":$(tsum_json_str "$(tsum_clean "${MASTER_FRONTEND_MODE:-}")")"
  cache_json+=",\"runtimeDeps\":\"$(tsum_log_cache "$logf" 'depsCacheKey 命中' P.runtime-wait)\""
  cache_json+=",\"runtimeCcbDist\":\"$(tsum_log_cache "$logf" 'ccbDistKey 命中' P.runtime-wait)\""
  cache_json+=",\"runtimeRelease\":\"$(tsum_log_cache "$logf" 'release rel-[0-9a-f]+ 已存在' P.runtime-wait)\""
  cache_json+=",\"platformBundle\":\"$(tsum_log_cache "$logf" 'bundle rev=[0-9a-f]+ 已存在' P.platform-bundle)\""
  notes_json=""
  for i in "${!TSUM_NOTE_KEYS[@]}"; do
    notes_json+="${notes_json:+,}\"${TSUM_NOTE_KEYS[i]}\":\"${TSUM_NOTE_VALS[i]}\""
  done
  out="$TSUM_DIR/$tid.summary.json"
  tmp="$out.tmp.$$"
  {
    printf '{"schema":"%s","trainId":"%s","final":%s,"result":"%s"' "$TSUM_SCHEMA" "$tid" "$final" "$result"
    printf ',"exitCode":%s,"failedPhase":%s' "${rc:-null}" "$(tsum_json_str "$failed")"
    printf ',"sourceCommit":%s,"pid":%s,"host":%s,"nproc":%s' \
      "$(tsum_json_str "$(tsum_clean "${LEASE_TARGET_SHA:-}")")" "${TSUM_OWNER:-0}" \
      "$(tsum_json_str "$(tsum_clean "$(hostname 2>/dev/null)")")" "$(nproc 2>/dev/null || echo null)"
    printf ',"startedAtMs":%s,"endedAtMs":%s,"durationMs":%s,"preInitSec":%s' \
      "$TSUM_T0" "${end:-null}" "$([[ -n "$end" ]] && echo "$((end - TSUM_T0))" || echo null)" "${TSUM_PRE_INIT_S:-0}"
    printf ',"load":{"start":%s,"peakAtMarks":%s,"samples":%s}' "${TSUM_LOAD_START:-null}" "${TSUM_LOAD_PEAK:-null}" "$((n + 1))"
    printf ',"cache":{%s},"notes":{%s},"phases":[%s]}\n' "$cache_json" "$notes_json" "$phases_json"
  } >"$tmp" 2>/dev/null && mv -f -- "$tmp" "$out" 2>/dev/null || rm -f -- "$tmp" 2>/dev/null
  return 0
}

tsum_finish() { # <exit-rc>  from the EXIT trap; idempotent
  [[ "$TSUM_ACTIVE" == 1 && "${BASHPID:-$$}" == "$TSUM_OWNER" ]] || return 0
  local now n
  now="$(tsum_now_ms)"
  n="${#TSUM_IDS[@]}"
  if (( n > 0 )) && [[ -z "${TSUM_ENDS[n-1]}" ]]; then TSUM_ENDS[n-1]="$now"; fi
  tsum_load_peak_update "$(tsum_load1)"
  tsum_write true "${1:-1}" 2>/dev/null || :
  TSUM_ACTIVE=0
  return 0
}
