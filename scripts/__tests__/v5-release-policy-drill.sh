#!/usr/bin/env bash
# Source-bound OCV5-521 drill: all policy/saga/history implementations are real.
# Only Docker and explicit service/state observations are sandbox boundaries.
set -Eeuo pipefail
LIB="${OC_V5_POLICY_DRILL_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/v5-runtime-release-lib.sh}"
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
echo "== T521 actual saga + durable policy: healthy bookkeeping failures retain NEW =="
POLICY_HELPER="$(dirname "$LIB")/lib/v5-release-policy.py"
# Only observation/transport boundaries are injected. Prepare/checkpoint/decision
# use the real helper and the saga always comes from the real source library.
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
for P521_CASE in rename-failure rename-ack-loss directory-sync-failure state-original state-lost smoke impairment; do
  export P521_CASE
  P521_DIR="$WORK/policy-$P521_CASE"; mkdir -m 0700 "$P521_DIR"
  export P521_CONTEXT="$P521_DIR/unresolved.json"
  P521_HIST="$P521_DIR/history"; P521_MASTER="$P521_DIR/master"; P521_STATE="$P521_DIR/state"
  cat > "$OC_HOTCFG_ENV_FILE" <<EOF
OC_RUNTIME_IMAGE=img:OLD
OC_RUNTIME_IMAGE_ID=sha256:OLD
OC_RUNTIME_RELEASE=/rel/OLD
OC_PLATFORM_BUNDLE=
EOF
  echo OLD > "$P521_MASTER"; echo OLD > "$P521_STATE"
  oc_hotcfg_history_append "$P521_HIST" img:OLD sha256:OLD /rel/OLD "" "$MASTER_OLD" prestate >/dev/null
  # Real append is exercised: error before rename, rename succeeded + lost ACK,
  # or real rename followed by failed directory fsync. No fake history callback.
  mv() {
    if [[ "${@: -1}" == "$P521_HIST" ]]; then
      case "$P521_CASE" in
        rename-failure) return 1 ;;
        rename-ack-loss) command mv "$@" || return $?; return 1 ;;
      esac
    fi
    command mv "$@"
  }
  eval "$(declare -f oc_hotcfg_fsync_path | sed '1s/oc_hotcfg_fsync_path/original_521_fsync/')"
  oc_hotcfg_fsync_path() {
    if [[ "$P521_CASE" == directory-sync-failure && "$1" == "$P521_DIR" ]]; then return 1; fi
    original_521_fsync "$@"
  }
  P521_COMMIT="echo NEW > '$P521_STATE'"; P521_SMOKE=true; want=78; state=NEW; runtime=NEW; history=1
  case "$P521_CASE" in
    rename-ack-loss|directory-sync-failure) history=2 ;;
    state-original) P521_COMMIT='(exit 10)'; state=OLD ;;
    state-lost) P521_COMMIT="echo NEW > '$P521_STATE'; false"; want=79 ;;
    smoke) P521_SMOKE=false; state=OLD ;;
    impairment) P521_SMOKE='test "${HOTCFG_SAGA_ROLLING_BACK:-}" = 1'; state=OLD; runtime=OLD; want=1 ;;
  esac
  rc=0
  DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$PLAT" "" "$P521_HIST" \
    img:NEW sha256:NEW /rel/NEW "" true "$P521_SMOKE" \
    "echo NEW > '$P521_MASTER'" "echo OLD > '$P521_MASTER'" "$MASTER_HOOK3" "$MASTER_OLD" \
    "$P521_COMMIT" "echo OLD > '$P521_STATE'" "" joint policy_drill_adapter >"$P521_DIR/saga.log" 2>&1 || rc=$?
  if [[ "$rc" != "$want" ]]; then cat "$P521_DIR/saga.log"; fi
  chk "T521 $P521_CASE failure exit remains $want" "[ '$rc' = '$want' ]"
  chk "T521 $P521_CASE source and runtime remain $runtime" "[ \"\$(cat '$P521_MASTER')\" = '$runtime' ] && [ \"\$(oc_hotcfg_env_get '$OC_HOTCFG_ENV_FILE' OC_RUNTIME_IMAGE)\" = 'img:$runtime' ]"
  chk "T521 $P521_CASE authority remains $state" "[ \"\$(cat '$P521_STATE')\" = '$state' ]"
  chk "T521 $P521_CASE history count stays $history" "[ \"\$(wc -l < '$P521_HIST' | tr -d ' ')\" = '$history' ]"
  chk "T521 $P521_CASE durable candidate identity retained" "python3 '$POLICY_HELPER' inspect --context '$P521_CONTEXT' --operation drill-521 | jq -e '.mayHaveServed==true and .phase==\"held\"' >/dev/null"
  unset -f mv
  source "$LIB"
done
# Invalid adapter and failed durable arm both refuse exposure. The new mode
# must never silently fall back to legacy rollback policy.
for P521_CASE in invalid-adapter arm-failure; do
  export P521_CASE
  P521_DIR="$WORK/policy-$P521_CASE"; mkdir -m 0700 "$P521_DIR"; export P521_CONTEXT="$P521_DIR/unresolved.json"
  P521_HIST="$P521_DIR/history"; P521_MASTER="$P521_DIR/master"; echo OLD > "$P521_MASTER"
  oc_hotcfg_history_append "$P521_HIST" img:OLD sha256:OLD /rel/OLD "" "$MASTER_OLD" prestate >/dev/null
  adapter=policy_drill_adapter; [[ "$P521_CASE" == invalid-adapter ]] && adapter=missing_521_adapter
  rc=0
  DOCKER_STUB_IMAGE_ID=sha256:NEW oc_hotcfg_activate_saga "$OC_HOTCFG_ENV_FILE" "$PLAT" "" "$P521_HIST" \
    img:NEW sha256:NEW /rel/NEW "" true true "echo NEW > '$P521_MASTER'" "echo OLD > '$P521_MASTER'" \
    "$MASTER_HOOK3" "$MASTER_OLD" "" "" "" joint "$adapter" >"$P521_DIR/saga.log" 2>&1 || rc=$?
  chk "T521 $P521_CASE rejected" "[ '$rc' != 0 ]"
  chk "T521 $P521_CASE no source exposure" "[ \"\$(cat '$P521_MASTER')\" = OLD ]"
done
p521_seed_extra() { # case [bundle-before=empty|unset] [flip=new|none]
  export P521_CASE="$1"
  unset HOTCFG_SAGA_ROLLING_BACK
  source "$LIB"
  P521_DIR="$WORK/extra-$P521_CASE"; mkdir -m0700 "$P521_DIR"
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

# Concrete additions; root keeps all current cases/assertions, and updates any
# exact total in the separately reviewed wrapper ONLY after observed execution.
for scenario in prepare86 arm86; do
  p521_seed_extra "$scenario" unset new
  p521_install_hit_wrappers
  p521_call_extra true
  chk "T521 $scenario exact fenced rc86" "[ '$P521_RC' = 86 ]"
  snap="$(cat "$P521_DIR/snapshot.path")"
  chk "T521 $scenario snapshot is not removed after fence" "[ -f '$snap' ]"
  chk "T521 $scenario no subsequent rm or callbacks" "! grep -q '^POST_FENCE_' '$P521_DIR/events'"
  chk "T521 $scenario full old tuple/current/non-tuple remain" "p521_expect_surface OLD '$P521_OLD_CURRENT'"
  unset -f mv rm
  source "$LIB"
done

p521_seed_extra blocked-lossless empty new
python3 - "$MASTER_HOOK3/deploy/v5/release-metadata.json" "$OC_HOTCFG_LOSSLESS_TURN_TAPE_CAP" <<'P521_CAP'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);j=json.loads(p.read_text());j['capabilities'].append(sys.argv[2]);p.write_text(json.dumps(j))
P521_CAP
p521_call_extra 'test "${HOTCFG_SAGA_ROLLING_BACK:-}" = 1'
chk 'T521 actual old lossless floor blocks compensation as79' "[ '$P521_RC' = 79 ]"
chk 'T521 blocked compensation full NEW tuple/current stays' "p521_expect_surface NEW '$P521_NEW_CURRENT'"
chk 'T521 actual lossless refusal reached, not fixture startup failure' "grep -q 'lossless writer 已可能对外服务' '$P521_DIR/saga.log'"
chk 'T521 blocked compensation retains typed hold' "python3 '$POLICY_HELPER' inspect --context '$P521_CONTEXT' --operation drill-521 | jq -e '.mayHaveServed and .phase==\"held\"' >/dev/null"

for scenario in history-ack-full env-ack-keep env-ack-impairment current-ack-keep current-ack-impairment; do
  flip=new; [[ "$scenario" == env-ack-* ]] && flip=none
  # UNSET before covers exact absence restoration; target always writes four.
  p521_seed_extra "$scenario" unset "$flip"
  p521_install_hit_wrappers
  p521_call_extra true
  want_rc=78; want=NEW; want_current="$P521_OLD_CURRENT"
  [[ -z "$P521_FLIP_REV" ]] || want_current="$P521_NEW_CURRENT"
  if [[ "$scenario" == *-impairment ]]; then want_rc=1; want=OLD; want_current="$P521_OLD_CURRENT"; fi
  chk "T521 $scenario exact rc" "[ '$P521_RC' = '$want_rc' ]"
  chk "T521 $scenario real rename reached exactlyonce" "[ \"\$(wc -l < '$P521_DIR/rename-hit')\" = 1 ]"
  chk "T521 $scenario complete tuple/current/non-tuple outcome" "p521_expect_surface '$want' '$want_current'"
  stage=history; [[ "$scenario" == env-* ]] && stage=env; [[ "$scenario" == current-* ]] && stage=current
  chk "T521 $scenario exact failure stage" "[ \"\$(python3 '$POLICY_HELPER' inspect --context '$P521_CONTEXT' --operation drill-521 --field failure.stage)\" = '$stage' ]"
  # For history ACK all four target fields and exact checksummed record persist.
  if [[ "$scenario" == history-ack-full ]]; then
    line="$(tail -n1 "$P521_HIST")"
    verified="$(oc_hotcfg__history_verify_line "$line")"
    chk 'T521 history ACK target record checksum+full tuple/current lineage' \
      "jq -e --arg master '$MASTER_HOOK3' --arg old '$MASTER_OLD' --arg bundle '$P521_BUNDLE' '.schemaVer==3 and .seq==2 and .image==\"img:NEW\" and .image_id==\"sha256:NEW\" and .release==\"/rel/NEW\" and .bundle==\$bundle and .masterRelease==\$master and .previousMasterRelease==\$old and .transitionKind==\"joint\"' <<< '$verified' >/dev/null"
  fi
  # Persist a bounded entry witness in stdout; no env/token content.
  printf 'EVIDENCE case=%s rc=%s stage=%s renameHits=1 contextSha=%s\n' "$scenario" "$P521_RC" "$stage" "$(sha256sum "$P521_CONTEXT" | cut -d' ' -f1)"
  unset -f mv rm
  source "$LIB"
done

unset -f policy_drill_adapter
unset P521_CASE P521_CONTEXT
source "$LIB"


echo "== T521 legacy controls and original pre-exposure capability gates =="
unset HOTCFG_SAGA_ROLLING_BACK
for control in legacy-success legacy-history-failure missing-cap tag-mismatch canary-failure; do
  dir="$WORK/control-$control"; mkdir -m0700 "$dir"
  hist="$dir/history"; ptr="$dir/master"; stateptr="$dir/authority"; echo OLD > "$ptr"; echo OLD > "$stateptr"
  printf 'OC_RUNTIME_IMAGE=img:OLD\nOC_RUNTIME_IMAGE_ID=sha256:OLD\nOC_RUNTIME_RELEASE=/rel/OLD\nOC_PLATFORM_BUNDLE=\n' > "$OC_HOTCFG_ENV_FILE"
  oc_hotcfg_history_append "$hist" img:OLD sha256:OLD /rel/OLD '' "$MASTER_OLD" prestate >/dev/null
  expected=0; want=NEW; adapter=''
  case "$control" in
    legacy-history-failure) expected=1; want=OLD
      mv() { [[ "${@: -1}" != "$hist" ]] || return 1; command mv "$@"; } ;;
    missing-cap) expected=1; want=OLD
      printf '{"capabilities":[],"runtimeCapabilities":[]}\n' > "$MASTER_HOOK3/deploy/v5/release-metadata.json" ;;
    tag-mismatch) expected=1; want=OLD ;;
    canary-failure) expected=1; want=OLD ;;
  esac
  rc=0; image_id=sha256:NEW; runfail=0
  [[ "$control" == tag-mismatch ]] && image_id=sha256:OTHER
  [[ "$control" == canary-failure ]] && runfail=1
  DOCKER_STUB_IMAGE_ID="$image_id" DOCKER_STUB_RUN_FAIL="$runfail" oc_hotcfg_activate_saga \
    "$OC_HOTCFG_ENV_FILE" "$PLAT" '' "$hist" img:NEW sha256:NEW /rel/NEW '' true true \
    "echo NEW > '$ptr'" "echo OLD > '$ptr'" "$MASTER_HOOK3" "$MASTER_OLD" \
    "echo NEW > '$stateptr'" "echo OLD > '$stateptr'" '' joint > "$dir/saga.log" 2>&1 || rc=$?
  if [[ "$rc" != "$expected" ]]; then cat "$dir/saga.log"; fi
  chk "T521 $control preserves exit $expected" "[ '$rc' = '$expected' ]"
  chk "T521 $control source/runtime outcome $want" "[ \"\$(cat '$ptr')\" = '$want' ] && [ \"\$(oc_hotcfg_env_get '$OC_HOTCFG_ENV_FILE' OC_RUNTIME_IMAGE)\" = 'img:$want' ]"
  chk "T521 $control authority outcome $want" "[ \"\$(cat '$stateptr')\" = '$want' ]"
  declare -F mv >/dev/null && unset -f mv
  printf '{"capabilities":["lossless-turn-runtime-batch-v1"],"runtimeCapabilities":[]}\n' > "$MASTER_HOOK3/deploy/v5/release-metadata.json"
done
printf 'RESULT PASS=%s FAIL=%s\n' "$PASS" "$FAIL"
[[ "$FAIL" == 0 ]]
