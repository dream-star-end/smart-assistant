#!/usr/bin/env python3
"""Actual selfhost CLI, transaction and worker; every path stays in one private fixture."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bind_fixture', SCRIPTS/'__tests__/v5SelfhostPolicyBind.test.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


def register(c, allow=False, owner='one', sha=None, policy=False):
    args = ['bash', str(SCRIPTS/'oc-lease.sh'), 'register', '--resource', 'deploy:selfhost',
            '--mode', 'ride', '--sha', sha or c.sha, '--callback', 'none', '--uid', '3',
            '--owner', owner, '--ticket', 'OCV5-527']
    if allow:
        args += ['--allow-inflight']
    if policy:
        args += ['--release-policy', 'user-impact-only']
    return f.run(args, c.env)


def bind(c, target=None):
    script = '''set -euo pipefail
source "$1/v5-lease-lib.sh"
views="$(lease_policy_views_sql deploy:selfhost)"
policy="$(lease_policy_bind_sql "$P521_TRAIN" "$P521_SHA" fixture)"
inflight="$(lease_inflight_bind_sql "$P521_TRAIN" "$P521_SHA" fixture)"
lease_tx <<SQL
.bail on
BEGIN IMMEDIATE;
$views
$policy
$inflight
COMMIT;
SQL
'''
    return f.run(['bash', '-c', script, 'fixture', str(SCRIPTS)], dict(c.env, P521_SHA=target or c.sha))


def allowed(c, target=None):
    return f.run(['bash', '-c', 'source "$1/v5-lease-lib.sh"; lease_inflight_train_allowed "$P521_TRAIN" "$P521_SHA"',
                  'fixture', str(SCRIPTS)], dict(c.env, P521_SHA=target or c.sha)).returncode == 0


def adopt(c, cli=False, policy=False, unlocked=False):
    # Extract the production caller functions, including the real claim implementation.
    lines = (SCRIPTS/'deploy-v5-selfhost.sh').read_text().splitlines(keepends=True)
    functions = c.root/'actual-claim.sh'
    out = []
    for name in ['lease_train_load_lib', 'lease_train_begin', 'proc_starttime_of']:
        start = next(i for i,line in enumerate(lines) if line.startswith(name+'() {'))
        end = next(i for i in range(start+1,len(lines)) if lines[i].rstrip()=='}')
        out.extend(lines[start:end+1])
    functions.write_text(''.join(out))
    script = r'''set -Eeuo pipefail
SCRIPT_DIR="$1"
source "$SCRIPT_DIR/v5-lease-lib.sh"
source "$SCRIPT_DIR/lib/v5-selfhost-release-policy.sh"
source "$SCRIPT_DIR/v5-selfhost-master-release-lib.sh"
source "$2"
log() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 2; }
LEASE_LIB="$SCRIPT_DIR/v5-lease-lib.sh"
LEASE_TRAIN_ID="$P521_TRAIN"; LEASE_TARGET_SHA="$P521_SHA"
LEASE_TRAIN_ACTIVE=0; ALLOW_INFLIGHT="$FIXTURE_CLI"; DRY=0
PG_DB=openclaude_v5_selfhost
SELFHOST_DEPLOY_LOCK="$OC_V5_SELFHOST_DEPLOY_LOCK"
exec 8>"$SELFHOST_DEPLOY_LOCK"
[[ "$FIXTURE_UNLOCKED" == 1 ]] || flock -x 8
if [[ "$FIXTURE_POLICY" == 1 ]]; then
 release_policy_bind_official_train_request "$P521_SHA"
fi
cutover_adopt_inflight_request "$P521_SHA"
printf 'WITNESS {"allow":%s,"active":%s,"pid":%s}\n' "$ALLOW_INFLIGHT" "$LEASE_TRAIN_ACTIVE" "$$"
'''
    result = f.run(['bash','-c',script,'fixture',str(SCRIPTS),str(functions)],
        dict(c.env,FIXTURE_CLI=str(int(cli)),FIXTURE_POLICY=str(int(policy)),FIXTURE_UNLOCKED=str(int(unlocked))))
    witnesses = [json.loads(x[8:]) for x in result.stdout.splitlines() if x.startswith('WITNESS ')]
    return result, witnesses[0] if witnesses else None


def adoption_cases(make, before):
    for status in ['planned','building']:
        c=make('old-worker-'+status)
        f.fm.need(register(c,True).returncode==0,'old worker registration')
        c.train()
        c.sql('UPDATE train SET status=?',(status,))
        result,w=adopt(c)  # No flag argv and no frozen snapshot, as with the installed old live worker.
        f.fm.need(result.returncode==0 and w['allow']==1 and w['active']==1,
                  'actual old-worker adoption failed: '+result.stderr)
        f.fm.need(allowed(c) and c.sql('SELECT executor_pid FROM train')[0][0]==w['pid'],
                  'old worker did not freeze permission under the real claim')
        frozen=c.snapshot()
        f.fm.need(bind(c).returncode==0 and c.snapshot()==frozen,'frozen binding was rewritten')
    c=make('adopt-default')
    f.fm.need(register(c).returncode==0,'default adoption register')
    c.train(); original=c.snapshot()
    result,w=adopt(c)
    f.fm.need(result.returncode==0 and w['allow']==0 and w['active']==0 and c.snapshot()==original,
              'default adopted or claimed permission')
    result,_=adopt(c,cli=True)
    f.fm.need(result.returncode!=0 and c.snapshot()==original,'CLI without original permission accepted')
    for kind in ['wrong-source','malformed','snapshot-mismatch','unlocked','manual-owner','wrong-target']:
        c=make('reject-'+kind)
        f.fm.need(register(c,True).returncode==0,'reject case registration')
        c.train()
        if kind=='wrong-source':
            c.sql("UPDATE lease SET result_json=json_set(result_json,'$.request.cutover.sourceSha',?)",(before,))
        elif kind=='malformed':
            c.sql("UPDATE lease SET result_json=json_set(result_json,'$.request.cutover.schema','1')")
        elif kind=='snapshot-mismatch':
            c.sql("UPDATE train SET evidence_json=json_set(evidence_json,'$.cutover',json(?))",
                  (json.dumps({'schema':1,'sourceSha':c.sha,'allowInflight':True,'leaseIds':['unknown']}),))
        elif kind=='manual-owner':
            c.sql("UPDATE train SET owner='manual:424242'")
        elif kind=='wrong-target':
            c.sql('UPDATE train SET target_sha=?',(before,))
        original=c.snapshot()
        result,_=adopt(c,unlocked=(kind=='unlocked'))
        f.fm.need(result.returncode!=0 and c.snapshot()==original,'adopter mutated rejected '+kind)
    c=make('adopt-policy')
    f.fm.need(register(c,True,policy=True).returncode==0,'coexisting policy register')
    c.train()
    result,w=adopt(c,policy=True)
    f.fm.need(result.returncode==0 and w['allow']==1 and allowed(c),'policy/adopter coexistence: '+result.stderr)
    doc=c.doc()
    f.fm.need(doc['releasePolicy']['mode']=='user-impact-only' and
              doc['releasePolicyOwner']['pid']==w['pid'] and
              len(c.sql("SELECT 1 FROM event WHERE event='executor-begin'"))==1,
              'adoption changed policy or claimed twice')


def worker_case(c, allow, systemd):
    bin_dir = c.root/'bin'
    bin_dir.mkdir()
    args_file = c.root/'deploy.argv'
    fake = bin_dir/'fake-deploy'
    fake.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "'+str(args_file)+'"\n')
    fake.chmod(0o755)
    task = bin_dir/'fake-task'
    task.write_text('#!/bin/sh\nexit 0\n')
    task.chmod(0o755)
    c.env.update(OC_V5_AUTORECOVER='off', OC_V5_LEASE_WORKER_LOCK=str(c.root/'worker.lock'),
        OC_V5_LEASE_LOG_DIR=str(c.root/'logs'), OC_V5_LEASE_DEPLOY_BIN=str(fake),
        OC_V5_LEASE_TASK_CLI=str(task), OC_V5_LEASE_SURVIVOR_COMMITTED=str(c.root/'committed'),
        OC_V5_LEASE_CUTOVER_GRACE_FILE=str(c.root/'grace'))
    (c.root/'committed').touch()
    c.env.pop('INVOCATION_ID', None)
    if systemd:
        # Capture the real systemd-run argv without contacting systemd or spawning a service.
        mock = bin_dir/'systemd-run'
        mock.write_text('#!/bin/bash\nwhile [[ "$1" != "'+str(fake)+'" ]]; do shift; done\nshift\nprintf "%s\\n" "$@" > "'+str(args_file)+'"\n')
        mock.chmod(0o755)
        ctl = bin_dir/'systemctl'
        ctl.write_text('#!/bin/sh\nprintf "424242\\n"\n')
        ctl.chmod(0o755)
        c.env.update(INVOCATION_ID='private-fixture', PATH=str(bin_dir)+':'+c.env['PATH'])
    f.fm.need(register(c, allow).returncode == 0, 'actual worker registration')
    admission = args_file.parent/'admission'
    admission.mkdir()
    (admission/'loadavg').write_text('1.00 1 1 1/1 1\n')
    c.env.update(MASTER_GATE_LOADAVG=str(admission/'loadavg'),
                 MASTER_GATE_PROC_ROOT=str(admission), MASTER_GATE_TEST_LOCK_DIR=str(admission))
    result = f.run(['bash', str(SCRIPTS/'v5-lease-worker.sh')], c.env)
    f.fm.need(result.returncode == 0, 'actual worker failed: '+result.stderr)
    for _ in range(40):
        if args_file.exists():
            break
        time.sleep(.025)
    args = args_file.read_text().splitlines()
    f.fm.need(('--allow-inflight' in args) is allow, 'worker argv flag mismatch')
    f.fm.need('--target-sha='+c.sha in args, 'worker changed target')
    row = c.sql('SELECT evidence_json FROM train')[0][0]
    snapshot = json.loads(row or '{}')
    f.fm.need(('cutover' in snapshot) is allow, 'frozen train permission mismatch')
    if allow:
        f.fm.need(snapshot['cutover']['sourceSha'] == c.sha, 'worker source binding')
        train = c.sql('SELECT id FROM train')[0][0]
        env = dict(c.env, P521_TRAIN=train)
        result = f.run(['bash', '-c', 'source "$1/v5-lease-lib.sh"; lease_inflight_train_allowed "$P521_TRAIN" "$P521_SHA"',
                        'fixture', str(SCRIPTS)], env)
        f.fm.need(result.returncode == 0, 'actual worker snapshot did not validate')


def main():
    with tempfile.TemporaryDirectory(prefix='ocv5-527-inflight-') as temp:
        root = Path(temp)
        repo, (before, target, next_sha) = f.fm.git_fixture(root)
        origin = root/'origin.git'
        env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        for cmd in [['git','init','-q','--bare',str(origin)],
                    ['git','-C',str(repo),'remote','add','origin',str(origin)],
                    ['git','-C',str(repo),'push','-q','origin',target+':refs/heads/fixture'],
                    ['git','-C',str(repo),'checkout','-q','--detach',target]]:
            f.fm.need(f.run(cmd, env).returncode == 0, 'private origin setup')
        make = lambda name: f.Case(root/name, repo, before, target)
        c = make('explicit')
        f.fm.need(register(c, True, policy=True).returncode == 0, 'explicit registration')
        original = c.snapshot()
        f.fm.need(register(c, True, policy=True).returncode == 0 and c.snapshot() == original, 'idempotency changed metadata')
        for args in [(False, 'one', None, True), (False, 'mixed', None, True), (True, 'old', before, True)]:
            f.fm.need(register(c, *args).returncode != 0 and c.snapshot() == original, 'changed flag/mixed/non-tip registration accepted')
        c.train()
        f.fm.need(bind(c).returncode == 0 and allowed(c), 'actual binding did not authorize exact source')
        snapshot = c.doc()
        f.fm.need(snapshot['fixtureTrain'] == {'keep':True}, 'unrelated train metadata replaced')
        f.fm.need(snapshot['releasePolicy']['mode'] == 'user-impact-only', 'release policy changed')
        raw = json.dumps(snapshot)
        for mutation in [dict(snapshot['cutover'], allowInflight='true'),
                         dict(snapshot['cutover'], sourceSha=before),
                         dict(snapshot['cutover'], leaseIds=[]),
                         dict(snapshot['cutover'], leaseIds=['unknown'])]:
            doc = dict(snapshot, cutover=mutation)
            c.sql('UPDATE train SET evidence_json=?', (json.dumps(doc),))
            f.fm.need(not allowed(c), 'malformed snapshot allowed')
        c.sql('UPDATE train SET evidence_json=?', (raw,))
        c.sql("UPDATE lease SET result_json=json_set(result_json,'$.request.cutover.sourceSha',?)", (before,))
        f.fm.need(not allowed(c), 'changed original request allowed')
        default = make('default')
        f.fm.need(register(default).returncode == 0, 'default register')
        default.train()
        f.fm.need(bind(default).returncode == 0 and not allowed(default), 'default unexpectedly permits inflight')
        late = make('late')
        late.train()
        snap = late.snapshot()
        f.fm.need(register(late, True).returncode != 0 and late.snapshot() == snap, 'late request changed train')
        for allow in [False, True]:
            for systemd in [False, True]:
                worker_case(make(f'worker-{allow}-{systemd}'), allow, systemd)
        adoption_cases(make, before)
        frozen = make('advanced')
        f.fm.need(register(frozen, True).returncode == 0, 'advance seed register')
        for cmd in [['git','-C',str(repo),'push','-q','origin',next_sha+':refs/heads/fixture'],
                    ['git','-C',str(repo),'checkout','-q','--detach',next_sha]]:
            f.fm.need(f.run(cmd, env).returncode == 0, 'advance private tip')
        frozen.train(sha=next_sha)
        snap = frozen.snapshot()
        f.fm.need(bind(frozen,next_sha).returncode != 0 and frozen.snapshot() == snap, 'permission followed a newer tip')
    print('PASS selfhost inflight registration, frozen binding, old-worker adoption and worker argv')


if __name__ == '__main__':
    main()
