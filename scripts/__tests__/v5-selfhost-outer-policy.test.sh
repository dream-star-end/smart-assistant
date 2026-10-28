#!/usr/bin/env bash
# Source-bound actual caller/saga integration in isolated fixture roots.
# The future author executes under normal train/test mutex. No production roots.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-$SCRIPT_DIR/deploy-v5-selfhost.sh}"
POLICY_SCRIPT="${POLICY_SCRIPT:-$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh}"
MASTER_SCRIPT="${MASTER_SCRIPT:-$SCRIPT_DIR/v5-selfhost-master-release-lib.sh}"
RUNTIME_LIB="${RUNTIME_LIB:-$SCRIPT_DIR/v5-runtime-release-lib.sh}"
DRILL_SCRIPT="${DRILL_SCRIPT:-$SCRIPT_DIR/__tests__/v5-release-policy-drill.sh}"
POLICY_HELPER="$SCRIPT_DIR/lib/v5-release-policy.py"
WORK="$(mktemp -d /tmp/ocv5-521-outer.XXXXXX)"
# Optional evidence destination must be newly created by this test, not shared.
if [[ -n "${OC_V5_OUTER_EVIDENCE_DIR:-}" ]];then
  [[ ! -e "$OC_V5_OUTER_EVIDENCE_DIR" && ! -L "$OC_V5_OUTER_EVIDENCE_DIR" ]] || exit 90
  mkdir -m0700 "$OC_V5_OUTER_EVIDENCE_DIR"
fi
outer_cleanup() {
  local status=$?
  if [[ -n "${OC_V5_OUTER_EVIDENCE_DIR:-}" ]];then
    cp -a "$WORK"/. "$OC_V5_OUTER_EVIDENCE_DIR"/ || status=90
  fi
  command rm -rf -- "$WORK"
  return "$status"
}
trap outer_cleanup EXIT
export TMPDIR="$WORK" PYTHONDONTWRITEBYTECODE=1
unset DATABASE_URL
mkdir "$WORK/functions" "$WORK/logs" "$WORK/bin"

# GNU Bash itself supplies parsing, no awk brace counting/new dependency.
# A starting name only locates its unique definition; Bash -n determines the
# first complete valid definition, including nested functions/heredocs/quotes.
python3 - "$WORK/functions" "$DEPLOY_SCRIPT" "$POLICY_SCRIPT" "$MASTER_SCRIPT" "$DRILL_SCRIPT" <<'EXTRACT'
from pathlib import Path
import subprocess,re,sys,json,hashlib,difflib
out=Path(sys.argv[1]);sources=list(map(Path,sys.argv[2:]))
groups=[
 ['activate_tuple_joint','cmd_cutover','cutover_gate_against_release','cutover_clog','cutover_fail','cutover_persist_phase_or_compensate','selfhost_policy_get','gate_fail_policy','stay_window_sec','gate_fail_drill_armed'],
 ['survivor_state_phase','release_policy_enabled','release_policy_guard_owner','release_policy_flip_live','release_policy_restore_live_before','release_policy_rejected_phase','release_policy_bind_official_train_request','release_policy_context_present'],
 ['atomic_flip_live_symlink','write_prev_release_file'],
 ['policy_drill_adapter']]
manifest=[]
for path,names in zip(sources,groups):
    raw=path.read_text();lines=raw.splitlines(keepends=True)
    for name in names:
        starts=[i for i,x in enumerate(lines) if re.match(r'^'+re.escape(name)+r'\s*\(\s*\)\s*\{',x)]
        if len(starts)!=1:raise RuntimeError('definition absent/ambiguous: '+name)
        start=starts[0];body=None
        for end in range(start+1,len(lines)+1):
            # Top-level close or one-line definition. A brace in heredoc is
            # still rejected by the actual parser until its delimiter closes.
            if end!=start+1 and not re.match(r'^}\s*(?:#.*)?\n?$',lines[end-1]):continue
            candidate=''.join(lines[start:end])
            r=subprocess.run(['bash','--noprofile','--norc','-n','-c',candidate],
                env={'PATH':'/usr/bin:/bin','LC_ALL':'C','BASH_ENV':'/dev/null'},capture_output=True,text=True)
            if r.returncode==0:body=candidate;break
        if body is None:raise RuntimeError('cannot parse complete actual function '+name)
        original=body
        if name=='cmd_cutover':
            # Exactly the existing scratch-log root, never business branches.
            # New source with different count must stop for review, not guess.
            if body.count('/opt/openclaude/tmp')!=3:raise RuntimeError('scratch-path anchor changed')
            body=body.replace('/opt/openclaude/tmp','${OUTER_LOG_ROOT}')
            (out/'cmd_cutover.pathmap.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),body.splitlines(True),fromfile='actual',tofile='scratch-path-only')))
        (out/(name+'.sh')).write_text(body)
        manifest.append({'source':str(path),'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'function':name,'start':start+1,'end':end,'originalSha256':hashlib.sha256(original.encode()).hexdigest(),'loadedSha256':hashlib.sha256(body.encode()).hexdigest()})
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
EXTRACT
# The actual runtime library is a function library, not a deploy CLI entrypoint.
export OC_HOTCFG_PLATFORM_ROOT="$WORK/platform" OC_HOTCFG_RELEASES_ROOT="$WORK/runtime" OC_HOTCFG_ENV_FILE="$WORK/tuple.env" OC_HOTCFG_HISTORY="$WORK/history"
export LOSSLESS_TURN_TAPE_RUNTIME_BATCHING=1
source "$RUNTIME_LIB"
# cmd_cutover now delegates its E3 idle boundary through this production helper.
source "$SCRIPT_DIR/lib/v5-selfhost-idle-retry.sh"
for file in "$WORK/functions/"*.sh; do source "$file"; done

# Transparent observer: exact Bash-declared real function body, name alone is
# changed. The wrapper below always delegates; it never returns a canned rc.
body="$(declare -f oc_hotcfg_activate_saga)"
[[ "$body" == 'oc_hotcfg_activate_saga ()'* ]] || exit 90
eval "${body/#oc_hotcfg_activate_saga /_outer_actual_saga }"
oc_hotcfg_activate_saga() {
  python3 - "$OUTER_CASE_DIR/actual-saga-args.json" "$#" "${19:-}" "${11:-}" "${12:-}" "${13:-}" "${14:-}" "$(readlink -f "$MASTER_LIVE_LINK")" <<'ARGS'
from pathlib import Path
import sys,json
path,argc,adapter,apply,revert,master,previous,live=sys.argv[1:]
Path(path).write_text(json.dumps({'argc':int(argc),'arg19':adapter,'extraApply':apply,'extraRevert':revert,'master':master,'previous':previous,'liveBefore':live}))
ARGS
  _outer_actual_saga "$@"
}

# Runtime/service/receipt boundaries, never saga/caller copies. Every mutation
# intent is a fixture trace entry; no systemctl, SQL, network, model or deploy.
trace() { printf '%s\n' "$*" >>"$OUTER_TRACE"; }
log() { :; }; mlog() { :; }; die() { trace "UNEXPECTED_DIE:$*"; return 90; }
source_commit() { printf '%040d\n' 0 | tr 0 2; }
cutover_expected_source_commit() { source_commit; }
assert_master_release_static_gate() { trace artifact-gate; }
assert_master_release_tsx_selfcheck() { trace tsx-gate; }
dist_oc_build() { printf deadbeef; }
wo_seed_pointer() { trace overlay-seed; }
assert_unit_templates_live_wd() { :; }
snapshot_cutover_units_from_release() { printf -v "$2" '%s' "$WORK/units"; trace unit-snapshot; }
gate_cutover_migrations() { CUTOVER_HAS_MIGRATION=0; trace migration-read; }
backup_installed_units_for_cutover() { printf -v "$1" '%s' "$WORK/backup"; trace backup; }
cutover_arm_survivor() { CUTOVER_SURVIVOR_ARMED=1; trace arm-survivor; }
cutover_persist_phase() { CUTOVER_PHASE="$1"; printf 'phase=%s\n' "$1" >"$SURVIVOR_STATE"; trace "phase:$1"; }
install_host_log_policy_from_snapshot() {
  [[ "$1" == "$DEPLOY_BUILT_RELEASE" && "$2" == "$WORK/units" ]] || return 92
  trace host-log-install
  [[ "$OUTER_CASE" != host-policy-failure ]] || return 43
}
install_unit() { trace install-unit; }
install_egress_slot_units_from() { trace install-slot; }
systemctl() { trace "service-boundary:$*"; }
write_cutover_grace() { trace grace; }
cutover_wait_for_user_idle() {
  trace "idle:$(readlink -f "$MASTER_LIVE_LINK")"
  if [[ "$OUTER_CASE" == fenced && "$(readlink -f "$MASTER_LIVE_LINK")" == "$DEPLOY_BUILT_RELEASE" ]]; then : >"$OUTER_CASE_DIR/fenced"; fi
}
release_policy_install_guards() { trace guard-install; }
release_policy_prepare_candidate() { trace outer-prepare; }
release_policy_require_owner() { [[ ! -e "$OUTER_CASE_DIR/fenced" ]] || return 86; trace owner; }
release_policy_drain_reader() { trace "drain:$(readlink -f "$MASTER_LIVE_LINK")"; }
release_policy_assert_no_service_jobs() { trace no-service-jobs; }
egress_then_master_restart_cmd() { printf 'trace runtime-restart'; }
cutover_smoke_against_release() { trace raw-gate; return 29; }
cutover_smoke_healthz_only() { trace rollback-smoke; }
# Forbidden result branches are spies only, not implementations under test.
cutover_compensate() { trace OUTER_COMPENSATE; return 97; }
release_policy_finish_compensation() { trace FINISH_COMPENSATE; return 97; }
cutover_keep_failed() { trace LEGACY_KEEP; return 97; }
release_policy_keep_failed() { trace "KEEP:$3"; return "$3"; }
release_policy_finalize_forward() { trace UNEXPECTED_FINALIZE; return 97; }
oc_hotcfg_gc() { trace UNEXPECTED_GC; return 97; }
wo_gc_buckets() { trace UNEXPECTED_GC; return 97; }
web_assets_pool_gc() { trace UNEXPECTED_GC; return 97; }
egress_slot_unit() { printf 'fixture-egress-%s.%s' "$1" "$2"; }
# cmd_cutover's external master-GC script must never resolve to a real script.
# The caller body is unchanged: its SCRIPT_DIR dependency is sandbox-owned.
SCRIPT_DIR="$WORK/caller-script-dir";mkdir "$SCRIPT_DIR"
printf '#!/bin/sh\nprintf "UNEXPECTED_GC:master-script\\n" >>"$OUTER_TRACE"\nexit 97\n' >"$SCRIPT_DIR/v5-release-gc.sh"


# The ordinary observer uses the existing real-helper fixture function extracted
# above. Unknownhealth is an explicit observation boundary, not hardcoded79.
release_policy_saga_adapter() {
  if [[ -e "$OUTER_CASE_DIR/fenced" ]]; then return 86; fi
  if [[ "$1" == owner ]]; then return 0; fi
  if [[ "$OUTER_CASE" == unknown-health && "$1" == failure ]]; then
    python3 - "$POLICY_HELPER" "$P521_CONTEXT" "$2" <<'UNKNOWN'
import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('policy',sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
path=pathlib.Path(sys.argv[2]);c=p.load(path,'drill-521')
d=p.decide(c,{'ownerHeld':True,'identity':'exact','service':'unknown','authority':'unobserved'})
p.checkpoint(path,'drill-521',{'phase':'held','failure':{'stage':sys.argv[3],'decision':d}})
assert d=='HOLD_UNKNOWN';sys.exit(79)
UNKNOWN
    return $?
  fi
  policy_drill_adapter "$@"
}

# Explicit SQL/network/deploy deny commands, even if a missing stub escapes.
# Do not point any database variable at host data.
for command in psql sqlite3 ssh curl systemd-run docker; do
  printf '#!/bin/sh\nprintf "FORBIDDEN_EXTERNAL:%%s\\n" "$0" >>"$OUTER_TRACE"\nexit 91\n' >"$WORK/bin/$command"
  chmod +x "$WORK/bin/$command"
done
PATH="$WORK/bin:$PATH"; export PATH OUTER_TRACE

setup_case() {
  OUTER_CASE="$1";OUTER_CASE_DIR="$WORK/$1";mkdir -m0700 "$OUTER_CASE_DIR"
  OUTER_TRACE="$OUTER_CASE_DIR/trace";: >"$OUTER_TRACE"
  export OUTER_CASE OUTER_CASE_DIR OUTER_TRACE
  export P521_DIR="$OUTER_CASE_DIR" P521_CASE=smoke P521_CONTEXT="$OUTER_CASE_DIR/unresolved.json" P521_FLIP_REV=p521-new
  RELEASE_POLICY_CONTEXT="$P521_CONTEXT";RELEASE_POLICY_MODE=user-impact-only
  RELEASE_POLICY_GATES_PASSED=0;RELEASE_POLICY_OUTCOME=''
  OUTER_LOG_ROOT="$OUTER_CASE_DIR/logs";mkdir "$OUTER_LOG_ROOT"
  MASTER_RELEASES_ROOT="$OUTER_CASE_DIR/releases";mkdir -p "$MASTER_RELEASES_ROOT/rel-old/deploy/v5" "$MASTER_RELEASES_ROOT/rel-new/deploy/v5"
  DEPLOY_BUILT_RELEASE="$MASTER_RELEASES_ROOT/rel-new";OLD_REL="$MASTER_RELEASES_ROOT/rel-old"
  MASTER_LIVE_LINK="$OUTER_CASE_DIR/master-live";ln -s "$OLD_REL" "$MASTER_LIVE_LINK"
  for master in "$OLD_REL" "$DEPLOY_BUILT_RELEASE";do printf '{"capabilities":["lossless-turn-runtime-batch-v1"],"runtimeCapabilities":[]}\n' >"$master/deploy/v5/release-metadata.json";done
  mkdir -p "$OC_HOTCFG_PLATFORM_ROOT/bundles/p521-old" "$OC_HOTCFG_PLATFORM_ROOT/bundles/p521-new" "$WORK/units" "$WORK/backup"
  command rm -f "$OC_HOTCFG_PLATFORM_ROOT/current";ln -s bundles/p521-old "$OC_HOTCFG_PLATFORM_ROOT/current"
  V5_ENV="$OUTER_CASE_DIR/tuple.env";printf 'OC_RUNTIME_IMAGE=img:OLD\nOC_RUNTIME_IMAGE_ID=sha256:OLD\nOC_RUNTIME_RELEASE=/rel/OLD\nOC_PLATFORM_BUNDLE=\n' >"$V5_ENV"
  OC_HOTCFG_ENV_FILE="$V5_ENV";OC_HOTCFG_HISTORY="$OUTER_CASE_DIR/history"
  oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" img:OLD sha256:OLD /rel/OLD '' "$OLD_REL" prestate >/dev/null
  OC_DOCKER_BIN="$OUTER_CASE_DIR/docker"
  printf '#!/bin/sh\ncase "$1" in image) echo sha256:NEW;;run) exit 0;;*) exit 1;;esac\n' >"$OC_DOCKER_BIN";chmod +x "$OC_DOCKER_BIN"
  export OC_DOCKER_BIN OC_HOTCFG_ENV_FILE OC_HOTCFG_HISTORY
  RUNTIME_IMAGE=img:NEW;RUNTIME_IMAGE_ID=sha256:NEW;BUILT_RUNTIME_RELEASE=/rel/NEW;BUILT_BUNDLE_REV=p521-new
  CUTOVER_TUPLE_BUNDLE="$OC_HOTCFG_PLATFORM_ROOT/bundles/p521-new";CUTOVER_JOINT=1;DRY=0
  SURVIVOR_STATE="$OUTER_CASE_DIR/survivor.state";SELFHOST_DEPLOY_LOCK="$OUTER_CASE_DIR/deploy.lock"
  SELFHOST_POLICY_FILE="$OUTER_CASE_DIR/policy";printf 'OC_V5_SELFHOST_ON_GATE_FAIL=stay\n' >"$SELFHOST_POLICY_FILE"
  BREAKGLASS_ROOT="$WORK/backup";WEB_OVERLAY_ROOT="$WORK/overlay";CUTOVER_GRACE_FILE="$WORK/grace";CUTOVER_GRACE_SEC=120
  V5_UNIT=fake-master.service;V5_EGRESS_UNIT=fake-egress.service;V5_EGRESS_SLOT_SERVICE_TPL=fake-egress@.service;V5_EGRESS_SLOT_SOCKET_TPL=fake-egress@.socket
  unset HOTCFG_SAGA_ROLLING_BACK
}

for spec in usable:78 unknown-health:79 fenced:86;do
  setup_case "${spec%:*}";want="${spec#*:}";rc=0
  cmd_cutover >"$OUTER_CASE_DIR/caller.log" 2>&1 || rc=$?
  [[ "$rc" == "$want" ]] || { cat "$OUTER_CASE_DIR/caller.log";exit 1; }
  ! grep -Eq 'command not found|unbound variable' "$OUTER_CASE_DIR/caller.log"
  ! grep -Eq 'OUTER_COMPENSATE|FINISH_COMPENSATE|LEGACY_KEEP|UNEXPECTED_FINALIZE|UNEXPECTED_GC|UNEXPECTED_DIE|FORBIDDEN_EXTERNAL' "$OUTER_TRACE"
  if [[ "$want" == 86 ]];then ! grep -q '^KEEP:' "$OUTER_TRACE";else grep -qx "KEEP:$want" "$OUTER_TRACE";fi
  python3 - "$OUTER_CASE_DIR/actual-saga-args.json" "$OLD_REL" "$DEPLOY_BUILT_RELEASE" <<'CHECK_ARGS'
import json,sys
c=json.load(open(sys.argv[1]));assert c['argc']==19 and c['arg19']=='release_policy_saga_adapter'
assert c['liveBefore']==sys.argv[2],'outer flipped live before actual saga'
assert c['master']==sys.argv[3] and c['previous']==sys.argv[2]
assert c['extraApply'].startswith('release_policy_flip_live ') and c['extraRevert'].startswith('release_policy_restore_live_before ')
CHECK_ARGS
  [[ "$(readlink -f "$MASTER_LIVE_LINK")" == "$DEPLOY_BUILT_RELEASE" ]]
  grep -qx "drain:$DEPLOY_BUILT_RELEASE" "$OUTER_TRACE"
  python3 - "$OUTER_TRACE" "$OLD_REL" <<'ORDER'
from pathlib import Path
import sys
lines=Path(sys.argv[1]).read_text().splitlines()
assert lines.index('idle:'+sys.argv[2]) < lines.index('phase:mutated') < lines.index('host-log-install') < lines.index('install-unit')
ORDER
  printf 'PASS actual-outer rc=%s no-compensation arg19-and-real-hook\n' "$want"
done

# Actual caller refuses before the first unit install when policy installation fails.
setup_case host-policy-failure;rc=0
cmd_cutover >"$OUTER_CASE_DIR/caller.log" 2>&1 || rc=$?
[[ "$rc" == 97 ]]
grep -qx host-log-install "$OUTER_TRACE"
grep -qx OUTER_COMPENSATE "$OUTER_TRACE"
! grep -Eq 'install-unit|install-slot|service-boundary:|runtime-restart' "$OUTER_TRACE"
[[ "$(readlink -f "$MASTER_LIVE_LINK")" == "$OLD_REL" ]]
printf 'PASS actual-host-policy refuses-before-unit-install\n'

# Direct actual gate wrapper: global policy opts in, legacy stay must not turn
# a failed raw gate into false0; keep a legacy control using actual policy getter.
setup_case gate-wrapper;rc=0
cutover_gate_against_release "$DEPLOY_BUILT_RELEASE" || rc=$?
[[ "$rc" == 29 && "$CUTOVER_GATE_FAILED" == smoke && "$RELEASE_POLICY_GATES_PASSED" == 0 ]]
RELEASE_POLICY_MODE='';rc=0
cutover_gate_against_release "$DEPLOY_BUILT_RELEASE" || rc=$?
[[ "$rc" == 0 && "$CUTOVER_GATE_FAILED" == smoke ]]
printf 'PASS actual-gate raw29-newpolicy legacy-stay0-control\n'

# Actual binder with GLOBAL DRY=1, deliberately invalid-looking local train and
# hold inputs. Any attempted lease/SQL loading is a failure, never a real DB.
setup_case dry-binder;DRY=1
LEASE_DB="$OUTER_CASE_DIR/sentinel.sqlite";printf 'not-a-live-database\n' >"$LEASE_DB";cp "$LEASE_DB" "$LEASE_DB.before"
LEASE_TRAIN_ID=bad-fixture-id;LEASE_TARGET_SHA='';: >"$RELEASE_POLICY_CONTEXT"
lease_train_load_lib() { trace FORBIDDEN_DB_LOAD;return 91; }
lease_tx() { trace FORBIDDEN_DB_CALL;return 91; }
lease_sql() { trace FORBIDDEN_DB_CALL;return 91; }
train_field() { trace FORBIDDEN_DB_CALL;return 91; }
rc=0;release_policy_bind_official_train_request "$(source_commit)" || rc=$?
[[ "$rc" == 0 ]];! grep -Eq 'FORBIDDEN_DB_|FORBIDDEN_EXTERNAL' "$OUTER_TRACE";cmp -s "$LEASE_DB" "$LEASE_DB.before"
printf 'PASS actual-binder global-dry-no-db\n'
# Actual dry cutover also returns0 while leaving all fixture authority/data
# unchanged. Its owned scratch log is expected; this is not a claim of zero
# filesystem writes. The migration/DB boundary is a recorder, never a live DB.
setup_case dry-caller;DRY=1
cp "$V5_ENV" "$V5_ENV.before";cp "$OC_HOTCFG_HISTORY" "$OC_HOTCFG_HISTORY.before"
before_live="$(readlink "$MASTER_LIVE_LINK")";before_current="$(readlink "$OC_HOTCFG_PLATFORM_ROOT/current")"
rc=0;cmd_cutover >"$OUTER_CASE_DIR/caller.log" 2>&1 || rc=$?
[[ "$rc" == 0 ]];! grep -Eq 'command not found|unbound variable' "$OUTER_CASE_DIR/caller.log"
! grep -Eq 'phase:|arm-survivor|host-log-install|install-unit|install-slot|service-boundary:|grace|overlay-seed|runtime-restart|guard-install|outer-prepare|OUTER_COMPENSATE|FINISH_COMPENSATE|LEGACY_KEEP|KEEP:|UNEXPECTED_|FORBIDDEN_' "$OUTER_TRACE"
[[ ! -e "$SURVIVOR_STATE" && ! -e "$RELEASE_POLICY_CONTEXT" ]]
[[ "$(readlink "$MASTER_LIVE_LINK")" == "$before_live" && "$(readlink "$OC_HOTCFG_PLATFORM_ROOT/current")" == "$before_current" ]]
cmp -s "$V5_ENV" "$V5_ENV.before";cmp -s "$OC_HOTCFG_HISTORY" "$OC_HOTCFG_HISTORY.before"
printf 'PASS actual-caller global-dry-no-authority-mutation\n'
