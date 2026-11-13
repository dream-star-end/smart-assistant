#!/usr/bin/env bash
# Opt-in, synthetic P0 only. Never starts a gateway or model client.
set -euo pipefail
[[ ${OC_AGENT_REMOTE_P0:-0} == 1 ]] || { echo 'P0 disabled; set OC_AGENT_REMOTE_P0=1 explicitly' >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
[[ $repo == */ocv5-agentremote-t1555u ]] || { echo 'unexpected task worktree' >&2; exit 2; }
export TMPDIR="$repo/.task-tmp"
mkdir -p "$TMPDIR" "$repo/.task-cache" "$repo/.task-evidence"
disk_guard() {
  local avail
  avail=$(df -B1 --output=avail "$repo" | tail -1)
  [[ $avail -ge 8000000000 ]] || { echo 'BLOCKER: disk below 8 GB' >&2; exit 3; }
}
image='docker.io/opensandbox/execd@sha256:c75836c46ef4302afccec182d5d7339eb2f905f51e3d73b7aa17bb76c832526c'
ctr=oc-v5-agentremote-p0-t1555u-20261101
net=oc-v5-agentremote-p0-t1555u-net
label=AGENT-REMOTE-T1555U
created_ctr=0
created_net=0
cleanup() {
  rc=$?
  trap - EXIT INT TERM
  if [[ $created_ctr == 1 ]] && [[ $(docker inspect -f '{{index .Config.Labels "oc.task"}}' "$ctr" 2>/dev/null) == "$label" ]]; then
    docker rm -f "$ctr" >> "$repo/.task-evidence/cleanup.log" 2>&1 || rc=1
  fi
  if [[ $created_net == 1 ]] && [[ $(docker network inspect -f '{{index .Labels "oc.task"}}' "$net" 2>/dev/null) == "$label" ]]; then
    docker network rm "$net" >> "$repo/.task-evidence/cleanup.log" 2>&1 || rc=1
  fi
  rm -f -- "$repo/.task-tmp/execd-test.env"
  if [[ $(df -B1 --output=avail "$repo" | tail -1) -lt 8000000000 ]]; then
    echo 'BLOCKER: disk below 8 GB; cleaning only task artifacts' >> "$repo/.task-evidence/cleanup.log"
    if [[ -f "$repo/.task-cache/image-owned" ]]; then docker image rm "$image" >> "$repo/.task-evidence/cleanup.log" 2>&1 || true; fi
    rm -rf -- "$repo/.task-cache" "$repo/.task-tmp"
    rc=3
  fi
  printf '%s\n' "$rc" > "$repo/.task-evidence/run.exit"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
disk_guard
# Existing names are never adopted or removed.
! docker inspect "$ctr" >/dev/null 2>&1 || { echo 'task container name already exists' >&2; exit 2; }
! docker network inspect "$net" >/dev/null 2>&1 || { echo 'task network name already exists' >&2; exit 2; }
if ! docker image inspect "$image" >/dev/null 2>&1; then touch "$repo/.task-cache/image-owned"; docker pull "$image"; fi
disk_guard
mkdir -p "$TMPDIR/world" "$TMPDIR/worker-home" "$TMPDIR/worker-cwd" "$TMPDIR/worker-config"
printf 'WORKER_TRAP\n' > "$TMPDIR/world/sentinel.txt"
printf 'WORKER_ORIGINAL\n' > "$TMPDIR/world/edit.txt"
printf 'WORKER_UNTOUCHED\n' > "$TMPDIR/world/write.txt"
python3 - "$repo" <<'PY'
import pathlib,secrets,sys
r=pathlib.Path(sys.argv[1]);p=r/'.task-tmp/execd-test.env'
p.write_text('EXECD_ACCESS_TOKEN='+secrets.token_hex(24)+'\n');p.chmod(0o600)
PY
disk_guard
docker network create --label "oc.task=$label" "$net" > "$repo/.task-evidence/network.id"
created_net=1
docker create --name "$ctr" --label "oc.task=$label" --cpus 1 --memory 768m --memory-swap 768m --pids-limit 128 --read-only --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges --network "$net" -p 127.0.0.1::44772 --tmpfs "$TMPDIR:rw,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700" -e "P0ROOT=$TMPDIR" -e "TMPDIR=$TMPDIR/tmp" -e "HOME=$TMPDIR/home" -e EXECD_RUNTIME_INIT=false --env-file "$TMPDIR/execd-test.env" --entrypoint /bin/sh "$image" -c 'mkdir -p "$P0ROOT/tmp" "$P0ROOT/home" "$P0ROOT/world" "$P0ROOT/isolation"; printf "upper_root = \"%s/isolation\"\n" "$P0ROOT" > "$P0ROOT/isolation.toml"; printf "REMOTE_SENTINEL\n" > "$P0ROOT/world/sentinel.txt"; printf "before: 中文🌏\n" > "$P0ROOT/world/edit.txt"; cd "$P0ROOT/world"; exec /execd --port 44772 --isolation-config "$P0ROOT/isolation.toml"' > "$repo/.task-evidence/container.id"
created_ctr=1
disk_guard
start_ns=$(date +%s%N)
docker start "$ctr" >/dev/null
port=$(docker port "$ctr" 44772/tcp | sed -n 's/^127\.0\.0\.1://p')
[[ $port =~ ^[0-9]+$ ]] || { echo 'no loopback-only published port' >&2; exit 1; }
export P0_ENDPOINT="http://127.0.0.1:$port" P0_CONTAINER="$ctr" P0_FIXTURE_ROOT="$TMPDIR/world" P0_EVIDENCE="$repo/.task-evidence" P0_TEST_ENV="$TMPDIR/execd-test.env" P0_TASK_REPO="$repo"
# Bounded readiness, no model requests. /ping is explicitly unauthenticated.
ready=0
for _ in {1..40}; do
  if curl --noproxy '*' -fsS --max-time 1 "$P0_ENDPOINT/ping" >/dev/null; then ready=1; break; fi
  sleep 0.1
done
[[ $ready == 1 ]] || { docker logs "$ctr" > "$repo/.task-evidence/execd-startup.log" 2>&1; echo 'execd readiness failed' >&2; exit 1; }
printf '%s\n' "$(( ($(date +%s%N) - start_ns) / 1000000 ))" > "$repo/.task-evidence/cold-start-ms.txt"
docker inspect --format '{"name":{{json .Name}},"image":{{json .Image}},"memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"pids":{{.HostConfig.PidsLimit}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}' "$ctr" > "$repo/.task-evidence/container-limits.json"
docker exec "$ctr" /bin/sh -c 'set -eu; id; printf "pidns="; readlink /proc/self/ns/pid; printf "shell="; command -v bash || command -v sh; cat /proc/self/mountinfo' > "$repo/.task-evidence/container-identity.txt"
# Explicit environment whitelist; no real credentials/configuration inherited.
cd "$repo/claude-code-best"
disk_guard
env -i PATH=/usr/bin:/bin OC_AGENT_REMOTE_P0=1 P0_ENDPOINT="$P0_ENDPOINT" P0_CONTAINER="$ctr" P0_FIXTURE_ROOT="$P0_FIXTURE_ROOT" P0_EVIDENCE="$P0_EVIDENCE" P0_TEST_ENV="$P0_TEST_ENV" P0_TASK_REPO="$repo" HOME="$TMPDIR/worker-home" TMPDIR="$TMPDIR" CLAUDE_CONFIG_DIR="$TMPDIR/worker-config" OPENCLAUDE_HOME="$TMPDIR/worker-home" XDG_CACHE_HOME="$repo/.task-cache" DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 SKILL_LEARNING_ENABLED=0 FEATURE_SKILL_LEARNING=0 bun scripts/agent-remote-p0-harness.ts
# Independent checks touch only this task's own container.
docker exec "$ctr" /bin/sh -c 'set -eu; sha256sum "$P0ROOT/world/sentinel.txt" "$P0ROOT/world/edit.txt" "$P0ROOT/world/write.txt"; cat "$P0ROOT/world/edit.txt"; cat "$P0ROOT/world/write.txt"; test ! -e "$P0ROOT/world/worker-bash-trap"; bgpid=$(cat "$P0ROOT/world/bg.pid"); printf "background_pid=%s stopped=" "$bgpid"; test ! -e "/proc/$bgpid"; printf "yes\n"' > "$repo/.task-evidence/independent-files.txt"
docker stats --no-stream --format '{{json .}}' "$ctr" > "$repo/.task-evidence/container-stats.json"
# Disconnect the execution endpoint, then prove the real CCB dispatcher fails closed.
docker stop -t 3 "$ctr" >/dev/null
disk_guard
P0_FAILURE_PROBE=1 env -i PATH=/usr/bin:/bin OC_AGENT_REMOTE_P0=1 P0_FAILURE_PROBE=1 P0_ENDPOINT="$P0_ENDPOINT" P0_CONTAINER="$ctr" P0_FIXTURE_ROOT="$P0_FIXTURE_ROOT" P0_EVIDENCE="$P0_EVIDENCE" P0_TEST_ENV="$P0_TEST_ENV" P0_TASK_REPO="$repo" HOME="$TMPDIR/worker-home" TMPDIR="$TMPDIR" CLAUDE_CONFIG_DIR="$TMPDIR/worker-config" OPENCLAUDE_HOME="$TMPDIR/worker-home" XDG_CACHE_HOME="$repo/.task-cache" DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 SKILL_LEARNING_ENABLED=0 FEATURE_SKILL_LEARNING=0 bun scripts/agent-remote-p0-harness.ts
printf 'P0 isolated validation complete; no model calls\n'
