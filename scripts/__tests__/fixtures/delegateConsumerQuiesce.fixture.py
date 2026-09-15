"""Real original FD8/caller + durable state + PID1/cgroup; Docker seam only.

Private synthetic node import loader and detached Python/SQLite descendant,
NOT application, model, platform-schema writer or all-container quiescence.
"""
import signal
import select
import uuid

names = []
pidfds = []
cgroup_handles = []
image = 'fixture/consumer:immutable'
image_id = 'sha256:' + '1' * 64
error = None


def ctl(*args):
    return run(['/usr/bin/systemctl', '--system', *args])


def template(home, env):
    return ('[Service]\nType=simple\nUser=root\nWorkingDirectory=' + str(live) +
            '\nEnvironmentFile=' + str(env) + '\nEnvironment=OPENCLAUDE_HOME=' + str(home) +
            '\nExecStart=/usr/bin/node --import tsx packages/commercial/src/egress/main.ts\n'
            'TimeoutStopSec=3\nKillMode=control-group\n')


def make_master(label, source):
    r = master(label, source)
    f = r / 'deploy/v5-selfhost' / pf.MASTER
    f.parent.mkdir(parents=True); f.write_text(template(root / ('home-' + label), env_file))
    loader = r / 'node_modules/tsx'
    (loader / 'package.json').write_text('{"type":"module","exports":"./index.mjs"}')
    (loader / 'index.mjs').write_text("import {spawn} from 'node:child_process'; spawn('/usr/bin/python3',[process.env.PRIVATE_WORKER,process.env.PRIVATE_CASE],{detached:true,stdio:'ignore'}); await new Promise(()=>setInterval(()=>{},1000));\n")
    run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; write_strong_release_marker_local "$2" "$3" "${3:0:12}" 20260101-000000 2',
         'private-master', str(root / 'scripts/v5-selfhost-master-release-lib.sh'), str(r), source[0]])
    return r


def counter(case):
    with sqlite3.connect(case / 'writer.db') as db:
        return db.execute('select count(*) from written').fetchone()[0]


try:
    for filename, encoded in OC206_ARTIFACT_FILES.items():
        p = root / filename; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(base64.b64decode(encoded)); p.chmod(0o700)
    spec = importlib.util.spec_from_file_location('preflight', root / 'scripts/delegate-consumer-preflight.py')
    pf = importlib.util.module_from_spec(spec); spec.loader.exec_module(pf); mod = pf.artifacts
    original_deploy = (root / 'scripts/deploy-v5-selfhost.sh').read_text()
    repo = root / 'repo'; repo.mkdir(); run(['/usr/bin/git', 'init', '-q', str(repo)])
    legacy = commit('legacy'); closed = commit('closed', True, 'bootstrap-closed'); enabled = commit('enabled', True, 'enabled')
    live = root / 'live'; env_file = root / 'actual.env'
    lr, cr = runtime('legacy', legacy), runtime('closed', closed)
    (root / 'scripts/deploy-v5-selfhost.sh').write_text(original_deploy)
    lm, cm, em = make_master('legacy', legacy), make_master('closed', closed), make_master('enabled', enabled)
    for label in ('legacy', 'closed', 'enabled'): (root / ('home-' + label)).mkdir()
    live.symlink_to(lm)
    env_file.write_text('OC_RUNTIME_IMAGE=' + image + '\nOC_RUNTIME_IMAGE_ID=' + image_id + '\nOC_RUNTIME_RELEASE=' + str(lr) + '\nOC_PLATFORM_BUNDLE=\n')
    worker = root / 'worker.py'
    worker.write_text('''import os,pathlib,sqlite3,sys,time
root=pathlib.Path(sys.argv[1])
pid=os.fork()
if pid: raise SystemExit(0)
os.setsid()
db=sqlite3.connect(root/'writer.db');db.execute('create table written(n integer)');db.commit()
(root/'writer.pid').write_text(str(os.getpid()))
while True:
 db.execute('insert into written values(1)');db.commit();time.sleep(.015)
''')
    lock_functions = original_deploy[original_deploy.index('selfhost_lock_holder_info() {'):original_deploy.index('maybe_acquire_selfhost_deploy_lock() {')]
    start = original_deploy.index('\ncutover_consumer_preflight() {') + 1
    caller = original_deploy[start:original_deploy.index('\n}\n', start) + 3]
    survivor = (root / 'scripts/v5-selfhost-cutover-survivor.sh').read_text()
    survivor = survivor[:survivor.rindex('\ncase "${1:-}" in')]
    driver = root / 'driver.sh'
    driver.write_text('''set -euo pipefail
log(){ :; }; die(){ echo "$*" >&2; exit 90; }
SELFHOST_DEPLOY_LOCK_DIR="$PRIVATE_CASE"
SELFHOST_DEPLOY_LOCK="$PRIVATE_CASE/deploy.lock"
SELFHOST_DEPLOY_LOCK_WAIT=0; SELFHOST_DEPLOY_LOCK_POLL=1
''' + lock_functions + '\nacquire_selfhost_deploy_lock\n' + survivor + '''
SCRIPT_DIR="$PRIVATE_ROOT/scripts"; CUTOVER_JOINT=1
BUILT_RUNTIME_RELEASE="$PRIVATE_RUNTIME"; RUNTIME_IMAGE=fixture/consumer:immutable
RUNTIME_IMAGE_ID="sha256:''' + '1' * 64 + '''"; CUTOVER_TUPLE_BUNDLE=""
write_state "$$" "$PRIVATE_CASE/backup" armed '2026-01-01T00:00:00Z'
python3(){ /usr/bin/python3 "$PRIVATE_GATE" "$@"; }
''' + caller + '''
rc=0
if [[ "$SCENARIO" == no-fd ]]; then
 cutover_consumer_preflight "$PRIVATE_CANDIDATE" enroll 8>&- || rc=$?
else
 cutover_consumer_preflight "$PRIVATE_CANDIDATE" enroll || rc=$?
fi
if [[ "$rc" == 0 ]]; then printf proceeded >"$PRIVATE_CASE/proceeded"; fi
printf '%s' "$rc" >"$PRIVATE_CASE/caller.exit"
exit "$rc"
''')
    gate = root / 'gate.py'
    gate.write_text('''import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('real_preflight',sys.argv[1]);pf=importlib.util.module_from_spec(spec);spec.loader.exec_module(pf)
private=json.loads(os.environ['PRIVATE_CONTEXT']);capture=pf.capture_transition
def bound(*args,**kw):
 return capture(*args,repository=private['repository'],live=private['live'],releases=private['releases'],unit_name=private['unit'])
pf.capture_transition=bound
run=pf.artifacts._run
def transport(argv,deadline):
 if argv[0]=='/usr/bin/docker':
  assert argv==['/usr/bin/docker','--host=unix:///var/run/docker.sock','image','inspect','--format','{{.Id}}',private['image']]
  return ((private['image_id'] if os.environ['SCENARIO']!='unknown' else 'unknown')+'\\n').encode()
 return run(argv,deadline)
pf.artifacts._run=transport
pf.inventory.capture_local=lambda paths,deadline: pf.inventory.collect([],[],paths)
sys.argv=sys.argv[1:];raise SystemExit(pf.main())
''')
    for mode in OC206_QUIESCE_CASES:
        case = root / mode; case.mkdir()
        name = 'oc-206-startguard-test-' + uuid.uuid4().hex + '.service'
        unit = Path('/run/systemd/system') / name; names.append((unit, name))
        text = template(root / 'home-legacy', env_file)
        text += 'Environment=PRIVATE_WORKER=' + str(worker) + '\nEnvironment=PRIVATE_CASE=' + str(case) + '\n'
        if mode == 'descendant-remains': text = text.replace('KillMode=control-group', 'KillMode=process')
        unit.write_text(text); ctl('daemon-reload'); ctl('start', name)
        # Retain real kernel identity before the writer PID is ready, so a
        # setup failure also has a subtree-death oracle, not just MainPID=0.
        cgroup_handles.append(pf.cgroups.PinnedCgroup(ctl('show', name, '--property=ControlGroup', '--value')))
        until = time.monotonic() + 5
        while not (case / 'writer.pid').exists() and time.monotonic() < until: time.sleep(.02)
        assert (case / 'writer.pid').exists(), 'real detached private writer not ready'
        pidfd = os.pidfd_open(int((case / 'writer.pid').read_text())); pidfds.append(pidfd)
        before = counter(case)
        context = {'repository': str(repo), 'live': str(live), 'releases': str(root), 'unit': name, 'image': image, 'image_id': image_id}
        env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'PRIVATE_ROOT': str(root), 'PRIVATE_CASE': str(case),
               'PRIVATE_GATE': str(gate), 'PRIVATE_RUNTIME': str(cr), 'PRIVATE_CANDIDATE': str(em if mode == 'incompatible' else cm),
               'PRIVATE_CONTEXT': json.dumps(context), 'SCENARIO': mode,
               'SURVIVOR_STATE': str(case / 'legacy.state'), 'SURVIVOR_CONSUMER_STATE': str(case / 'consumer.state')}
        result = subprocess.run(['/bin/bash', str(driver)], env=env, capture_output=True, text=True, timeout=55)
        (case / 'driver.log').write_text(result.stdout + result.stderr)
        statefile = case / 'consumer.state'
        if mode == 'normal':
            assert result.returncode == 0 and (case / 'proceeded').exists(), result.stdout + result.stderr
            assert statefile.exists(), 'original caller skipped durable enrollment'
            record = pf.artifacts.state.read(str(statefile))
            assert record['consumer_version'] == '2' and record['consumer_phase'] == 'quiescing'
            assert record['phase'] == 'consumer-master-stopped'
            intent = json.loads(record['consumer_intent'])
            assert intent['descriptor']['candidate']['master']['root'] == str(cm)
            assert intent['descriptor']['current']['master']['root'] == str(lm)
            assert intent['descriptor']['candidate']['tuple']['OC_RUNTIME_RELEASE'] == str(cr)
            count = counter(case); time.sleep(.09)
            assert counter(case) == count, 'detached writer continued after real master stop'
            assert ctl('show', name, '--property=MainPID', '--value') == '0'
            out['cases'].append('original-FD8-caller-fsync-intent-then-real-subtree-stop')
        else:
            assert result.returncode != 0 and not (case / 'proceeded').exists(), 'unsafe stage proceeded: ' + mode
            if mode == 'descendant-remains':
                record = pf.artifacts.state.read(str(statefile))
                assert record['consumer_phase'] == 'manual' and record['phase'] == 'consumer-stop-failed'
                assert ctl('show', name, '--property=MainPID', '--value') == '0'
            else:
                assert not statefile.exists(), 'failed precondition enrolled or stopped: ' + mode
                assert ctl('show', name, '--property=MainPID', '--value') != '0'
            count = counter(case); time.sleep(.08)
            assert counter(case) > count, 'expected live private writer vanished before quiesce: ' + mode
            out['cases'].append('refuse-' + mode)
        try: signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        except ProcessLookupError: pass
        ctl('stop', name)
    out['applicationStarts'] = 0
except BaseException as exc:
    error = type(exc).__name__ + ': ' + str(exc)
    out['failure'] = error
finally:
    cleanup_errors = []
    for fd in pidfds:
        try: signal.pidfd_send_signal(fd, signal.SIGKILL)
        except ProcessLookupError: pass
        except BaseException as exc: cleanup_errors.append(type(exc).__name__)
    for unit, name in names:
        # KillMode=process intentionally leaves a descendant in one case.
        # This exact PRIVATE unit kill also covers a failure before writer.pid
        # or pidfd registration. An already empty/inactive unit may reject kill;
        # that return code is not the cleanup oracle: held cgroup + pidfds are.
        try:
            subprocess.run(['/usr/bin/systemctl', '--system', 'kill', '--kill-whom=all', '--signal=KILL', '--', name],
                           capture_output=True, text=True, timeout=15)
        except BaseException as exc: cleanup_errors.append(type(exc).__name__ + ': kill ' + name)
        try: ctl('stop', name)
        except BaseException as exc: cleanup_errors.append(type(exc).__name__ + ': stop ' + name)
        try: unit.unlink(missing_ok=True)
        except BaseException as exc: cleanup_errors.append(type(exc).__name__ + ': remove ' + name)
    for fd in pidfds:
        try:
            poll = select.poll(); poll.register(fd, select.POLLIN)
            assert poll.poll(5000), 'private descendant did not exit after kill'
        except BaseException as exc: cleanup_errors.append(type(exc).__name__ + ': descendant death')
        finally: os.close(fd)
    for held in cgroup_handles:
        try: held.verify_stopped()
        except BaseException as exc: cleanup_errors.append(type(exc).__name__ + ': subtree death')
        finally: held.close()
    try:
        ctl('daemon-reload')
        for unit, name in names:
            assert ctl('show', name, '--property=LoadState', '--value') == 'not-found'
        assert len(cgroup_handles) == len(names), 'not every created unit has a retained subtree-death proof'
        if not cleanup_errors: shutil.rmtree(root)
        out['cleanupComplete'] = not cleanup_errors and not root.exists() and all(not p.exists() for p, _ in names)
    except BaseException as exc: cleanup_errors.append(type(exc).__name__)
    if cleanup_errors:
        out['cleanupFailures'] = cleanup_errors
        out['retainedPrivateEvidence'] = str(root)
print(json.dumps(out))
raise SystemExit(0 if error is None and len(out['cases']) == len(OC206_QUIESCE_CASES) and out['cleanupComplete'] else 1)
