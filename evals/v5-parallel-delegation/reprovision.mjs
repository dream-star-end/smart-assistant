#!/usr/bin/env node
/**
 * Reprovision one isolated-eval arm through the supported V5 admin restart API.
 *
 * Authentication is pair-scoped: the first arm creates the secure session
 * bundle with the pair's only login, while later arms reuse or refresh it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _internals,
  authorizedFetch,
  ensureAuthSession,
  loginAuthSession,
  writeAuthSession,
} from "./auth-session.mjs";

const requiredEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
};

const MANIFEST_PATH = resolve(requiredEnv("V5_EVAL_MANIFEST"));
const ENGINE = requiredEnv("V5_EVAL_ENGINE");
const PAIR_STEP = requiredEnv("V5_EVAL_PAIR_STEP");
const EMAIL = requiredEnv("V5_EVAL_EMAIL");
const PASSWORD_FILE = resolve(requiredEnv("V5_EVAL_PASSWORD_FILE"));
const AUTH_SESSION_FILE = resolve(requiredEnv("V5_EVAL_AUTH_SESSION_FILE"));
const BASE = requiredEnv("V5_EVAL_BASE").replace(/\/$/, "");
const SSH_HOST = process.env.V5_EVAL_SSH_HOST?.trim() || "kl-mirror";
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const target = manifest.targets?.[ENGINE];

if (!["ccb", "codex"].includes(ENGINE)) {
  throw new Error("V5_EVAL_ENGINE must be ccb or codex");
}
if (!["1", "2"].includes(PAIR_STEP)) {
  throw new Error("V5_EVAL_PAIR_STEP must be exactly 1 or 2");
}
if (
  !target ||
  !manifest.engines?.[ENGINE] ||
  !manifest.baseline_lane ||
  !manifest.baseline_runtime_tuple ||
  !manifest.policy?.personas?.[ENGINE]
) {
  throw new Error("manifest is not bound for reprovision");
}
if (
  !Number.isSafeInteger(target.user_id) ||
  target.user_id <= 0 ||
  typeof target.container !== "string" ||
  !/^oc-v5-u[1-9][0-9]*$/.test(target.container)
) {
  throw new Error("manifest reprovision target is invalid");
}
if (
  !Number.isFinite(manifest.max_container_age_before_pair_ms) ||
  manifest.max_container_age_before_pair_ms <= 0
) {
  throw new Error("manifest fresh-container age gate is invalid");
}

const selfBytes = readFileSync(fileURLToPath(import.meta.url));
const selfRev = createHash("sha256").update(selfBytes).digest("hex");
if (manifest.policy.reprovision_rev !== selfRev) {
  throw new Error(
    `reprovision helper rev ${selfRev} differs from manifest ${manifest.policy.reprovision_rev ?? "<missing>"}`,
  );
}

const authSessionExists = existsSync(AUTH_SESSION_FILE);
if (PAIR_STEP === "1" && authSessionExists) {
  throw new Error("pair step 1 requires an absent auth session");
}
if (PAIR_STEP === "2" && !authSessionExists) {
  throw new Error("pair step 2 requires the existing pair auth session");
}
if (PAIR_STEP === "2") {
  await ensureAuthSession(BASE, AUTH_SESSION_FILE);
} else {
  _internals.requireSecureDirectory(dirname(AUTH_SESSION_FILE));
  const password = readFileSync(PASSWORD_FILE, "utf8").trim();
  const authSession = await loginAuthSession(BASE, EMAIL, password);
  writeAuthSession(AUTH_SESSION_FILE, authSession);
}

const remoteRestart = String.raw`set -euo pipefail
uid=$1
container=$2
set -a
source /etc/openclaude/commercial-v5.env
set +a

row=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -v uid="$uid" <<'SQL'
SELECT id,container_internal_id
FROM agent_containers
WHERE user_id=:'uid'::bigint AND state='active' AND runtime_channel='v5'
ORDER BY id DESC;
SQL
)
test "$(printf '%s\n' "$row" | grep -c .)" -eq 1
IFS='|' read -r row_id old_cid <<<"$row"
old_docker=$(docker inspect -f '{{.Id}}' "$container")
test "$old_cid" = "$old_docker"
active=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -v uid="$uid" <<'SQL'
SELECT count(*) FROM turn_dispatches
WHERE user_id=:'uid'::bigint AND status IN ('admitted','accepted','rejecting');
SQL
)
test "$active" = 0

lane=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -c \
  "SELECT generation,phase,active_slot,coalesce(candidate_slot,''),active_release,cohort_percent
   FROM deploy_state WHERE singleton=true")
IFS='|' read -r generation phase slot candidate active_release cohort <<<"$lane"
test "$phase" = stable
test -z "$candidate"
test "$cohort" = 0
case "$slot" in
  A) home=/root/.openclaude-v5; src=/opt/openclaude/openclaude-v5 ;;
  B) home=/root/.openclaude-v5-b; src=/opt/openclaude/openclaude-v5-b ;;
  *) exit 1 ;;
esac
port=$(jq -r .gateway.port "$home/openclaude.json")

cd "$src"
ROW_ID=$row_id PORT=$port node --input-type=module <<'NODE'
import { SignJWT } from "jose";
import { randomBytes } from "node:crypto";
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ role: "admin" })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject("1")
  .setIssuedAt(now)
  .setExpirationTime(now + 300)
  .setJti(randomBytes(16).toString("hex"))
  .sign(new TextEncoder().encode(process.env.COMMERCIAL_JWT_SECRET));
const response = await fetch(
  "http://127.0.0.1:" + process.env.PORT +
    "/api/admin/agent-containers/" + process.env.ROW_ID + "/restart",
  {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      "user-agent": "v5-parallel-delegation-eval",
    },
    body: "{}",
  },
);
const body = await response.text();
if (!response.ok) throw new Error(response.status + ": " + body);
NODE
jq -nc \
  --arg old_id "$old_docker" \
  --arg generation "$generation" \
  --arg slot "$slot" \
  --arg active_release "$active_release" \
  '{old_id:$old_id,generation:$generation,slot:$slot,active_release:$active_release}'
`;

const restart = JSON.parse(execFileSync(
  "ssh",
  [SSH_HOST, "bash", "-s", "--", String(target.user_id), target.container],
  { input: remoteRestart, encoding: "utf8", maxBuffer: 1024 * 1024 },
));
if (
  restart.generation !== manifest.baseline_lane.generation ||
  restart.slot !== manifest.baseline_lane.active_slot ||
  restart.active_release !== manifest.baseline_lane.active_release
) {
  throw new Error(`deploy lane changed before restart: ${JSON.stringify(restart)}`);
}

const personaDeadline = Date.now() + 120_000;
for (;;) {
  const persona = await authorizedFetch(
    BASE,
    AUTH_SESSION_FILE,
    `${BASE}/api/agents/main/persona`,
  );
  if (persona.ok) {
    const body = await persona.json();
    if (typeof body.text !== "string") throw new Error("persona response missing text");
    const personaRev = createHash("sha256").update(body.text).digest("hex");
    if (personaRev !== manifest.policy.personas[ENGINE].base_persona_rev) {
      throw new Error(`provisioned persona rev differs from base: ${personaRev}`);
    }
    break;
  }
  const body = await persona.text();
  if (persona.status !== 503 || !body.includes("CONTAINER_UNREADY")) {
    throw new Error(`persona GET failed ${persona.status}: ${body.slice(0, 200)}`);
  }
  if (Date.now() >= personaDeadline) {
    throw new Error("container did not provision within 120s");
  }
  await new Promise((done) => setTimeout(done, 1000));
}

const remoteInspect = String.raw`set -euo pipefail
uid=$1
container=$2
old_docker=$3
set -a
source /etc/openclaude/commercial-v5.env
set +a
inspect=$(docker inspect "$container")
docker_id=$(jq -r '.[0].Id' <<<"$inspect")
test "$docker_id" != "$old_docker"
row=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F '|' -v uid="$uid" -v cid="$docker_id" <<'SQL'
SELECT id,container_internal_id
FROM agent_containers
WHERE user_id=:'uid'::bigint AND state='active' AND runtime_channel='v5'
  AND container_internal_id=:'cid';
SQL
)
test "$(printf '%s\n' "$row" | grep -c .)" -eq 1
tuple=$(jq -c '
  (.[0].Config.Env | map(split("=") | {(.[0]): (.[1:] | join("="))}) | add) as $e |
  (.[0].Config.Labels // {}) as $l |
  {
    image: ($e.OC_RUNTIME_IMAGE // .[0].Config.Image),
    image_id: ($e.OC_RUNTIME_IMAGE_ID // $l["com.openclaude.runtime.image_id"] // .[0].Image),
    runtime_release: ($e.OC_RUNTIME_RELEASE // $l["com.openclaude.runtime.release"]),
    platform_bundle: ($e.OC_PLATFORM_BUNDLE // $l["com.openclaude.runtime.bundle_rev"])
  }' <<<"$inspect")
started_at=$(jq -r '.[0].State.StartedAt' <<<"$inspect")
persona=$(docker exec "$container" sha256sum /home/agent/.openclaude/agents/main/CLAUDE.md | awk '{print $1}')
prompt=$(docker exec "$container" sh -lc \
  'sha256sum "$OPENCLAUDE_PLATFORM_PROMPTS_DIR/platform-capabilities.md"' | awk '{print $1}')
fresh=$(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -v uid="$uid" -v started="$started_at" <<'SQL'
SELECT json_build_object(
  'dispatches',(SELECT count(*)::int FROM turn_dispatches
    WHERE user_id=:'uid'::bigint AND admitted_at>=:'started'::timestamptz),
  'usage_rows',(SELECT count(*)::int FROM usage_records
    WHERE user_id=:'uid'::bigint AND created_at>=:'started'::timestamptz),
  'active',(SELECT count(*)::int FROM turn_dispatches
    WHERE user_id=:'uid'::bigint AND status IN ('admitted','accepted','rejecting'))
)::text;
SQL
)
jq -nc \
  --arg id "$docker_id" \
  --arg created_at "$(jq -r '.[0].Created' <<<"$inspect")" \
  --arg started_at "$started_at" \
  --argjson restart_count "$(jq -r '.[0].RestartCount' <<<"$inspect")" \
  --argjson runtime_tuple "$tuple" \
  --arg persona "$persona" \
  --arg prompt "$prompt" \
  --argjson fresh "$fresh" \
  '{id:$id,created_at:$created_at,started_at:$started_at,restart_count:$restart_count,
    runtime_tuple:$runtime_tuple,persona:$persona,prompt:$prompt,fresh:$fresh}'
`;

let inspected;
const inspectDeadline = Date.now() + 120_000;
for (;;) {
  try {
    inspected = JSON.parse(execFileSync(
      "ssh",
      [SSH_HOST, "bash", "-s", "--", String(target.user_id), target.container, restart.old_id],
      { input: remoteInspect, encoding: "utf8", maxBuffer: 1024 * 1024 },
    ));
    break;
  } catch (error) {
    if (Date.now() >= inspectDeadline) throw error;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

const containerAge = Date.now() - Date.parse(inspected.started_at);
if (
  inspected.restart_count !== 0 ||
  !Number.isFinite(containerAge) ||
  containerAge < 0 ||
  containerAge > manifest.max_container_age_before_pair_ms ||
  JSON.stringify(inspected.runtime_tuple) !== JSON.stringify(manifest.baseline_runtime_tuple) ||
  inspected.persona !== manifest.policy.personas[ENGINE].base_persona_rev ||
  inspected.prompt !== manifest.policy.baseline_prompt_rev ||
  inspected.fresh.dispatches !== 0 ||
  inspected.fresh.usage_rows !== 0 ||
  inspected.fresh.active !== 0
) {
  throw new Error(`fresh container verification failed: ${JSON.stringify(inspected)}`);
}

console.log(JSON.stringify({
  engine: ENGINE,
  helper_rev: selfRev,
  old_id: restart.old_id,
  ...inspected,
}));
