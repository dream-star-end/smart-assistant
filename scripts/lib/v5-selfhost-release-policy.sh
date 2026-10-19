#!/usr/bin/env bash
# OCV5-521: explicit per-train user-impact-only policy. No global env switch.
# Runtime operations remain in deploy-v5-selfhost.sh and its original guards.
RELEASE_POLICY_MODE=""
RELEASE_POLICY_OPERATION=""
RELEASE_POLICY_NONCE=""
RELEASE_POLICY_CONTEXT="${OC_V5_RELEASE_POLICY_CONTEXT:-/var/lib/openclaude-v5-selfhost/release-policy/unresolved.json}"
RELEASE_POLICY_OUTCOME=""
RELEASE_POLICY_GATES_PASSED=0
RELEASE_POLICY_HELPER="$SCRIPT_DIR/lib/v5-release-policy.py"

release_policy_enabled() { [[ "$RELEASE_POLICY_MODE" == user-impact-only ]]; }
release_policy_context_present() {
  ! python3 - "$RELEASE_POLICY_CONTEXT" <<'POLICY_ABSENCE'
import os,sys,pathlib
q=pathlib.PurePath(sys.argv[1])
if not q.is_absolute() or '..' in q.parts:sys.exit(2)
try:os.lstat(q)
except FileNotFoundError:sys.exit(0)
except OSError:sys.exit(2)
sys.exit(1)
POLICY_ABSENCE
}

release_policy_lock_is_owned() {
  # fdinfo reports the existing lock; this check never acquires/reclaims it.
  python3 - "$$" "$SELFHOST_DEPLOY_LOCK" <<'POLICY_OWNER'
import os,re,sys
pid,path=sys.argv[1:];fd='/proc/'+pid+'/fd/8'
a=os.stat(fd);b=os.stat(path,follow_symlinks=False)
assert (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino), 'deployment lock inode changed'
assert re.search(r'^lock:\s+.*\bFLOCK\s+ADVISORY\s+WRITE\s+',open('/proc/'+pid+'/fdinfo/8').read(),re.M), 'deployment lock is not held'
POLICY_OWNER
  [[ "$?" == 0 ]] || return 86
}

release_policy_require_owner() {
  local row
  [[ "$RELEASE_POLICY_MODE" == user-impact-only && -n "$LEASE_TRAIN_ID" && -n "$RELEASE_POLICY_NONCE" ]] || return 86
  release_policy_lock_is_owned || return 86
  row="$(lease_sql "SELECT COALESCE(executor_pid,0)||'|'||target_sha||'|'||COALESCE(json_extract(evidence_json,'$.releasePolicyOwner.nonce'),'') FROM train WHERE id='$(lease_q "$LEASE_TRAIN_ID")';")" || return 86
  [[ "$row" == "$$|$LEASE_TARGET_SHA|$RELEASE_POLICY_NONCE" ]] || return 86
}

release_policy_py() {
  PYTHONDONTWRITEBYTECODE=1 python3 - "$RELEASE_POLICY_HELPER" "$RELEASE_POLICY_CONTEXT" "$RELEASE_POLICY_OPERATION" "$@" <<'POLICY_DATA'
import hashlib,importlib.util,json,os,pathlib,re,sys
helper,filename,operation,action,*a=sys.argv[1:]
spec=importlib.util.spec_from_file_location('release_policy',helper);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
path=pathlib.Path(filename)
p.absolute(filename,"policy context")
def exact_operation_context():
    archive=path.with_name(path.name+'.resolved.'+operation+'.json');current=None
    try:path.lstat()
    except FileNotFoundError:pass
    else:current=p.load(path,operation) # Alien/damaged active always blocks replay.
    try:archive.lstat()
    except FileNotFoundError:
        p.require(current is not None,'operation context and archive missing')
        return current,False
    c=p.load(archive,operation);o=c['observations']
    p.require(c['phase']=='resolved' and c['resolution']=='forward' and o.get('identity')=='exact' and o.get('service')=='usable'
      and o.get('allRequiredPassed') is True and o.get('lineageCoherent') is True and o.get('verifiedDirection')=='target'
      and o.get('verifiedStackSha256')==p.stack_digest(c['target']),'archive is not verified forward acceptance')
    if current is not None:
        immutable=['schema','policy','edition','operationId','candidateSha','owner','before','target','history','createdAt']
        p.require(all(current[k]==c[k] for k in immutable),'active context differs from exact archive')
    return c,True

def values(env):
    result={key:None for key in p.TUPLE_KEYS}
    for line in pathlib.Path(env).read_text().splitlines():
        m=re.fullmatch(r'\s*(OC_RUNTIME_IMAGE|OC_RUNTIME_IMAGE_ID|OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE)=(.*)',line)
        if m:result[m[1]]=m[2]
    return result
def current(root):
    q=pathlib.Path(root)/'current'
    if q.is_symlink():return os.readlink(q)
    p.require(not q.exists(),'current is not a symlink')
    return ''
def stack(master,env,root,port):
    master=str(pathlib.Path(master).resolve(strict=True));complete=pathlib.Path(master)/'.complete';raw=complete.read_bytes();j=json.loads(raw)
    return {'masterRelease':master,'currentTarget':current(root),'tuple':values(env),'sourceCommit':j['sourceCommit'],
            'sourceDigest':hashlib.sha256(raw).hexdigest(),'port':int(port)}
if action=='prepare':
    env,root,hist,previous,target,sha,train,nonce,port,image,iid,runtime,bundle,rev=a
    before=stack(previous,env,root,port);want=stack(target,env,root,port)
    want['tuple']=dict(zip(['OC_RUNTIME_IMAGE','OC_RUNTIME_IMAGE_ID','OC_RUNTIME_RELEASE','OC_PLATFORM_BUNDLE'],[image,iid,runtime,bundle]))
    if rev:want['currentTarget']='bundles/'+rev
    p.require(want['sourceCommit']==sha,'candidate manifest source differs from train')
    p.prepare(path,{'edition':'selfhost','operationId':operation,'candidateSha':sha,'owner':{'deploymentId':train,'nonce':nonce},
                    'before':before,'target':want,'history':{'path':hist,'predecessorSha256':hashlib.sha256(pathlib.Path(hist).read_bytes()).hexdigest(),'transitionKind':'joint'}})
elif action=='check-saga':
    snap,old_current,env,root,hist,image,iid,runtime,bundle,master,previous,kind=a;c=p.load(path,operation)
    captured={}
    for line in pathlib.Path(snap).read_text().splitlines():
        key,value=line.split('=',1);captured[key]=None if value=='<UNSET>' else value
    p.require(c['before']['tuple']==captured and c['before']['currentTarget']==old_current,'captured predecessor differs from saga')
    p.require(c['before']['masterRelease']==previous and c['target']['masterRelease']==master,'master identity differs from saga')
    p.require(c['target']['tuple']==dict(zip(['OC_RUNTIME_IMAGE','OC_RUNTIME_IMAGE_ID','OC_RUNTIME_RELEASE','OC_PLATFORM_BUNDLE'],[image,iid,runtime,bundle])),'target tuple differs from saga')
    p.require(c['history']['path']==hist and c['history']['transitionKind']==kind,'history identity differs from saga')
    p.require(hashlib.sha256(pathlib.Path(hist).read_bytes()).hexdigest()==c['history']['predecessorSha256'],'history predecessor changed before exposure')
elif action=='arm':p.checkpoint(path,operation,{'phase':'exposure-armed','mayHaveServed':True})
elif action=='failure':
    stage,authority,env,root,live,unit_state,loopback,port,health,pid_cwd=a;c=p.load(path,operation)
    identity='unknown'
    try:
        actual=stack(live,env,root,port)
        if actual==c['target']:identity='exact'
    except (OSError,ValueError,KeyError,TypeError,p.PolicyError):pass
    service='usable' if health=='usable' and pid_cwd==c['target']['masterRelease'] else 'unknown'
    facts={'ownerHeld':True,'identity':identity,'service':service,'authority':authority}
    if identity=='exact' and unit_state=='failed' and loopback=='ECONNREFUSED':
        facts.update(service='unavailable',impact={'kind':'local-service-unavailable','candidateSha':c['candidateSha'],
            'masterRelease':c['target']['masterRelease'],'unitState':unit_state,'loopbackError':loopback,'port':int(port)})
    decision=p.decide(c,facts)
    try:
        if decision!='PREPARATION_ABORT':p.checkpoint(path,operation,{'phase':'held','failure':{'stage':stage,'decision':decision}})
    except (OSError,p.PolicyError):
        # The pre-armed intent remains the recovery barrier; never compensate
        # merely because recording the failure itself failed.
        decision='HOLD_UNKNOWN'
    print(decision)
elif action=='abort-preparation':p.resolve(path,operation,'preparation-abort')
elif action=='verify-stack':
    env,root,live,port,direction,master_unit,egress_unit=a;c,_=exact_operation_context()
    p.require(direction in ('target','before'),'invalid selected stack')
    actual=stack(live,env,root,port)
    p.require(actual==c[direction],'live source/current/tuple differs from selected stack')
    import subprocess
    def process(unit):
        p.require(subprocess.check_output(['systemctl','is-active',unit],text=True).strip()=='active','service inactive')
        pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip())
        p.require(pid>0,'service process missing')
        q=pathlib.Path('/proc')/str(pid);raw=(q/'stat').read_text();v=raw[raw.rfind(')')+2:].split()
        p.require(v[0]!='Z','service process is zombie')
        return (pid,v[19],str((q/'cwd').resolve(strict=True)))
    m=process(master_unit);e=process(egress_unit)
    p.require(m[2]==actual['masterRelease'] and e[2]==actual['masterRelease'],'process source differs from selected stack')
    p.require(process(master_unit)==m and process(egress_unit)==e,'process generation changed')
    p.require(stack(live,env,root,port)==actual,'serving pointers changed')
    print(p.stack_digest(actual))
elif action=='resume-info':
    c,archived=exact_operation_context()
    p.require(c['edition']=='selfhost' and c['owner']['deploymentId']==operation,'wrong operation owner')
    print(json.dumps({'candidateSha':c['candidateSha'],'nonce':c['owner']['nonce'],'rel':c['target']['masterRelease'],'archived':archived}))
elif action=='resume-validate':
    db,sha=a;c,_=exact_operation_context()
    import sqlite3
    con=sqlite3.connect(pathlib.Path(db).as_uri()+'?mode=ro',uri=True);con.row_factory=sqlite3.Row
    row=con.execute('SELECT * FROM train WHERE id=? AND resource=?',(operation,'deploy:selfhost')).fetchone()
    p.require(row is not None and row['target_sha']==sha==c['candidateSha'],'train target differs')
    e=json.loads(row['evidence_json']);policy=e['releasePolicy'];owner=e['releasePolicyOwner']
    p.require(set(policy)=={'schema','mode','sourceSha','leaseIds'} and policy['schema']==1 and policy['mode']=='user-impact-only' and policy['sourceSha']==sha,'train policy differs')
    p.require(owner['nonce']==c['owner']['nonce'] and c['owner']['deploymentId']==operation,'owner nonce differs')
    p.require(e.get('releasePolicyAcceptance')=={'schema':1,'operationId':operation,'candidateSha':sha,'nonce':owner['nonce'],
      'targetStackSha256':p.stack_digest(c['target']),'resolution':'forward'},'frozen acceptance differs')
    ids=policy['leaseIds'];p.require(isinstance(ids,list) and ids and len(ids)==len(set(ids)),'invalid frozen lease ids')
    for identity in ids:
        lease=con.execute('SELECT * FROM lease WHERE id=?',(identity,)).fetchone();p.require(lease is not None,'frozen lease missing')
        p.require(lease['resource']=='deploy:selfhost' and lease['mode']=='ride' and lease['want_sha']==sha,'frozen lease target differs')
        result=json.loads(lease['result_json']);p.require(result['request']['releasePolicy']=={'schema':1,'mode':'user-impact-only','sourceSha':sha},'frozen request differs')
        p.require(result['releasePolicyBinding']=={'schema':1,'trainId':operation,'sourceSha':sha},'frozen binding differs')
    pid=int(row['executor_pid'] or 0);ticks=str(owner['startTicks']);alive=False
    if pid>0:
        try:
            raw=pathlib.Path('/proc',str(pid),'stat').read_text();fields=raw[raw.rfind(')')+2:].split()
            alive=fields[19]==ticks and fields[0]!='Z'
        except FileNotFoundError:pass
    p.require(not alive,'original executor still alive')
    p.require(con.execute("SELECT count(*) FROM train WHERE resource='deploy:selfhost' AND id<>? AND status NOT IN ('committed','failed')",(operation,)).fetchone()[0]==0,'another open train exists')
    print(pid)
elif action=='acceptance':
    c=p.load(path,operation)
    print(json.dumps({'schema':1,'operationId':operation,'candidateSha':c['candidateSha'],'nonce':c['owner']['nonce'],
      'targetStackSha256':p.stack_digest(c['target']),'resolution':'forward'}))
elif action=='verify-resolution':
    direction,digest=a;c=p.load(path,operation)
    p.require(direction in ('target','before') and p.stack_digest(c[direction])==digest,'observed stack digest differs')
    p.checkpoint(path,operation,{'phase':'repairing','observations':{'identity':'exact','service':'usable','authority':'unobserved',
      'allRequiredPassed':True,'lineageCoherent':True,'verifiedDirection':direction,'verifiedStackSha256':digest}})
elif action=='resolve':p.resolve(path,operation,a[0])
elif action=='field':
    c=p.load(path,operation);value=c
    for key in a[0].split('.'):value=value[key]
    print(json.dumps(value,separators=(',',':')) if isinstance(value,(dict,list,bool)) or value is None else value)
else:raise p.PolicyError('unsupported selfhost adapter action')
POLICY_DATA
}

release_policy_prepare_candidate() { # <candidate> <predecessor>
  release_policy_enabled || return 0
  release_policy_require_owner || return $?
  local target="$1" previous="$2" key
  [[ -f "$RELEASE_POLICY_HELPER" && ! -L "$RELEASE_POLICY_HELPER" ]] || return 1
  release_policy_context_present && { cutover_clog "unresolved release policy context blocks new activation"; return 1; }
  # Preserve every original pre-exposure guard. The real saga rechecks them.
  oc_hotcfg_assert_tuple_viable "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_ID" "$BUILT_RUNTIME_RELEASE" || return 1
  oc_hotcfg_assert_master_runtime_batch_pair "$V5_ENV" "$target" "$previous" || return 1
  oc_hotcfg_canary_boot "$RUNTIME_IMAGE_ID" "$OC_HOTCFG_PLATFORM_ROOT" "$BUILT_BUNDLE_REV" "$BUILT_RUNTIME_RELEASE" || return 1
  if [[ -z "$(oc_hotcfg_history_last_committed "$OC_HOTCFG_HISTORY")" ]]; then
    local old=()
    for key in "${OC_HOTCFG_TUPLE_KEYS[@]}"; do old+=("$(oc_hotcfg_env_get "$V5_ENV" "$key")"); done
    oc_hotcfg_history_append "$OC_HOTCFG_HISTORY" "${old[@]}" "$previous" prestate prestate "" || return 1
  fi
  mkdir -p -m 0700 -- "$(dirname -- "$RELEASE_POLICY_CONTEXT")" || return 1
  release_policy_py prepare "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$OC_HOTCFG_HISTORY" "$previous" "$target" \
    "$LEASE_TARGET_SHA" "$LEASE_TRAIN_ID" "$RELEASE_POLICY_NONCE" "$V5_PORT" \
    "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_ID" "$BUILT_RUNTIME_RELEASE" "$CUTOVER_TUPLE_BUNDLE" "$BUILT_BUNDLE_REV" || return 79
  release_policy_prebind_acceptance
}

release_policy_saga_adapter() {
  local action="$1"; shift
  release_policy_require_owner || return 86
  case "$action" in
    owner) return 0 ;;
    prepare) release_policy_py check-saga "$@" ;;
    arm) release_policy_rejected_phase || return 79; release_policy_py arm ;;
    failure) release_policy_failure "$@" ;;
    *) return 79 ;;
  esac
}

release_policy_failure() { # <stage> [saga-commit-state]
  release_policy_enabled || return 0
  release_policy_require_owner || return 86
  # Before candidate preparation no policy exposure is possible; use original
  # preparation compensation for unit changes, with all original guards.
  release_policy_context_present || return 0
  local stage="$1" authority=unobserved live state health=unknown pid cwd="" loopback=unknown decision
  case "${2:-none}" in applied) authority=applied ;; old) authority=original ;; uncertain) authority=unknown ;; esac
  live="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  state="$(systemctl is-active "$V5_UNIT" 2>/dev/null || true)"
  pid="$(systemctl show "$V5_UNIT" -p MainPID --value 2>/dev/null || true)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] && cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$state" == active ]] && cutover_smoke_healthz_only; then health=usable; fi
  loopback="$(python3 - "$V5_PORT" <<'POLICY_CONNECT'
import errno,socket,sys
try:
    with socket.create_connection(('127.0.0.1',int(sys.argv[1])),timeout=3):print('connected')
except OSError as e:print('ECONNREFUSED' if e.errno==errno.ECONNREFUSED else 'unknown')
POLICY_CONNECT
)" || loopback=unknown
  decision="$(release_policy_py failure "$stage" "$authority" "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$live" "$state" "$loopback" "$V5_PORT" "$health" "$cwd")" || return 79
  RELEASE_POLICY_OUTCOME="$decision"
  case "$decision" in
    PREPARATION_ABORT|COMPENSATE_USER_IMPAIRMENT) return 0 ;;
    KEEP_FAILED) return 78 ;;
    CRASH_STOP) return 86 ;;
    *) return 79 ;;
  esac
}


# This early binding is also used by the first publisher launched by an old
# worker: it reads the official train/lease JSON itself before any env/unit write.
release_policy_bind_official_train_request() { # <captured HEAD>
  local head="$1" views required st target pid owner bind snapshot owner_doc owner_check now ticks
  [[ "$DRY" == 1 ]] && return 0
  release_policy_context_present && { log "unresolved policy context blocks another publisher"; return 79; }
  lease_train_load_lib || return 2
  if [[ ! -f "$LEASE_DB" ]]; then
    [[ -z "$LEASE_TRAIN_ID" ]] && return 0
    return 2
  fi
  lease_valid_sha "$head" || return 2
  views="$(lease_policy_views_sql deploy:selfhost)" || return 2
  if [[ -z "$LEASE_TRAIN_ID" ]]; then
    required="$(lease_tx <<SQL
.bail on
BEGIN;
$views
SELECT count(*) FROM _lp_open WHERE policy_mode IN ('user-impact-only','invalid');
ROLLBACK;
SQL
)" || return 2
    [[ "$required" == 0 ]] || { log "explicit release-policy request requires its official train"; return 2; }
    return 0
  fi
  lease_valid_train_id "$LEASE_TRAIN_ID" || return 2
  required="$(lease_tx <<SQL
.bail on
BEGIN;
$views
SELECT CASE WHEN EXISTS(SELECT 1 FROM _lp_open WHERE policy_mode IN ('user-impact-only','invalid')) THEN 1 ELSE
 COALESCE((SELECT CASE WHEN evidence_json IS NULL THEN 0
 WHEN json_valid(evidence_json)<>1 THEN 1 WHEN json_type(evidence_json)<>'object' THEN 1
 WHEN json_type(evidence_json,'$.releasePolicy') IS NULL THEN 0 ELSE 1 END
 FROM train WHERE id='$(lease_q "$LEASE_TRAIN_ID")'),0) END;
ROLLBACK;
SQL
)" || return 2
  [[ "$required" == 0 ]] && return 0
  [[ "$required" == 1 && "$LEASE_TARGET_SHA" == "$head" ]] || return 2
  st="$(train_field "$LEASE_TRAIN_ID" status)" || return 2
  target="$(train_field "$LEASE_TRAIN_ID" target_sha)" || return 2
  pid="$(train_field "$LEASE_TRAIN_ID" executor_pid)" || return 2
  owner="$(train_field "$LEASE_TRAIN_ID" owner)" || return 2
  [[ "$target" == "$head" && ( "$st" == planned || "$st" == building ) && "$owner" =~ ^worker:[1-9][0-9]*$ ]] || return 2
  if [[ -n "$pid" && "$pid" != 0 && "$pid" != "$$" && "$pid" != "$PPID" ]] && kill -0 "$pid" 2>/dev/null; then return 2; fi
  release_policy_lock_is_owned || return 86
  RELEASE_POLICY_VERIFIED_TRAIN=1
  RELEASE_POLICY_TRAIN_OWNER="$owner"
  RELEASE_POLICY_ORIGINAL_PID="${pid:-0}"
  bind="$(lease_policy_bind_sql "$LEASE_TRAIN_ID" "$head" "deploy:$$")" || { release_policy_reject_verified_train policy-sql-prepare; return $?; }
  RELEASE_POLICY_NONCE="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')" || return 2
  ticks="$(proc_starttime_of "$$")" || return 2
  owner_doc="$(jq -cn --arg nonce "$RELEASE_POLICY_NONCE" --argjson pid "$$" --arg ticks "$ticks" '{nonce:$nonce,pid:$pid,startTicks:$ticks}')" || return 2
  now="$(lease_now)"
  if lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
$views
$bind
INSERT INTO _lp_guard SELECT CASE WHEN
 json_type(COALESCE(evidence_json,'{}'),'$.releasePolicyOwner') IS NULL THEN 1 ELSE 0 END
 FROM train WHERE id='$(lease_q "$LEASE_TRAIN_ID")';
UPDATE train SET executor_pid=$$,status='building',started_at=COALESCE(started_at,'$now'),updated_at='$now',
 evidence_json=json_set(COALESCE(evidence_json,'{}'),'$.releasePolicyOwner',json('$(lease_q "$owner_doc")'))
 WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND resource='deploy:selfhost' AND target_sha='$head'
 AND owner='$(lease_q "$owner")' AND status IN ('planned','building')
 AND COALESCE(executor_pid,0) IN (${pid:-0},$$);
INSERT INTO _lp_guard SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END;
$(lease_event_sql "$LEASE_TRAIN_ID" executor-begin "deploy:$$" "head=$head policy=user-impact-only")
COMMIT;
SQL
  then :; else
    local rc=0
    release_policy_reject_verified_train policy-bind-rejected || rc=$?
    return "$rc"
  fi
  RELEASE_POLICY_MODE=user-impact-only
  RELEASE_POLICY_OPERATION="$LEASE_TRAIN_ID"
  RELEASE_POLICY_CLAIMED=1
  LEASE_TRAIN_ACTIVE=1
  snapshot="$(train_field "$LEASE_TRAIN_ID" evidence_json)" || return 2
  jq -e --arg sha "$head" --arg nonce "$RELEASE_POLICY_NONCE" '
    .releasePolicy.schema==1 and .releasePolicy.mode=="user-impact-only" and
    .releasePolicy.sourceSha==$sha and (.releasePolicy.leaseIds|type=="array" and length>0) and
    .releasePolicyOwner.nonce==$nonce
  ' <<<"$snapshot" >/dev/null || return 2
  release_policy_require_owner || return 86
}

release_policy_reject_verified_train() {
  local reason="$1" now
  [[ "${RELEASE_POLICY_VERIFIED_TRAIN:-0}" == 1 ]] || return 2
  release_policy_lock_is_owned || return 86
  now="$(lease_now)"
  lease_tx <<SQL || return 2
.bail on
BEGIN IMMEDIATE;
UPDATE train SET status='failed',reason='$(lease_q "$reason")',finished_at='$now',updated_at='$now'
 WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND resource='deploy:selfhost' AND target_sha='$LEASE_TARGET_SHA'
 AND owner='$(lease_q "$RELEASE_POLICY_TRAIN_OWNER")' AND status IN ('planned','building')
 AND COALESCE(executor_pid,0) IN (${RELEASE_POLICY_ORIGINAL_PID:-0},$$);
INSERT INTO event(subject_id,event,actor,detail,created_at)
 SELECT '$(lease_q "$LEASE_TRAIN_ID")','train-failed','deploy:$$',
 'pre-exposure policy rejection: $(lease_q "$reason")','$now' WHERE changes()=1;
COMMIT;
SQL
  LEASE_TRAIN_ACTIVE=0
  return 2
}


release_policy_unit_stamp() { # <fixed service> <optional:0|1>
  local raw
  raw="$(systemctl show "$1" -p LoadState -p ActiveState -p SubState -p MainPID -p InvocationID -p Job --no-pager)" || return 79
  printf '%s\n' "$raw" | python3 -c '
import json,re,sys
v=dict(line.split("=",1) for line in sys.stdin.read().splitlines() if "=" in line)
optional=sys.argv[1]=="1"
if v.get("LoadState")=="not-found" and optional:
 print(json.dumps({"id":"","job":"0","quiescent":True}));sys.exit(0)
assert v.get("LoadState")=="loaded", "service identity unavailable"
state=v.get("ActiveState");sub=v.get("SubState");pid=v.get("MainPID","");identity=v.get("InvocationID","")
assert state in ["active","inactive","failed","activating","deactivating","reloading"]
assert re.fullmatch(r"[0-9]+",pid), "unknown service PID"
assert identity=="" or re.fullmatch(r"[0-9a-f]{32}",identity), "unknown invocation"
job=v.get("Job","").split();job=job[0] if job else "0"
assert re.fullmatch(r"[0-9]+",job), "unknown service job"
quiet=pid=="0" and job=="0" and (state in ["inactive","failed"] or (state=="active" and sub=="exited"))
print(json.dumps({"id":identity,"job":job,"quiescent":quiet}))
' "$2"
}

# Wait one fixed invocation/job naturally; do not chase future periodic ticks.
# No stop, kill, timer changes or new scheduler state are needed. For the worker
# this is called after live flips while the old reader still rejects its phase.
release_policy_drain_reader() { # <fixed service> <seconds> <optional>
  local unit="$1" deadline=$((SECONDS + $2)) optional="$3" first now id job new_id new_job
  release_policy_require_owner || return 86
  first="$(release_policy_unit_stamp "$unit" "$optional")" || return 79
  [[ "$(jq -r .quiescent <<<"$first")" == true ]] && return 0
  id="$(jq -r .id <<<"$first")"; job="$(jq -r .job <<<"$first")"
  while (( SECONDS < deadline )); do
    release_policy_require_owner || return 86
    now="$(release_policy_unit_stamp "$unit" "$optional")" || return 79
    [[ "$(jq -r .quiescent <<<"$now")" == true ]] && return 0
    new_id="$(jq -r .id <<<"$now")"; new_job="$(jq -r .job <<<"$now")"
    if [[ -n "$id" && -n "$new_id" && "$new_id" != "$id" && ( "$job" == 0 || "$new_job" != "$job" ) ]]; then return 0; fi
    if [[ -z "$id" && "$job" != 0 && "$new_job" != "$job" && -n "$new_id" ]]; then return 0; fi
    sleep 1
  done
  cutover_clog "release-policy reader handoff unresolved: $unit"
  return 79
}

release_policy_assert_no_service_jobs() {
  local unit stamp
  for unit in "$V5_UNIT" "$V5_EGRESS_UNIT" "$(egress_slot_unit A service)" "$(egress_slot_unit B service)"; do
    stamp="$(release_policy_unit_stamp "$unit" 1)" || return 79
    [[ "$(jq -r .job <<<"$stamp")" == 0 ]] || return 79
  done
}

release_policy_install_guards() { # <verified candidate> <captured predecessor>
  release_policy_enabled || return 0
  local rel="$1" previous="$2" unit probe old_watch_fd old_watch_identity readers
  release_policy_require_owner || return 86
  [[ -f "$V5_WATCH_DIR/watch.sh" && ! -L "$V5_WATCH_DIR/watch.sh" ]] || return 2
  [[ -f "$rel/scripts/lib/v5-release-policy.py" && -f "$rel/scripts/v5-lease-worker.sh" && -f "$rel/scripts/v5-lease-lib.sh" ]] || return 2
  cmp -s "$RELEASE_POLICY_HELPER" "$rel/scripts/lib/v5-release-policy.py" || return 2
  # Hold the original inode open so a deleted old Bash reader remains
  # identifiable after the atomic install; no process is signalled.
  exec {old_watch_fd}<"$V5_WATCH_DIR/watch.sh" || return 2
  old_watch_identity="$(stat -Lc '%d:%i' "/proc/$$/fd/$old_watch_fd")" || return 2
  sync_watch_from "$rel" || { exec {old_watch_fd}<&-; return 2; }
  readers="$(release_policy_watch_readers "$old_watch_identity")" || { exec {old_watch_fd}<&-; return 2; }
  release_policy_drain_watch_readers "$readers" || { local rc=$?; exec {old_watch_fd}<&-; return "$rc"; }
  exec {old_watch_fd}<&-
  cmp -s "$V5_WATCH_DIR/watch.sh" "$rel/scripts/v5-selfhost-watch.sh" || return 2
  cmp -s "$V5_WATCH_DIR/alert.sh" "$rel/scripts/v5-selfhost-watch-alert.sh" || return 2
  # New stable-path invocations load the new self-contained guard. Existing
  # loaded old actions must finish before the context or any unit can change.
  for unit in openclaude-v5-selfhost-watch.service openclaude-v5-selfhost-autorecover-action.service \
    openclaude-v5-selfhost-cutover-watch.service openclaude-v5-selfhost-cutover-timeout.service; do
    release_policy_drain_reader "$unit" 310 1 || return $?
  done
  release_policy_require_owner || return 86
  probe="$(OC_V5_RELEASE_POLICY_CONTEXT="$RELEASE_POLICY_CONTEXT" bash "$V5_WATCH_DIR/watch.sh" --release-policy-probe)" || return 2
  [[ "$probe" == "release-policy-probe-v1 absent $RELEASE_POLICY_CONTEXT" ]] || return 2
  [[ "$(readlink -f -- "$MASTER_LIVE_LINK")" == "$previous" ]] || return 2
  release_policy_assert_no_service_jobs || return $?
}

release_policy_rejected_phase() {
  local state="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}" phase
  [[ -f "$state" && ! -L "$state" && -r "$state" ]] || return 79
  phase="$(survivor_state_phase)" || return 79
  case "$phase" in units-installed|reloaded|grace|migrated|symlink-flipped|restarted|kept-failed) return 0 ;; *) return 79 ;; esac
}

release_policy_flip_live() { # saga extra_apply, after real prechecks/context arm
  release_policy_require_owner || return 86
  release_policy_rejected_phase || return 79
  atomic_flip_live_symlink "$1" || return 79
  oc_hotcfg_fsync_path "$(dirname "$MASTER_LIVE_LINK")" || return 79
  # Until this fixed old reader is gone, retain the actual rejecting phase;
  # old lease code reads SHA first and phase afterwards. Fresh ticks open new live.
  release_policy_drain_reader openclaude-v5-selfhost-lease-worker.service 310 0 || return $?
  release_policy_rejected_phase || return 79
  release_policy_assert_no_service_jobs || return $?
  # A user may have begun a turn while the old reader was draining. Apply the
  # existing real idle gate again before runtime/egress/master are restarted.
  cutover_wait_for_user_idle || return 79
  release_policy_require_owner || return 86
}

release_policy_keep_failed() { # <release> <reason> <original rc>
  local rel="$1" reason="$2" original_rc="$3" phase_rc=0
  [[ "$original_rc" == 86 ]] && return 86
  release_policy_require_owner || return 86
  if ! release_policy_context_present; then
    local archived_info
    archived_info="$(release_policy_py resume-info)" || return 79
    if [[ "$(jq -r .archived <<<"$archived_info")" == true ]]; then
      cutover_clog "verified archive durable; final cleanup ACK unknown, retaining nonzero without revoking passed gates"
      return 79
    fi
    return 79
  fi
  CUTOVER_KEPT_FAILED_REL="$rel"
  RELEASE_POLICY_OUTCOME="${RELEASE_POLICY_OUTCOME:-HOLD_UNKNOWN}"
  cutover_persist_phase kept-failed || phase_rc=$?
  # A phase-write failure does not authorize compensation. The pre-exposure
  # durable intent and rejecting phase remain the barrier for new/old readers.
  [[ "$phase_rc" == 0 ]] || cutover_clog "release-policy kept-failed receipt failed; durable intent retained"
  lease_train_finish failed "release-policy held live=$rel stage=$reason rc=$original_rc" || return 79
  deploy_alert deploy_gate_failed_kept "$rel" "发布策略保留现场: $reason rc=$original_rc;真实失败未略过,未回切。需按同operation核对恢复。"
  [[ "$original_rc" == 78 ]] && return 78
  return 79
}

release_policy_watch_readers() { # <old installed device:inode>
  python3 - "$1" "$$" <<'POLICY_WATCH_READERS'
import os,pathlib,sys,json
want=sys.argv[1];own=int(sys.argv[2]);rows=[]
for q in pathlib.Path('/proc').iterdir():
    if not q.name.isdigit() or int(q.name) in (own,os.getpid()):continue
    try:
        st=(q/'stat').read_text();ticks=st[st.rfind(')')+2:].split()[19]
        # Bash keeps its parsed script on fd255, including after unlink.
        a=(q/'fd/255').stat()
        if str(a.st_dev)+':'+str(a.st_ino)==want:rows.append([int(q.name),ticks])
    except (FileNotFoundError,ProcessLookupError):continue
print(json.dumps(rows))
POLICY_WATCH_READERS
}
release_policy_drain_watch_readers() { # fixed captured readers; never chase new inode
  local readers="$1" deadline=$((SECONDS+310)) remaining
  while (( SECONDS < deadline )); do
    release_policy_require_owner || return 86
    remaining="$(python3 - "$readers" <<'POLICY_READER_WAIT'
import pathlib,json,sys
rows=json.loads(sys.argv[1]);live=[]
for pid,ticks in rows:
    try:
        raw=pathlib.Path('/proc',str(pid),'stat').read_text();v=raw[raw.rfind(')')+2:].split()
        if v[19]==ticks and v[0]!='Z':live.append([pid,ticks])
    except (FileNotFoundError,ProcessLookupError):pass
print(len(live))
POLICY_READER_WAIT
)" || return 79
    [[ "$remaining" == 0 ]] && return 0
    sleep 1
  done
  return 79
}

# Prebind immutable acceptance expectations before any candidate exposure. The
# worker uses this exact train/op/nonce, never a same-SHA archive search.
release_policy_prebind_acceptance() {
  local expectation merged
  release_policy_require_owner || return 86
  expectation="$(release_policy_py acceptance)" || return 79
  merged="$(jq -cn --argjson e "$expectation" '{releasePolicyAcceptance:$e}')" || return 79
  merged="$(lease_json_object_merge_sql evidence_json "$merged")" || return 79
  lease_tx <<SQL || return 79
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE _policy_owner_guard(v INTEGER CHECK(v=1));
UPDATE train SET evidence_json=$merged,updated_at='$(lease_now)'
 WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND target_sha='$LEASE_TARGET_SHA' AND executor_pid=$$
 AND json_extract(evidence_json,'$.releasePolicyOwner.nonce')='$RELEASE_POLICY_NONCE'
 AND json_type(evidence_json,'$.releasePolicyAcceptance') IS NULL;
INSERT INTO _policy_owner_guard VALUES(changes());
COMMIT;
SQL
}

release_policy_probe_stack() { # owner-bound observed exact digest
  release_policy_require_owner || return 86
  release_policy_observe_stack "$1"
}
release_policy_observe_stack() { # read-only, also used before claiming a replay
  local direction="$1" a=0 b=0 unit live
  if egress_live_release_has_slots; then
    egress_slot_is_active A && a=1
    egress_slot_is_active B && b=1
    (( a+b==1 )) || return 79
    if [[ "$a" == 1 ]]; then unit="$(egress_slot_unit A service)"; else unit="$(egress_slot_unit B service)"; fi
  else
    unit="$V5_EGRESS_UNIT"
  fi
  live="$(readlink -f -- "$MASTER_LIVE_LINK")" || return 79
  release_policy_py verify-stack "$V5_ENV" "$OC_HOTCFG_PLATFORM_ROOT" "$live" "$V5_PORT" "$direction" "$V5_UNIT" "$unit" || return 79
}

# Metadata-only lineage inspection: exact entire predecessor bytes or that
# prefix plus one checksum-verified target record. No nth/skip-invalid guessing.
release_policy_history_status() {
  local hist prior shape prev target verified seq=0 want
  hist="$(release_policy_py field history.path)" || return 79
  prior="$(release_policy_py field history.predecessorSha256)" || return 79
  shape="$(python3 - "$hist" "$prior" <<'POLICY_HISTORY_SHAPE'
import os,sys,stat,hashlib,json
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode):raise ValueError('history not regular')
    with os.fdopen(fd,'rb',closefd=False) as f:data=f.read()
    if os.fstat(fd).st_size!=len(data):raise ValueError('history changed')
finally:os.close(fd)
if data and not data.endswith(b'\n'):raise ValueError('partial history tail')
lines=data.splitlines(keepends=True)
if hashlib.sha256(data).hexdigest()==sys.argv[2]:state='missing';prefix=data;tail=None
elif lines and hashlib.sha256(b''.join(lines[:-1])).hexdigest()==sys.argv[2]:state='applied';prefix=b''.join(lines[:-1]);tail=lines[-1].decode().rstrip('\n')
else:raise ValueError('alien history prefix or extra records')
print(json.dumps({'state':state,'previous':prefix.splitlines()[-1].decode() if prefix else None,'target':tail}))
POLICY_HISTORY_SHAPE
)" || return 79
  prev="$(jq -r '.previous // empty' <<<"$shape")" || return 79
  if [[ -n "$prev" ]]; then
    verified="$(oc_hotcfg__history_verify_line "$prev")" || return 79
    seq="$(jq -er '.seq|select(type=="number" and .>=1 and .==floor)' <<<"$verified")" || return 79
    [[ "$seq" =~ ^[1-9][0-9]{0,14}$ ]] || return 79
  fi
  if [[ "$(jq -r .state <<<"$shape")" == missing ]]; then printf 'missing\n'; return 0; fi
  target="$(jq -er .target <<<"$shape")" || return 79
  verified="$(oc_hotcfg__history_verify_line "$target")" || return 79
  want="$(release_policy_py field target)" || return 79
  jq -e --argjson next "$((seq+1))" --argjson want "$want" \
    --arg previous "$(release_policy_py field before.masterRelease)" '
    .schemaVer==3 and .seq==$next and (.preState // false)==false and
    .image==$want.tuple.OC_RUNTIME_IMAGE and .image_id==$want.tuple.OC_RUNTIME_IMAGE_ID and
    .release==$want.tuple.OC_RUNTIME_RELEASE and .bundle==$want.tuple.OC_PLATFORM_BUNDLE and
    .masterRelease==$want.masterRelease and .transitionKind=="joint" and .previousMasterRelease==$previous
  ' <<<"$verified" >/dev/null || return 79
  printf 'applied\n'
}

release_policy_original_finalizer() { # exact target; caller keeps intent active
  local rel="$1"
  release_policy_require_owner || return 86
  cutover_persist_phase committed || return 79
  release_policy_require_owner || return 86
  cutover_disarm_survivor || return 79
  release_policy_require_owner || return 86
  # Keep the existing implementation and its explicit die/set-e semantics in
  # a subshell; the caller converts failures to holds, never compensation.
  ( set -e; persist_selfhost_model_authority_cutover "$rel" ) || return 79
  release_policy_require_owner || return 86
  ( set -e; sync_boot_scripts_from "$rel" ) || return 79
  release_policy_require_owner || return 86
  sync_watch_from "$rel" || return 79
  [[ "$(watch_install_state "$rel")" == same ]] || return 79
  return 0
}

release_policy_finalize_forward() { # full raw gates already passed in real saga/recovery
  local rel="$1" digest hist
  [[ "${RELEASE_POLICY_GATES_PASSED:-0}" == 1 ]] || return 79
  release_policy_require_owner || return 86
  digest="$(release_policy_probe_stack target)" || return $?
  [[ "$(release_policy_history_status)" == applied ]] || return 79
  hist="$(release_policy_py field history.path)" || return 79
  oc_hotcfg_fsync_path "$hist" && oc_hotcfg_fsync_path "$(dirname "$hist")" || return 79
  release_policy_original_finalizer "$rel" || return $?
  release_policy_require_owner || return 86
  digest="$(release_policy_probe_stack target)" || return $?
  [[ "$(release_policy_history_status)" == applied ]] || return 79
  release_policy_py verify-resolution target "$digest" || return 79
  # All actual gates/lineage/fallible receipts finish while the barrier exists.
  lease_train_finish committed "verified policy target; archive resolution pending live=$rel" || return $?
  release_policy_require_owner || return 86
  release_policy_py resolve forward || return 79
  RELEASE_POLICY_RESOLVED=1
  clear_stay_maintenance || cutover_clog "  ⚠ 已验收;撤销旧 stay 维护窗口失败"
  oc_hotcfg_rotate_env_baks "$V5_ENV" 10 || true
  return 0
}

release_policy_finish_compensation() { # saga already restored exact predecessor once
  local before digest served resolution
  release_policy_require_owner || return 86
  before="$(release_policy_py field before.masterRelease)" || return 79
  served="$(release_policy_py field mayHaveServed)" || return 79
  digest="$(release_policy_probe_stack before)" || return $?
  # Confirm original full user gates, not only healthz, before releasing hold.
  if cutover_smoke_against_release "$before"; then :; else return 79; fi
  release_policy_require_owner || return 86
  cutover_persist_phase kept-failed || return 79
  cutover_disarm_survivor || return 79
  release_policy_require_owner || return 86
  digest="$(release_policy_probe_stack before)" || return $?
  if [[ "$served" == true ]]; then
    release_policy_py verify-resolution before "$digest" || return 79
    resolution=compensated
  else resolution=preparation-abort; fi
  lease_train_finish failed "release-policy $resolution verified; predecessor retained" || return $?
  release_policy_require_owner || return 86
  release_policy_py resolve "$resolution" || return 79
  return 1 # Failed deployment, never accepted/satisfied as target.
}

# Same-operation forward reconciliation. This never builds, flips a serving
# pointer, restarts services, restores an env file or adjusts billing records.
release_policy_resume_claim() {
  local info original_pid now ticks owner_doc
  [[ -n "$LEASE_TRAIN_ID" && -n "$LEASE_TARGET_SHA" ]] || return 2
  lease_train_load_lib || return 2
  lease_valid_train_id "$LEASE_TRAIN_ID" && lease_valid_sha "$LEASE_TARGET_SHA" || return 2
  [[ -f "$LEASE_DB" ]] || return 2
  release_policy_lock_is_owned || return 86
  RELEASE_POLICY_OPERATION="$LEASE_TRAIN_ID"
  info="$(release_policy_py resume-info)" || return 79
  [[ "$(jq -r .candidateSha <<<"$info")" == "$LEASE_TARGET_SHA" ]] || return 79
  RELEASE_POLICY_NONCE="$(jq -er .nonce <<<"$info")" || return 79
  original_pid="$(release_policy_py resume-validate "$LEASE_DB" "$LEASE_TARGET_SHA")" || return 79
  [[ "$original_pid" =~ ^[0-9]+$ ]] || return 79
  # Reject mixed/old/advanced live before touching an original terminal row.
  release_policy_observe_stack target >/dev/null || return 79
  ticks="$(proc_starttime_of "$$")" || return 86
  owner_doc="$(jq -cn --arg nonce "$RELEASE_POLICY_NONCE" --argjson pid "$$" --arg ticks "$ticks" '{nonce:$nonce,pid:$pid,startTicks:$ticks}')" || return 79
  now="$(lease_now)"
  lease_tx <<SQL || return 79
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE _policy_resume_guard(v INTEGER CHECK(v=1));
INSERT INTO _policy_resume_guard VALUES((SELECT CASE WHEN COUNT(*)=0 THEN 1 ELSE 0 END FROM train
 WHERE resource='deploy:selfhost' AND id<>'$(lease_q "$LEASE_TRAIN_ID")' AND status NOT IN ('committed','failed')));
UPDATE train SET status='building',executor_pid=$$,finished_at=NULL,updated_at='$now',
 evidence_json=json_set(evidence_json,'$.releasePolicyOwner',json('$(lease_q "$owner_doc")'))
 WHERE id='$(lease_q "$LEASE_TRAIN_ID")' AND resource='deploy:selfhost' AND target_sha='$LEASE_TARGET_SHA'
 AND COALESCE(executor_pid,0)=$original_pid AND json_extract(evidence_json,'$.releasePolicyOwner.nonce')='$RELEASE_POLICY_NONCE'
 AND status IN ('failed','building','cutover','committed');
INSERT INTO _policy_resume_guard VALUES(changes());
$(lease_event_sql "$LEASE_TRAIN_ID" policy-resume "deploy:$$" 'same operation; metadata-only forward reconciliation')
COMMIT;
SQL
  RELEASE_POLICY_MODE=user-impact-only
  RELEASE_POLICY_CLAIMED=1
  LEASE_TRAIN_ACTIVE=1
  RELEASE_POLICY_RESUME_INFO="$info"
  release_policy_require_owner || return 86
}

release_policy_recover_forward() {
  local rel hist target previous state rc=0 digest
  release_policy_resume_claim || return $?
  rel="$(jq -er .rel <<<"$RELEASE_POLICY_RESUME_INFO")" || return 79
  CUTOVER_REL="$rel"
  CUTOVER_JOINT=1
  CUTOVER_LOG="$(train_field "$LEASE_TRAIN_ID" log_path)" || return 79
  CUTOVER_PHASE="$(survivor_state_phase)" || return 79
  digest="$(release_policy_probe_stack target)" || return $?
  if [[ "$(jq -r .archived <<<"$RELEASE_POLICY_RESUME_INFO")" == true ]]; then
    # Exact archive and fresh physical target permit only same-operation
    # receipt repair. No paid gates, history append or serving mutation repeats.
    release_policy_require_owner || return 86
    if cutover_persist_phase committed; then
      :
    else
      rc=$?
      [[ "$rc" == 86 ]] && return 86
      return 79
    fi
    release_policy_require_owner || return 86
    [[ "$(survivor_state_phase)" == committed ]] || return 79
    lease_train_finish committed "same-operation verified archive replay live=$rel" || return $?
    release_policy_require_owner || return 86
    release_policy_py resolve forward || return 79
    RELEASE_POLICY_RESOLVED=1
    return 0
  fi
  ( assert_master_release_static_gate "$rel" "$LEASE_TARGET_SHA" ) || return 79
  state="$(release_policy_history_status)" || return 79
  if [[ "$state" == missing ]]; then
    release_policy_require_owner || return 86
    digest="$(release_policy_probe_stack target)" || return $?
    [[ "$(release_policy_history_status)" == missing ]] || return 79
    target="$(release_policy_py field target.tuple)" || return 79
    hist="$(release_policy_py field history.path)" || return 79
    previous="$(release_policy_py field before.masterRelease)" || return 79
    oc_hotcfg_history_append "$hist" \
      "$(jq -er .OC_RUNTIME_IMAGE <<<"$target")" "$(jq -er .OC_RUNTIME_IMAGE_ID <<<"$target")" \
      "$(jq -er .OC_RUNTIME_RELEASE <<<"$target")" "$(jq -er .OC_PLATFORM_BUNDLE <<<"$target")" \
      "$rel" '' joint "$previous" || rc=$?
    release_policy_require_owner || return 86
    [[ "$(release_policy_history_status)" == applied ]] || return 79
    [[ "$rc" == 0 ]] || return 78 # Lost ACK stays failed; retry will not append again.
  fi
  release_policy_require_owner || return 86
  if cutover_gate_against_release "$rel"; then :; else
    rc=$?
    release_policy_keep_failed "$rel" recovery-gates "$rc"
    return $?
  fi
  CUTOVER_SURVIVOR_ARMED=1
  release_policy_finalize_forward "$rel" || return $?
  return 0
}

release_policy_guard_owner() {
  release_policy_enabled || return 0
  release_policy_require_owner || return 86
}

release_policy_abort_unexposed() {
  release_policy_enabled || return 0
  release_policy_require_owner || return 86
  [[ "${CUTOVER_MUTATED:-0}" != 1 ]] || return 0
  release_policy_context_present || return 0
  local served
  served="$(release_policy_py field mayHaveServed)" || return 79
  [[ "$served" == false ]] || return 0
  release_policy_py resolve preparation-abort || return 79
}

release_policy_restore_live_before() { # called only by the original guarded saga compensation
  release_policy_require_owner || return 86
  atomic_flip_live_symlink "$1" || return 79
  oc_hotcfg_fsync_path "$(dirname "$MASTER_LIVE_LINK")" || return 79
}

# 终态:成功由 cmd_deploy 末尾调 committed;失败由 EXIT trap 调(未 committed 即 failed/recovery_required)。
lease_train_finish() { # <committed|failed> <reason>
  [[ "${LEASE_TRAIN_ACTIVE:-0}" == 1 && -n "$LEASE_TRAIN_ID" ]] || return 0
  release_policy_guard_owner || return 86
  release_policy_enabled || LEASE_TRAIN_ACTIVE=0
  local st="$1" reason="$2" rel="" ev
  if [[ "$st" == failed ]]; then
    # 本班已动 unit 但未 committed(被 SIGTERM/die 打断在中途)→ 交给 survivor,并要人工确认;不自动重发。
    # 只看本班:没动过 unit 时 state 里是上一班留下的 phase,不能据此判(OCV5-420)。
    local phase=""
    if [[ "${CUTOVER_MUTATED:-0}" == 1 ]]; then
      phase="$(survivor_state_phase)"
      # kept-failed(OCV5-418)是有意留在新版的确定性失败,不是需人工恢复的半截 mutation。
      case "${phase:-}" in armed|pre-install|pre-mutation|smoked|committed|kept-failed) ;; *) st=recovery_required ;; esac
    fi
    # 补偿本身失败:survivor --disarm 会把 phase 写成 committed,所以单独带标记(OCV5-420)。
    [[ "${CUTOVER_RECOVERY_REQUIRED:-0}" == 1 ]] && st=recovery_required
    if release_policy_enabled && release_policy_context_present; then st=failed; fi
    rel="${CUTOVER_KEPT_FAILED_REL:-}"
  else
    rel="$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)"
  fi
  ev="$(jq -cn --arg rel "$rel" --arg log "${CUTOVER_LOG:-}" --arg phase "${CUTOVER_PHASE:-}" '{live:$rel,cutover_log:$log,phase:$phase}')"
  local evidence_merge
  evidence_merge="$(lease_json_object_merge_sql evidence_json "$ev")" || return 1
  local terminal_rc=0 policy_terminal_guard="" policy_terminal_event policy_readback
  policy_terminal_event="$(lease_event_sql "$LEASE_TRAIN_ID" "train-$st" "deploy:$$" "$reason")"
  if release_policy_enabled; then
    policy_terminal_guard="$(cat <<SQL
CREATE TEMP TABLE _policy_terminal_guard(v INTEGER NOT NULL CHECK(v=1));
INSERT INTO _policy_terminal_guard VALUES((SELECT COUNT(*) FROM train
 WHERE executor_pid=$$ AND json_extract(evidence_json,'$.releasePolicyOwner.nonce')='$RELEASE_POLICY_NONCE'
 AND target_sha='$LEASE_TARGET_SHA' AND id='$(lease_q "$LEASE_TRAIN_ID")'
 AND (status NOT IN ('committed','failed') OR (status='$st' AND COALESCE(rel_path,'')='$(lease_q "$rel")'))
 AND ('$st'<>'committed' OR (
   json_extract(evidence_json,'$.releasePolicyAcceptance.operationId')='$(lease_q "$LEASE_TRAIN_ID")'
   AND json_extract(evidence_json,'$.releasePolicyAcceptance.candidateSha')='$LEASE_TARGET_SHA'
   AND json_extract(evidence_json,'$.releasePolicyAcceptance.nonce')='$RELEASE_POLICY_NONCE'
   AND json_extract(evidence_json,'$.releasePolicyAcceptance.resolution')='forward'))));
SQL
)" || return 79
    policy_terminal_event="$(cat <<SQL
INSERT INTO event(subject_id,event,actor,detail,created_at)
 SELECT '$(lease_q "$LEASE_TRAIN_ID")','train-$st','deploy:$$','$(lease_q "$reason")','$(lease_now)' WHERE changes()=1;
SQL
)" || return 79
  fi
  lease_tx <<SQL || terminal_rc=$?
.bail on
BEGIN IMMEDIATE;
$policy_terminal_guard
UPDATE train SET status='$st', reason='$(lease_q "$reason")', rel_path=$( [[ -n "$rel" ]] && printf "'%s'" "$(lease_q "$rel")" || printf NULL ),
       evidence_json=$evidence_merge, finished_at='$(lease_now)', updated_at='$(lease_now)'
 WHERE id='$LEASE_TRAIN_ID' AND status NOT IN ('committed','failed');
$policy_terminal_event
$( [[ "$st" == recovery_required ]] && lease_train_alert_sql "$LEASE_TRAIN_ID" "$reason (phase=${phase:-?} cutover_log=${CUTOVER_LOG:-?})" )
COMMIT;
SQL
  if [[ "$terminal_rc" != 0 ]]; then
    echo "⚠ train $LEASE_TRAIN_ID terminal write failed; retaining policy context" >&2
    release_policy_enabled && return 79
    return 0
  fi
  if release_policy_enabled; then
    release_policy_require_owner || return 86
    policy_readback="$(lease_sql "SELECT status||'|'||target_sha||'|'||COALESCE(rel_path,'')||'|'||json_extract(evidence_json,'$.releasePolicyOwner.nonce') FROM train WHERE id='$(lease_q "$LEASE_TRAIN_ID")';")" || return 79
    [[ "$policy_readback" == "$st|$LEASE_TARGET_SHA|$rel|$RELEASE_POLICY_NONCE" ]] || return 79
  fi
  LEASE_TRAIN_ACTIVE=0
  echo "  🎫 lease train $LEASE_TRAIN_ID → $st"
  if [[ "$st" == recovery_required ]]; then
    deploy_alert deploy_recovery_required "$(readlink -f -- "$MASTER_LIVE_LINK" 2>/dev/null || true)" \
      "个人版列车 $LEASE_TRAIN_ID 未完成也未干净回滚(phase=${phase:-?}),已标 recovery_required,发车暂停。现场:${CUTOVER_LOG:-?}。autorecover 接管:现场稳定绿后自动结束本班并重跑,否则退避兜底,仍失败自动开工单派给 AI。"
  fi
}

# survivor state 是 KEY=VALUE(phase=…);兼容旧 JSON。读不到返回空。
survivor_state_phase() {
  local f="${SURVIVOR_STATE:-/run/openclaude-v5-selfhost/cutover-survivor.state}" p=""
  [[ -f "$f" && ! -L "$f" ]] || return 0
  p="$(sed -n 's/^phase=//p' "$f" 2>/dev/null | head -n1)"
  [[ -n "$p" ]] || p="$(jq -er '.phase // empty' "$f" 2>/dev/null || true)"
  printf '%s' "$p"
}

# 与 worker enqueue_train_alert 同一落点:最近一条在途 ride 的工单,没有则 log。只输出 SQL,随终态同事务。
lease_train_alert_sql() { # <train_id> <reason>
  local tk
  tk="$(lease_sql "SELECT ticket_ref FROM lease WHERE resource='deploy:selfhost' AND status='registered' AND ticket_ref IS NOT NULL ORDER BY seq DESC LIMIT 1;" 2>/dev/null || true)"
  lease_outbox_sql "train:$1:recovery_required" "$1" train_alert "$( [[ -n "$tk" ]] && echo ticket || echo log )" "${tk:--}" \
    "$(lease_body_train_alert "$1" recovery_required "$2")"
}

lease_train_on_exit() {
  local rc="${1:-$?}"
  if [[ "${LEASE_TRAIN_ACTIVE:-0}" == 1 ]]; then
    lease_train_finish failed "deploy 进程退出 rc=$rc 未到 committed"
  fi
}

# Commands that built outside the lock (including P0-Web) must check again
# after acquiring it: a failed publisher may have left an intent meanwhile.
release_policy_mutation_barrier() {
  [[ "${RELEASE_POLICY_RESUME:-0}" == 1 ]] && return 0
  release_policy_context_present && return 79
  return 0
}
