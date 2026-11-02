#!/usr/bin/env bash
# Disposable v5-dev fixture only. Does not connect to cc5 or call a model.
set -euo pipefail
[[ ${OC_AGENT_REMOTE_CC5_SMOKE:-0} == 1 ]] || { echo 'cc5 smoke disabled' >&2; exit 2; }
mode=${1:-check}
[[ $mode == check || $mode == hold ]] || { echo 'expected check or hold' >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
[[ $repo == */ocv5-agentremote-p3-t1555u ]] || { echo 'unexpected worktree' >&2; exit 2; }
export TMPDIR="$repo/.task-tmp"
mkdir -p "$TMPDIR"
umask 077
operation=$(python3 -c 'import uuid;print(uuid.uuid4())')
task="$TMPDIR/cc5-smoke-$operation"
sockdir="/run/oc-v5-agentremote-t1555u-$operation"
ctr="oc-v5-agentremote-p3-cc5-t1555u-${operation:0:8}"
net="$ctr-net"
label=AGENT-REMOTE-T1555U
image='docker.io/opensandbox/execd@sha256:c75836c46ef4302afccec182d5d7339eb2f905f51e3d73b7aa17bb76c832526c'
evidence="$repo/.task-evidence/cc5-smoke-$operation"
created_ctr=0
container_id=''
created_net=0
proxy_pid=''
mkdir -m 700 "$task" "$sockdir" "$evidence"
disk_guard() {
  [[ $(df -B1 --output=avail "$repo" | tail -1) -ge 8000000000 ]] || { echo 'disk below 8 GB' >&2; return 3; }
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n $proxy_pid ]]; then kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
  if [[ $created_ctr == 1 ]]; then
    if [[ $(docker inspect -f '{{index .Config.Labels "oc.task"}}' "$container_id" 2>/dev/null) == "$label" ]]; then
      docker rm -f "$container_id" >> "$evidence/cleanup.log" 2>&1 || rc=1
    else rc=1; fi
  fi
  if [[ $created_net == 1 ]]; then
    if [[ $(docker network inspect -f '{{index .Labels "oc.task"}}' "$net" 2>/dev/null) == "$label" ]]; then
      docker network rm "$net" >> "$evidence/cleanup.log" 2>&1 || rc=1
    else rc=1; fi
  fi
  if [[ -f $task/proxy-receipt.json ]]; then cp "$task/proxy-receipt.json" "$evidence/"; fi
  rm -f -- "$task/execd-test.env" "$sockdir/proxy.sock"
  rmdir -- "$sockdir" || rc=1
  printf '%s\n' "$rc" > "$evidence/environment.exit"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
disk_guard
! docker inspect "$ctr" >/dev/null 2>&1 || { echo 'container already exists' >&2; exit 2; }
! docker network inspect "$net" >/dev/null 2>&1 || { echo 'network already exists' >&2; exit 2; }
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo 'fixed execd image absent; prepare it separately after disk estimate' >&2
  exit 3
fi
python3 - "$task" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1])/'execd-test.env'
p.write_text('EXECD_ACCESS_TOKEN='+secrets.token_hex(24)+'\n');p.chmod(0o600)
PY
docker network create --label "oc.task=$label" "$net" > "$evidence/network.id"
created_net=1
disk_guard
docker create --name "$ctr" --label "oc.task=$label" --cpus 1 --memory 768m --memory-swap 768m --pids-limit 128 --read-only --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges --network "$net" -p 127.0.0.1::44772 --tmpfs "$task:rw,nosuid,nodev,size=134217728,uid=65534,gid=65534,mode=0700" -e "PROBE_ROOT=$task" -e "TMPDIR=$task/tmp" -e "HOME=$task/home" -e EXECD_RUNTIME_INIT=false --env-file "$task/execd-test.env" --entrypoint /bin/sh "$image" -c 'set -eu; mkdir -p "$PROBE_ROOT/tmp" "$PROBE_ROOT/home" "$PROBE_ROOT/world" "$PROBE_ROOT/isolation"; printf "upper_root = \"%s/isolation\"\n" "$PROBE_ROOT" > "$PROBE_ROOT/isolation.toml"; cd "$PROBE_ROOT/world"; exec /execd --port 44772 --isolation-config "$PROBE_ROOT/isolation.toml"' > "$evidence/container.id"
created_ctr=1
container_id=$(cat "$evidence/container.id")
[[ $container_id =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid container ID' >&2; exit 1; }
docker start "$container_id" >/dev/null
port=$(docker port "$container_id" 44772/tcp | sed -n 's/^127\.0\.0\.1://p')
[[ $port =~ ^[0-9]+$ ]] || { echo 'missing loopback port' >&2; exit 1; }
ready=0
for _ in {1..40}; do
  if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:$port/ping" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.1
done
[[ $ready == 1 ]] || { echo 'execd not ready' >&2; exit 1; }
python3 - "$task" "$operation" "$port" "$ctr" "$evidence" "$container_id" <<'PY'
from pathlib import Path
import json,secrets,sys
p=Path(sys.argv[1]);op=sys.argv[2]
s={'operationId':op,'marker':'CC5_CONTAINER_'+secrets.token_hex(16),
   'endpoint':'http://127.0.0.1:'+sys.argv[3], 'fixture':str(p/'world'),
   'containerName':sys.argv[4],'evidence':sys.argv[5],'containerId':sys.argv[6],
   'proxySocket':'/run/oc-v5-agentremote-t1555u-'+op+'/proxy.sock'}
(p/'state.json').write_text(json.dumps(s,indent=2)+'\n')
PY
disk_guard
python3 "$repo/scripts/agent-remote/cc5-smoke-proxy.py" "$task" > "$evidence/proxy.log" 2>&1 &
proxy_pid=$!
for _ in {1..40}; do
  [[ ! -e $task/proxy-ready ]] || break
  kill -0 "$proxy_pid" 2>/dev/null || { echo 'proxy exited' >&2; exit 1; }
  sleep 0.1
done
[[ -f $task/proxy-ready ]] || { echo 'proxy not ready' >&2; exit 1; }
printf 'TASK_DIR=%s\nPROXY_SOCKET=%s\nEVIDENCE=%s\n' "$task" "$sockdir/proxy.sock" "$evidence"
if [[ $mode == hold ]]; then
  # One bounded work session; no unbounded fixture while approval is pending.
  for _ in {1..1800}; do kill -0 "$proxy_pid" 2>/dev/null || exit 1; sleep 1; done
  echo 'fixture expired after 30 minutes' >&2
  exit 1
fi
# Local plumbing proof only. This is explicitly not a cc5/model tool call.
python3 - "$task" <<'PY'
import http.client,json,socket,sys
from pathlib import Path
s=json.loads((Path(sys.argv[1])/'state.json').read_text())
def request(value):
 c=http.client.HTTPConnection('localhost',timeout=20)
 c.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);c.sock.settimeout(20)
 c.sock.connect(s['proxySocket'])
 c.request('POST','/roundtrip',json.dumps(value),{'Content-Type':'application/json'})
 r=c.getresponse();body=r.read();status=r.status;c.close()
 return status,json.loads(body)
status,_=request({'operationId':s['operationId'],'command':'must-be-rejected'})
assert status==409
status,receipt=request({'operationId':s['operationId']})
assert status==200,receipt
assert receipt['exitCode']==0
(Path(s['evidence'])/'local-proxy-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('local Unix proxy -> execd command terminal exit0 (no model/cc5)')
PY
docker exec "$container_id" /bin/sh -c 'set -eu; printf "CWD="; cd "$PROBE_ROOT/world"; pwd; printf "UID="; id -u; printf "PIDNS="; readlink /proc/self/ns/pid; printf "CONTENT="; cat cc5-proof.txt; printf "SHA256="; sha256sum cc5-proof.txt' > "$evidence/independent-container.txt"
docker inspect --format '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},"pids":{{.HostConfig.PidsLimit}},"readOnly":{{.HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}' "$container_id" > "$evidence/container-limits.json"
python3 - "$evidence" <<'PY'
from pathlib import Path
import json,sys
p=Path(sys.argv[1]);r=json.loads((p/'local-proxy-receipt.json').read_text())
def fields(text):
 rows=[row.split('=',1) for row in text.splitlines()]
 assert len(rows)==5 and all(len(row)==2 for row in rows)
 values=dict(rows)
 assert len(values)==5 and set(values)=={'CWD','UID','PIDNS','CONTENT','SHA256'}
 return values
assert fields(r['stdout'])==fields((p/'independent-container.txt').read_text())
print('independent container content/hash/cwd/uid/pidns matches command receipt')
PY
