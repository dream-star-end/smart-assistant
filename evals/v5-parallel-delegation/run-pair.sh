#!/usr/bin/env bash
set -euo pipefail

# Execute one preregistered isolated A/B pair without allowing unrelated work
# between arms. Common capture configuration is inherited from the environment.

required=(
  V5_EVAL_MANIFEST
  V5_EVAL_FIXTURES
  V5_EVAL_SCENARIO
  V5_EVAL_PAIR_ID
  V5_EVAL_ENGINE
  V5_EVAL_RUNS_DIR
  V5_EVAL_PERSONA_BASE_FILE
  V5_EVAL_RULE_FILE
  V5_EVAL_PERSONA_PATH
  V5_EVAL_PROBE_PATH
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required env %s\n' "$name" >&2
    exit 2
  fi
done

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readarray -t bound < <(node - "$V5_EVAL_MANIFEST" "$V5_EVAL_PAIR_ID" "$V5_EVAL_ENGINE" <<'NODE'
const fs = require("node:fs");
const [manifestPath, pairId, engine] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const pair = manifest.pairs?.find((item) => item.pair_id === pairId);
if (!pair) throw new Error(`pair ${pairId} is not preregistered`);
if (!manifest.engines?.[engine]) throw new Error(`engine ${engine} is not preregistered`);
if (!manifest.policy) throw new Error("manifest policy is not bound");
console.log(pair.order);
console.log(manifest.engines[engine].model);
console.log(manifest.engines[engine].effort ?? "");
console.log(manifest.policy.baseline_prompt_rev);
console.log(manifest.policy.personas?.[engine]?.base_persona_rev ?? "");
console.log(manifest.policy.personas?.[engine]?.candidate_persona_rev ?? "");
console.log(manifest.policy.rule_rev);
console.log(manifest.targets[engine].container);
NODE
)
if [[ ${#bound[@]} -ne 8 ]]; then
  printf 'failed to read bound manifest values\n' >&2
  exit 2
fi

export V5_EVAL_ORDER=${bound[0]}
export V5_EVAL_MODEL=${bound[1]}
if [[ -n "${bound[2]}" ]]; then
  export V5_EVAL_EFFORT=${bound[2]}
else
  unset V5_EVAL_EFFORT || true
fi
export V5_EVAL_PROMPT_REV=${bound[3]}
base_rev=${bound[4]}
candidate_rev=${bound[5]}
rule_rev=${bound[6]}
export V5_EVAL_CONTAINER=${bound[7]}
export V5_EVAL_PAIR_EXECUTION_ID=${V5_EVAL_PAIR_EXECUTION_ID:-"$(
  node -e 'console.log(require("node:crypto").randomUUID())'
)"}
mkdir -p -- "$V5_EVAL_RUNS_DIR"

candidate_active=0
restore_candidate() {
  if [[ $candidate_active -eq 1 ]]; then
    if ! node "$HERE/persona-variant.mjs" restore \
      --base "$V5_EVAL_PERSONA_BASE_FILE" \
      --rule "$V5_EVAL_RULE_FILE"; then
      return 1
    fi
    candidate_active=0
  fi
}

cleanup_auth_session() {
  if [[ -z "${V5_EVAL_AUTH_SESSION_FILE:-}" ]]; then
    return 0
  fi
  node "$HERE/auth-session.mjs" logout \
    --base "$V5_EVAL_BASE" \
    --file "$V5_EVAL_AUTH_SESSION_FILE" >/dev/null 2>&1 || true
  node "$HERE/auth-session.mjs" cleanup \
    --file "$V5_EVAL_AUTH_SESSION_FILE"
}

cleanup_pair() {
  local status=$?
  local restore_status=0
  local auth_status=0
  set +e
  restore_candidate
  restore_status=$?
  cleanup_auth_session
  auth_status=$?
  trap - EXIT
  if [[ $status -eq 0 && $restore_status -ne 0 ]]; then
    status=$restore_status
  elif [[ $status -eq 0 && $auth_status -ne 0 ]]; then
    status=$auth_status
  fi
  exit "$status"
}
trap cleanup_pair EXIT

apply_candidate() {
  candidate_active=1
  node "$HERE/persona-variant.mjs" apply \
    --base "$V5_EVAL_PERSONA_BASE_FILE" \
    --rule "$V5_EVAL_RULE_FILE"
}

run_arm() {
  local arm=$1
  local step=$2
  export V5_EVAL_ARM=$arm
  export V5_EVAL_PAIR_STEP=$step
  export V5_EVAL_OUTPUT="$V5_EVAL_RUNS_DIR/$V5_EVAL_ENGINE-$V5_EVAL_SCENARIO-$V5_EVAL_PAIR_ID-$arm.json"
  export V5_EVAL_PERSONA_BASE_REV=$base_rev
  if [[ $arm == A ]]; then
    export V5_EVAL_PERSONA_REV=$base_rev
    export V5_EVAL_RULE_INJECTION=none
    unset V5_EVAL_RULE_REV || true
  else
    export V5_EVAL_PERSONA_REV=$candidate_rev
    export V5_EVAL_RULE_INJECTION=persona-system-slot
    export V5_EVAL_RULE_REV=$rule_rev
  fi
  node "$HERE/capture.mjs"
}

if [[ $V5_EVAL_ORDER == A_FIRST ]]; then
  run_arm A 1
  apply_candidate
  run_arm B 2
  restore_candidate
else
  apply_candidate
  run_arm B 1
  restore_candidate
  run_arm A 2
fi
