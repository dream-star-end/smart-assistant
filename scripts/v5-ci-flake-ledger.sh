#!/usr/bin/env bash
# v5-ci-flake-ledger.sh — observe-only flake candidate ledger (OCV5-119 / R8' phase 1).
#
#   record <sha>     pull v5-ci.yml runs for that SHA, classify attempt 1 vs last
#   report [--days N] aggregate JSONL by signature (always exit 0)
#
# Depends: gh, jq. Does not change CI / deploy green-gate outcomes.
# Ledger path: ${OC_V5_FLAKE_LEDGER:-/opt/openclaude/var/v5-ci-flake-ledger.jsonl}
set -euo pipefail

usage() {
  echo "usage: $0 record <40-hex-sha>" >&2
  echo "       $0 report [--days N]" >&2
  exit 2
}

LEDGER="${OC_V5_FLAKE_LEDGER:-/opt/openclaude/var/v5-ci-flake-ledger.jsonl}"
SELF_JOB="ci-classify"

_gh() {
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy gh "$@"
}

json_escape() {
  jq -n --arg s "$1" '$s'
}

# Classify a jobs API payload (stdin) → one line: class<TAB>json-array-of-failed-signatures
classify_jobs_payload() {
  jq -r --arg self "$SELF_JOB" '
    def infra_step:
      . as $n
      | ($n == "Install dependencies"
         or $n == "Setup Node"
         or $n == "Wait for test fixtures"
         or $n == "Wait for test fixture"
         or $n == "Checkout"
         or ($n | startswith("Upload ")));
    def first_fail_step:
      ([.steps[]? | select(.conclusion == "failure") | .name] | .[0] // "unknown");
    def is_fail:
      .conclusion == "failure" or .conclusion == "timed_out";
    [
      .jobs[]?
      | select(.name != $self)
      | select(is_fail)
      | {
          name,
          step: first_fail_step,
          infra: (first_fail_step | infra_step)
        }
    ] as $fails
    | if ($fails | length) == 0 then
        "passed\t[]"
      elif ([$fails[] | select(.infra != true)] | length) == 0 then
        "infra-error\t" + ([$fails[] | "\(.name)::\(.step)::unknown"] | tojson)
      else
        "failed\t" + ([$fails[] | "\(.name)::\(.step)::unknown"] | tojson)
      end
  '
}

# stdout: class
fetch_attempt_class() {
  local run_id="$1" attempt="$2"
  local jobs payload class_line class
  jobs="$(_gh api "repos/{owner}/{repo}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" 2>/dev/null || true)"
  if [[ -z "$jobs" || "$jobs" == "null" ]]; then
    jobs="$(_gh api "repos/{owner}/{repo}/actions/runs/${run_id}/jobs?per_page=100" 2>/dev/null || true)"
  fi
  if [[ -z "$jobs" ]]; then
    echo "unknown"
    return 0
  fi
  class_line="$(printf '%s' "$jobs" | classify_jobs_payload)"
  class="${class_line%%$'\t'*}"
  printf '%s\n' "$class"
}

# stdout: signatures JSON array for a failed/infra attempt
fetch_attempt_signatures() {
  local run_id="$1" attempt="$2"
  local jobs class_line sigs
  jobs="$(_gh api "repos/{owner}/{repo}/actions/runs/${run_id}/attempts/${attempt}/jobs?per_page=100" 2>/dev/null || true)"
  if [[ -z "$jobs" || "$jobs" == "null" ]]; then
    jobs="$(_gh api "repos/{owner}/{repo}/actions/runs/${run_id}/jobs?per_page=100" 2>/dev/null || true)"
  fi
  if [[ -z "$jobs" ]]; then
    echo '[]'
    return 0
  fi
  class_line="$(printf '%s' "$jobs" | classify_jobs_payload)"
  sigs="${class_line#*$'\t'}"
  if [[ -z "$sigs" ]]; then
    echo '[]'
  else
    printf '%s\n' "$sigs"
  fi
}

try_artifact_class() {
  local run_id="$1" attempt="$2" dir class
  dir="$(mktemp -d)"
  if _gh run download "$run_id" --name ci-classification --dir "$dir" >/dev/null 2>&1; then
    local f
    f="$(find "$dir" -name 'ci-classification.json' -print -quit 2>/dev/null || true)"
    if [[ -n "$f" ]]; then
      class="$(jq -r --argjson a "$attempt" 'select(.run_attempt == $a) | .class' "$f" 2>/dev/null || true)"
      if [[ -n "$class" && "$class" != "null" ]]; then
        rm -rf "$dir"
        printf '%s\n' "$class"
        return 0
      fi
      # Artifact from this run but attempt field mismatch: still use it for the latest attempt.
      class="$(jq -r '.class // empty' "$f" 2>/dev/null || true)"
      if [[ -n "$class" ]]; then
        rm -rf "$dir"
        printf '%s\n' "$class"
        return 0
      fi
    fi
  fi
  rm -rf "$dir"
  return 1
}

ledger_has() {
  local sha="$1" signature="$2" hit
  [[ -f "$LEDGER" ]] || return 1
  hit="$(jq -s --arg sha "$sha" --arg sig "$signature" \
    'any(.sha == $sha and .signature == $sig)' "$LEDGER" 2>/dev/null || echo false)"
  [[ "$hit" == "true" ]]
}

append_candidate() {
  local sha="$1" run_id="$2" attempt="$3" signature="$4" class_at_first="$5"
  if ledger_has "$sha" "$signature"; then
    return 0
  fi
  mkdir -p "$(dirname "$LEDGER")"
  jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg sha "$sha" \
    --argjson run_id "$run_id" \
    --argjson attempt "$attempt" \
    --arg signature "$signature" \
    --arg class_at_first "$class_at_first" \
    '{ts:$ts, sha:$sha, run_id:$run_id, attempt:$attempt, signature:$signature, class_at_first:$class_at_first, owner:null, expires:null, status:"candidate"}' \
    >> "$LEDGER"
}

cmd_record() {
  local sha="${1:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "record: sha must be 40-hex" >&2; exit 2; }
  local payload runs
  mkdir -p "$(dirname "$LEDGER")"
  : >> "$LEDGER"
  payload="$(_gh api "repos/{owner}/{repo}/actions/workflows/v5-ci.yml/runs?head_sha=${sha}&per_page=100")"
  runs="$(printf '%s' "$payload" | jq -c '.workflow_runs // []')"
  local n
  n="$(printf '%s' "$runs" | jq 'length')"
  echo "flake-ledger record sha=$sha runs=$n ledger=$LEDGER"
  local i run_id attempt first_class last_class sigs sig
  i=0
  while (( i < n )); do
    run_id="$(printf '%s' "$runs" | jq -r ".[$i].id")"
    attempt="$(printf '%s' "$runs" | jq -r ".[$i].run_attempt // 1")"
    [[ "$attempt" =~ ^[1-9][0-9]*$ ]] || attempt=1
    last_class="$(try_artifact_class "$run_id" "$attempt" || fetch_attempt_class "$run_id" "$attempt")"
    first_class="$(fetch_attempt_class "$run_id" 1)"
    echo "  run=$run_id attempts=$attempt first=$first_class last=$last_class"
    if [[ "$first_class" == "failed" || "$first_class" == "infra-error" ]] && [[ "$last_class" == "passed" ]]; then
      sigs="$(fetch_attempt_signatures "$run_id" 1)"
      while IFS= read -r sig; do
        [[ -n "$sig" ]] || continue
        append_candidate "$sha" "$run_id" 1 "$sig" "$first_class"
        echo "  + candidate $sig"
      done < <(printf '%s' "$sigs" | jq -r '.[]')
    fi
    i=$((i + 1))
  done
}

cmd_report() {
  local days=7
  if [[ "${1:-}" == "--days" ]]; then
    days="${2:-7}"
  fi
  [[ "$days" =~ ^[1-9][0-9]*$ ]] || days=7
  echo "flake-ledger report days=$days file=$LEDGER"
  if [[ ! -f "$LEDGER" ]]; then
    echo "(empty — no ledger file)"
    return 0
  fi
  jq -s --argjson days "$days" '
    group_by(.signature)
    | map({
        signature: .[0].signature,
        count: length,
        first: (map(.ts) | min),
        last: (map(.ts) | max),
        owner: (.[0].owner),
        status: (.[0].status),
        stale_unowned: ((map(.ts) | max | fromdateiso8601) as $last | (now - $last) / 86400 >= ($days|tonumber) and (.[0].owner == null))
      })
    | sort_by(-.count, .signature)
  ' "$LEDGER" 2>/dev/null | jq -r '
    ["signature","count","first","last","owner","stale_unowned"],
    (.[] | [.signature, (.count|tostring), .first, .last, (.owner // "-"), (if .stale_unowned then "YES" else "" end)])
    | @tsv
  ' || {
    echo "(ledger unreadable; not failing — observe-only)"
    return 0
  }
  return 0
}

cmd="${1:-}"
case "$cmd" in
  record)
    shift
    cmd_record "${1:-}"
    ;;
  report)
    shift
    cmd_report "$@"
    ;;
  *)
    usage
    ;;
esac
