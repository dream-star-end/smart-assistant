#!/usr/bin/env bash
set -euo pipefail

# Capture one post-activation B-only/platform-bundle smoke run. Reprovision the
# synthetic container before every invocation; capture.mjs proves it is fresh.

required=(
  V5_EVAL_MANIFEST
  V5_EVAL_FIXTURES
  V5_EVAL_SCENARIO
  V5_EVAL_ENGINE
  V5_EVAL_RUNS_DIR
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
readarray -t bound < <(node - \
  "$V5_EVAL_MANIFEST" "$V5_EVAL_ENGINE" "$V5_EVAL_SCENARIO" <<'NODE'
const fs = require("node:fs");
const [manifestPath, engine, scenario] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!manifest.production) throw new Error("manifest lacks frozen production evidence");
if (!manifest.engines?.[engine]) throw new Error(`engine ${engine} is not preregistered`);
if (!manifest.production.smoke_scenarios?.includes(scenario)) {
  throw new Error(`scenario ${scenario} is not a production smoke scenario`);
}
const pair = manifest.pairs.find(
  (item) => item.pair_id === manifest.production.smoke_pair_id,
);
if (!pair) throw new Error("production smoke pair is not preregistered");
console.log(manifest.engines[engine].model);
console.log(manifest.engines[engine].effort ?? "");
console.log(manifest.policy.candidate_prompt_rev);
console.log(manifest.policy.personas?.[engine]?.base_persona_rev ?? "");
console.log(manifest.policy.rule_rev);
console.log(manifest.targets[engine].container);
console.log(pair.pair_id);
console.log(pair.order);
NODE
)
if [[ ${#bound[@]} -ne 8 ]]; then
  printf 'failed to read production smoke manifest values\n' >&2
  exit 2
fi

export V5_EVAL_MODEL=${bound[0]}
if [[ -n "${bound[1]}" ]]; then
  export V5_EVAL_EFFORT=${bound[1]}
else
  unset V5_EVAL_EFFORT || true
fi
export V5_EVAL_PROMPT_REV=${bound[2]}
export V5_EVAL_PERSONA_BASE_REV=${bound[3]}
export V5_EVAL_PERSONA_REV=${bound[3]}
export V5_EVAL_RULE_REV=${bound[4]}
export V5_EVAL_CONTAINER=${bound[5]}
export V5_EVAL_PAIR_ID=${bound[6]}
export V5_EVAL_ORDER=${bound[7]}
export V5_EVAL_ARM=B
export V5_EVAL_PAIR_STEP=1
export V5_EVAL_RULE_INJECTION=platform-bundle
export V5_EVAL_PAIR_EXECUTION_ID=$(
  node -e 'console.log(require("node:crypto").randomUUID())'
)
mkdir -p -- "$V5_EVAL_RUNS_DIR"
export V5_EVAL_OUTPUT=\
"$V5_EVAL_RUNS_DIR/$V5_EVAL_ENGINE-$V5_EVAL_SCENARIO-$V5_EVAL_PAIR_ID-B.json"
node "$HERE/capture.mjs"
