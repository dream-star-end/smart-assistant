#!/usr/bin/env bash
# Source-bound regression contrast: only a private one-line policy ablation.
# Optional --history SOURCE is a manually pinned old-source evidence run.
set -Eeuo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/v5-runtime-release-lib.sh"
WORK="$(mktemp -d /tmp/ocv5-521-saga.XXXXXX)"
drill_cleanup() {
  if [[ -n "${OC_V5_POLICY_DRILL_EVIDENCE_DIR:-}" ]]; then
    mkdir -p "$OC_V5_POLICY_DRILL_EVIDENCE_DIR"
    cp -a "$WORK"/. "$OC_V5_POLICY_DRILL_EVIDENCE_DIR"/
  fi
  command rm -rf -- "$WORK"
}
trap drill_cleanup EXIT
export TMPDIR="$WORK"
unset DATABASE_URL
export LOSSLESS_TURN_TAPE_RUNTIME_BATCHING=1 PYTHONDONTWRITEBYTECODE=1
export OC_HOTCFG_PLATFORM_ROOT="$WORK/platform" OC_HOTCFG_RELEASES_ROOT="$WORK/runtime"
export OC_HOTCFG_ENV_FILE="$WORK/tuple.env" OC_HOTCFG_HISTORY="$WORK/history"
export OC_DOCKER_BIN="$WORK/docker"
PLAT="$OC_HOTCFG_PLATFORM_ROOT"
mkdir -p "$PLAT" "$OC_HOTCFG_RELEASES_ROOT"
cat > "$OC_DOCKER_BIN" <<'DOCKER'
#!/usr/bin/env bash
case "$1" in
 image) printf '%s\n' "${DOCKER_STUB_IMAGE_ID:-sha256:NEW}" ;;
 run) [[ "${DOCKER_STUB_RUN_FAIL:-0}" != 1 ]] ;;
 *) exit 1 ;;
esac
DOCKER
chmod +x "$OC_DOCKER_BIN"
source "$LIB"
PASS=0; FAIL=0
ok() { printf 'PASS %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf 'FAIL %s\n' "$*"; FAIL=$((FAIL+1)); }
chk() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
MASTER_OLD="$WORK/master-old"; MASTER_HOOK3="$WORK/master-new"
for master in "$MASTER_OLD" "$MASTER_HOOK3"; do
  mkdir -p "$master/deploy/v5"
  printf '{"capabilities":["lossless-turn-runtime-batch-v1"],"runtimeCapabilities":[]}\n' > "$master/deploy/v5/release-metadata.json"
done

POLICY_HELPER="$(dirname "$LIB")/lib/v5-release-policy.py"
# PROPOSAL TEXT ONLY. Complete replacement for fixture policy_drill_adapter;
# source saga/helper remain actual product implementations. Owner is an explicit
# external observation boundary returning0, not a new implementation of policy.
policy_drill_adapter() {
  python3 - "$POLICY_HELPER" "$@" <<'POLICY_PY'
import hashlib,importlib.util,json,os,pathlib,sys
spec=importlib.util.spec_from_file_location('policy',sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
a=sys.argv[2:];context=pathlib.Path(os.environ['P521_CONTEXT']);op='drill-521'
case=os.environ.get('P521_CASE','');events=context.parent/'events'
def note(s):
    with events.open('a') as f:f.write(s+'\n')
note(a[0])
if (context.parent/'fenced').exists():
    note('POST_FENCE_CALLBACK:'+a[0]);sys.exit(86)
if a[0]=='owner':
    sys.exit(0)
elif a[0]=='prepare':
    snap,current,env,root,hist,image,iid,release,bundle,master,previous,kind=a[1:]
    (context.parent/'snapshot.path').write_text(snap)
    if case=='prepare86':
        (context.parent/'fenced').write_text('prepare86\n');sys.exit(86)
    values={}
    for line in pathlib.Path(snap).read_text().splitlines():
        key,value=line.split('=',1);values[key]=None if value=='<UNSET>' else value
    rev=os.environ.get('P521_FLIP_REV','')
    request={'edition':'selfhost','operationId':op,'candidateSha':'2'*40,
      'owner':{'deploymentId':'drill','nonce':'drill'},
      'before':{'masterRelease':previous,'currentTarget':current,'tuple':values,'sourceCommit':'1'*40,'port':18790},
      'target':{'masterRelease':master,'currentTarget':'bundles/'+rev if rev else current,
                'tuple':dict(zip(['OC_RUNTIME_IMAGE','OC_RUNTIME_IMAGE_ID','OC_RUNTIME_RELEASE','OC_PLATFORM_BUNDLE'],[image,iid,release,bundle])),
                'sourceCommit':'2'*40,'port':18790},
      'history':{'path':hist,'predecessorSha256':hashlib.sha256(pathlib.Path(hist).read_bytes()).hexdigest(),'transitionKind':kind}}
    p.prepare(context,request)
elif a[0]=='arm':
    if case=='arm86':
        (context.parent/'fenced').write_text('arm86\n');sys.exit(86)
    if case=='arm-failure':sys.exit(1)
    p.checkpoint(context,op,{'phase':'exposure-armed','mayHaveServed':True})
elif a[0]=='failure':
    c=p.load(context,op);stage,state=a[1:]
    # Only service/authority observation is injected, as existing drill does.
    # Four-key/current actual outcomes and stage are asserted separately.
    facts={'ownerHeld':True,'identity':'exact','service':'usable',
           'authority':{'applied':'applied','old':'original','uncertain':'unknown'}.get(state,'unobserved')}
    if case in {'impairment','blocked-lossless','env-ack-impairment','current-ack-impairment'}:
        facts.update(service='unavailable',impact={'kind':'local-service-unavailable',
          'candidateSha':c['candidateSha'],'masterRelease':c['target']['masterRelease'],
          'unitState':'failed','loopbackError':'ECONNREFUSED','port':18790})
    decision=p.decide(c,facts)
    p.checkpoint(context,op,{'phase':'held','failure':{'stage':stage,'decision':decision}})
    sys.exit({'KEEP_FAILED':78,'HOLD_UNKNOWN':79,'CRASH_STOP':86,
              'COMPENSATE_USER_IMPAIRMENT':0,'PREPARATION_ABORT':0}[decision])
else:sys.exit(1)
POLICY_PY
}

p521_seed_extra() { # case [bundle-before=empty|unset] [flip=new|none]
  export P521_CASE="$1"
  unset HOTCFG_SAGA_ROLLING_BACK
  source "$LIB"
  P521_DIR="$WORK/extra-$P521_CASE-${P521_RED_PHASE:-standalone}"; mkdir -m0700 "$P521_DIR" || return 90
  export P521_CONTEXT="$P521_DIR/unresolved.json"
  P521_HIST="$P521_DIR/history"; P521_MASTER="$P521_DIR/master"; P521_STATE="$P521_DIR/state"
  P521_OLD_CURRENT='bundles/p521-old'; P521_NEW_CURRENT='bundles/p521-new'
  mkdir -p "$PLAT/bundles/p521-old" "$PLAT/bundles/p521-new"
  command rm -f -- "$PLAT/current"; command ln -s "$P521_OLD_CURRENT" "$PLAT/current"
  export P521_FLIP_REV=p521-new
  [[ "${3:-new}" == none ]] && P521_FLIP_REV=''
  P521_BUNDLE="$PLAT/bundles/p521-new"; [[ -n "$P521_FLIP_REV" ]] || P521_BUNDLE=''
  # Env stays outside hist-parent, so a hist-directory fsync fault cannot fire
  # prematurely at env directory fsync in the new corrected core.
  printf 'OC_RUNTIME_IMAGE=img:OLD\nOC_RUNTIME_IMAGE_ID=sha256:OLD\nOC_RUNTIME_RELEASE=/rel/OLD\n' >"$OC_HOTCFG_ENV_FILE"
  [[ "${2:-empty}" == unset ]] || printf 'OC_PLATFORM_BUNDLE=\n' >>"$OC_HOTCFG_ENV_FILE"
  printf 'P521_UNRELATED_CONFIG=unchanged\n' >>"$OC_HOTCFG_ENV_FILE"
  oc_hotcfg_env_snapshot_tuple "$OC_HOTCFG_ENV_FILE" >"$P521_DIR/tuple-before"
  grep -vE '^(OC_RUNTIME_IMAGE|OC_RUNTIME_IMAGE_ID|OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE)=' "$OC_HOTCFG_ENV_FILE" >"$P521_DIR/non-tuple-before"
  printf 'OLD\n' >"$P521_MASTER"; printf 'OLD\n' >"$P521_STATE"
  for master in "$MASTER_OLD" "$MASTER_HOOK3"; do
    printf '{"capabilities":["lossless-turn-runtime-batch-v1"],"runtimeCapabilities":[]}\n' >"$master/deploy/v5/release-metadata.json"
  done
  oc_hotcfg_history_append "$P521_HIST" img:OLD sha256:OLD /rel/OLD '' "$MASTER_OLD" prestate >/dev/null
}

p521_expect_surface() { # OLD|NEW, current raw target
  local side="$1" want_current="$2"
  if [[ "$side" == OLD ]]; then
    oc_hotcfg_env_snapshot_tuple "$OC_HOTCFG_ENV_FILE" >"$P521_DIR/tuple-observed"
    cmp -s "$P521_DIR/tuple-before" "$P521_DIR/tuple-observed" || return 1
  else
    python3 - "$OC_HOTCFG_ENV_FILE" "$P521_BUNDLE" <<'P521_TUPLE' || return 1
import pathlib,re,sys
want=dict(zip(['OC_RUNTIME_IMAGE','OC_RUNTIME_IMAGE_ID','OC_RUNTIME_RELEASE','OC_PLATFORM_BUNDLE'],['img:NEW','sha256:NEW','/rel/NEW',sys.argv[2]]))
actual={k:None for k in want}
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    m=re.fullmatch(r'\s*([^=]+)=(.*)',line)
    if m and m[1] in actual:actual[m[1]]=m[2]
assert actual==want,'actual complete four-key tuple mismatch'
P521_TUPLE
  fi
  [[ "$(readlink -- "$PLAT/current")" == "$want_current" ]] || return 1
  [[ "$(cat -- "$P521_MASTER")" == "$side" ]] || return 1
  grep -vE '^(OC_RUNTIME_IMAGE|OC_RUNTIME_IMAGE_ID|OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE)=' "$OC_HOTCFG_ENV_FILE" >"$P521_DIR/non-tuple-after"
  cmp -s "$P521_DIR/non-tuple-before" "$P521_DIR/non-tuple-after"
}

p521_install_hit_wrappers() {
  # Only exact fixture paths; every successful/failed call is recorded.
  # One lost ACK only: later legitimate restore to same path must really work.
  mv() {
    local destination="${@: -1}" hit="$P521_DIR/rename-hit"
    if [[ ! -e "$hit" ]] && {
      [[ "$P521_CASE" == history-ack-full && "$destination" == "$P521_HIST" ]] ||
      [[ "$P521_CASE" == env-ack-* && "$destination" == "$OC_HOTCFG_ENV_FILE" ]] ||
      [[ "$P521_CASE" == current-ack-* && "$destination" == "$PLAT/current" ]];
    }; then
      command mv "$@" || return $?
      printf '%s\n' "$destination" >"$hit"
      return 1
    fi
    command mv "$@"
  }
  rm() {
    # No actual post-fence unlink is allowed, even if the guard says86.
    [[ ! -e "$P521_DIR/fenced" ]] || printf 'POST_FENCE_RM\n' >>"$P521_DIR/events"
    command rm "$@"
  }
}

p521_call_extra() { # smoke command, optional adapter
  local smoke="$1" adapter="${2:-policy_drill_adapter}"
  P521_RC=0
  DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga \
    "$OC_HOTCFG_ENV_FILE" "$PLAT" "$P521_FLIP_REV" "$P521_HIST" \
    img:NEW sha256:NEW /rel/NEW "$P521_BUNDLE" true "$smoke" \
    "echo NEW > '$P521_MASTER'" "echo OLD > '$P521_MASTER'" \
    "$MASTER_HOOK3" "$MASTER_OLD" \
    "echo NEW > '$P521_STATE'" "echo OLD > '$P521_STATE'" '' joint "$adapter" \
    >"$P521_DIR/saga.log" 2>&1 || P521_RC=$?
}


p521_history_contract_one_case() { # selected actual source path
  local selected="$1"
  LIB="$selected"
  p521_seed_extra true-old-history-red unset new || return 90
  mv() {
    if [[ "${@: -1}" == "$P521_HIST" ]]; then
      printf 'history-rename-hit\n' >>"$P521_DIR/rename-hit"
      return 1
    fi
    command mv "$@"
  }
  p521_call_extra true
  unset -f mv
  # These facts must all succeed BEFORE classifying the red as valid. They
  # prove metadata/canary passed and the exact target rename fault was reached.
  [[ "$(wc -l < "$P521_DIR/rename-hit")" == 1 ]] || return 90
  p521_expect_surface NEW "$P521_NEW_CURRENT" || return 90
  [[ "$(cat "$P521_STATE")" == NEW ]] || return 90
  [[ "$(wc -l < "$P521_HIST")" == 1 ]] || return 90
  printf 'EVIDENCE sourceSha=%s fault=exact-history-rename hit=1 actualRc=%s actualSource=NEW actual4Keys=NEW current=NEW authority=NEW history=1\n' \
    "$(sha256sum "$selected" | cut -d' ' -f1)" "$P521_RC"
  # Intended new contract. Pristine old source should fail THIS assertion with
  # actualRc0, not because it lacks a new function/helper/context during setup.
  if [[ "$P521_RC" != 78 ]]; then
    printf 'RED_CONTRACT healthy-history-failure-must-remain-nonzero actualRc=%s expectedRc=78\n' "$P521_RC"
    return 1
  fi
  return 0
}

p521_make_policy_ablation() { # actual new core, private destination
  python3 - "$1" "$2" <<'P521_ABLATE'
import pathlib,sys,hashlib
src,dst=map(pathlib.Path,sys.argv[1:]);s=src.read_text();needle='  _hotcfg_saga_failed() {\n'
assert s.count(needle)==1,'actual source anchor drift'
changed=s.replace(needle,needle+'    local policy_adapter="" # policy-branch ablation only\n',1)
assert not dst.exists() and not dst.is_symlink(),'private output must not exist'
dst.parent.mkdir(parents=True,exist_ok=True)
with dst.open('x') as f:f.write(changed)
print('ABLATION sourceSha='+hashlib.sha256(src.read_bytes()).hexdigest()+' changedSha='+hashlib.sha256(dst.read_bytes()).hexdigest())
P521_ABLATE
}

p521_policy_keep_contract_one_case() { # normal/ablated actual lib path
  LIB="$1"
  p521_seed_extra policy-keep-ablation unset new || return 90
  mv() {
    if [[ "${@: -1}" == "$P521_HIST" ]]; then
      printf 'history-rename-hit\n' >>"$P521_DIR/rename-hit";return 1
    fi
    command mv "$@"
  }
  p521_call_extra true
  unset -f mv
  [[ "$(wc -l < "$P521_DIR/rename-hit")" == 1 ]] || return 90
  # Actual strict history failure reached: both branches nonzero, so a fixture
  # startup failure cannot be mistaken for a valid policy regression red.
  [[ "$P521_RC" != 0 ]] || return 90
  if [[ "$P521_RC" == 1 && "$(cat "$P521_MASTER")" == OLD ]]; then
    p521_expect_surface OLD "$P521_OLD_CURRENT" || return 90
    [[ "$(cat "$P521_STATE")" == OLD ]] || return 90
    printf 'WITNESS exact-old-rollback actual4Keys=OLD current=OLD authority=OLD\n'
  elif [[ "$P521_RC" == 78 ]]; then
    p521_expect_surface NEW "$P521_NEW_CURRENT" || return 90
    [[ "$(cat "$P521_STATE")" == NEW ]] || return 90
  else
    return 90 # not the intended behavior contrast; do not label fixtureerror red
  fi
  printf 'EVIDENCE policyOnlySourceSha=%s fault=exact-history-rename hit=1 rc=%s actualSource=%s current=%s\n' \
    "$(sha256sum "$LIB" | cut -d' ' -f1)" "$P521_RC" "$(cat "$P521_MASTER")" "$(readlink "$PLAT/current")"
  # Normal new core:78+fullNEW; ablated oldrollback:1+fullOLD -> deliberate red.
  if [[ "$P521_RC" != 78 ]] || ! p521_expect_surface NEW "$P521_NEW_CURRENT"; then
    printf 'RED_CONTRACT healthy-candidate-must-not-rollback-for-history-error\n'
    return 1
  fi
  return 0
}
# The single line also selects legacy owner behavior inside failure/rollback,
# because that closure keys off policy_adapter. This ablation has owner0 and no
# fencing injection; do not claim it separately proves fencing behavior. All
# original lossless/model/storage guards remain the real source functions.

NORMAL_LIB="$LIB"
p521_make_policy_ablation "$NORMAL_LIB" "$WORK/ablated-lib.sh"
printf 'SOURCE actual=%s helper=%s\n' "$(sha256sum "$NORMAL_LIB" | cut -d' ' -f1)" "$(sha256sum "$POLICY_HELPER" | cut -d' ' -f1)"
rc=0
if [[ "${1:-}" == --history ]]; then
  [[ $# == 2 && -f "$2" ]] || exit 2
  ( export P521_RED_PHASE=old; p521_history_contract_one_case "$2" ) >"$WORK/old.log" 2>&1 || rc=$?
  cat "$WORK/old.log"
  [[ "$rc" == 1 ]] && grep -q '^RED_CONTRACT.*actualRc=0 expectedRc=78' "$WORK/old.log" || exit 90
  ( export P521_RED_PHASE=new; p521_history_contract_one_case "$NORMAL_LIB" ) >"$WORK/new.log" 2>&1 || { cat "$WORK/new.log"; exit 91; }
  cat "$WORK/new.log"
  printf 'HISTORY_RED_GREEN old=1 new=0 faultHits=1:1\n'
else
  [[ $# == 0 ]] || exit 2
  ( export P521_RED_PHASE=ablated; p521_policy_keep_contract_one_case "$WORK/ablated-lib.sh" ) >"$WORK/red.log" 2>&1 || rc=$?
  cat "$WORK/red.log"
  [[ "$rc" == 1 ]] && grep -q '^WITNESS exact-old-rollback actual4Keys=OLD current=OLD authority=OLD' "$WORK/red.log" && grep -q '^RED_CONTRACT' "$WORK/red.log" || exit 90
  ( export P521_RED_PHASE=actual; p521_policy_keep_contract_one_case "$NORMAL_LIB" ) >"$WORK/green.log" 2>&1 || { cat "$WORK/green.log"; exit 91; }
  cat "$WORK/green.log"
  printf 'POLICY_RED_GREEN ablated=1 actual=0 faultHits=1:1\n'
fi
