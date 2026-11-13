#!/usr/bin/env bash
# One artifact generation, shared by sealing and the official recovery selector.
MODEL_POLICY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_POLICY_CONTRACT_DIR=""
MODEL_POLICY_CONTRACT_MODELS=""
MODEL_POLICY_FILE=""

model_policy_files() {
  printf '%s\n' deploy/v5-selfhost/model-availability.json \
    scripts/lib/selfhost-model-policy.mjs packages/commercial/src/billing/modelAvailability.ts
}

model_policy_require_regular_files() { # <root> <relative-file...>; never follow a bundle/child symlink
  python3 - "$@" <<'MODEL_POLICY_FILES'
from pathlib import Path
import sys
try:
    root = Path(sys.argv[1]).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('release root is not a directory')
    for relative in sys.argv[2:]:
        path = root
        for part in Path(relative).parts:
            if part in ('', '.', '..'):
                raise ValueError('invalid relative bundle path')
            path = path / part
            if path.is_symlink():
                raise ValueError('symlink bundle/child path')
        if not path.is_file():
            raise ValueError('missing/non-regular bundle/child file')
except (OSError, ValueError) as error:
    print('model-policy: ' + str(error), file=sys.stderr)
    sys.exit(78)
MODEL_POLICY_FILES
}

model_policy_require_bundle() { # <artifact-root>; validate with the existing canonical JSON reader
  local root="$1" f
  while IFS= read -r f; do
    model_policy_require_regular_files "$root" "$f" || return 78
  done < <(model_policy_files)
  command node --input-type=module -e \
    'import {pathToFileURL} from "node:url"; const {readSelfhostModelPolicy}=await import(pathToFileURL(process.argv[1]).href); readSelfhostModelPolicy(process.argv[2]);' \
    "$MODEL_POLICY_LIB_DIR/selfhost-model-policy.mjs" "$root/deploy/v5-selfhost/model-availability.json" \
    || { echo 'model-policy: invalid bundle policy' >&2; return 78; }
}

model_policy_generation() { # <release>; legacy means the entire new bundle and generation are absent
  local rel="$1" generation f present=0
  model_policy_require_regular_files "$rel" .complete || return 78
  generation="$(jq -er 'if type!="object" then error("invalid release marker")
    elif has("modelAvailabilityPolicyGeneration") then
      if (.modelAvailabilityPolicyGeneration|type)=="number" and .modelAvailabilityPolicyGeneration==1
      then "1" else error("unknown model policy generation") end
    else "legacy" end' "$rel/.complete")" || return 78
  while IFS= read -r f; do
    if [[ -e "$rel/$f" || -L "$rel/$f" ]]; then present=1; fi
  done < <(model_policy_files)
  if [[ "$generation" == legacy ]]; then
    [[ "$present" == 0 ]] || { echo 'model-policy: unversioned partial bundle' >&2; return 78; }
  else
    model_policy_require_bundle "$rel" || return $?
  fi
  printf '%s\n' "$generation"
}

model_policy_require_forward_release() { # <release>; an old artifact is never a forward fallback
  local generation
  generation="$(model_policy_generation "$1")" || return $?
  [[ "$generation" == 1 ]] || { echo 'model-policy: forward release requires generation 1' >&2; return 78; }
}

model_policy_select_contract_runner() { # <release> <forward|rollback|compensation>
  local rel="$1" context="${2:-forward}" expected="" before generation
  MODEL_POLICY_CONTRACT_DIR=""; MODEL_POLICY_CONTRACT_MODELS=""; MODEL_POLICY_FILE=""
  case "$context" in
    forward) ;;
    rollback)
      [[ "${CUTOVER_ROLLBACK:-0}" == 1 && "$rel" == "${ROLLBACK_MASTER:-}" \
        && "${ROLLBACK_SHA:-}" =~ ^[0-9a-f]{40}$ ]] \
        || { echo 'model-policy: unverified rollback target' >&2; return 78; }
      expected="$ROLLBACK_SHA"
      ;;
    compensation)
      release_policy_require_owner || return 86
      before="$(release_policy_py field before.masterRelease)" || return 79
      expected="$(release_policy_py field before.sourceCommit)" || return 79
      [[ "$rel" == "$before" && "$expected" =~ ^[0-9a-f]{40}$ ]] \
        || { echo 'model-policy: compensation target differs from owned predecessor' >&2; return 78; }
      release_policy_probe_stack before >/dev/null || return $?
      ;;
    *) echo 'model-policy: invalid recovery context' >&2; return 78 ;;
  esac
  generation="$(model_policy_generation "$rel")" || return $?
  if [[ "$context" == forward ]]; then
    [[ "$generation" == 1 ]] || { echo 'model-policy: legacy forward runner refused' >&2; return 78; }
  else
    # The real static gate verifies root/marker ownership, source identity and full artifact digest.
    ( assert_master_release_static_gate "$rel" "$expected" ) || return 78
  fi
  if [[ "$generation" == legacy ]]; then
    model_policy_require_regular_files "$rel" scripts/v5-user-contract-prewarm.mjs scripts/v5-user-contract-smoke.mjs || return 78
    MODEL_POLICY_CONTRACT_DIR="$rel/scripts"
    MODEL_POLICY_CONTRACT_MODELS=gpt-6-luna,deepseek-v4-flash
  else
    MODEL_POLICY_CONTRACT_DIR="$SCRIPT_DIR"
    MODEL_POLICY_FILE="$rel/deploy/v5-selfhost/model-availability.json"
  fi
}
