"""Uses shared private original-artifact builders; no old matrix is rerun.

PID1, loaded unit/drop-in/env, physical releases, Git, original verifiers and
SQLite are real. Docker image/inventory transport is an explicit controlled
adapter: this is NOT a real container/writer-barrier or start-allowance test.
"""
import uuid

name = 'oc-206-startguard-test-' + uuid.uuid4().hex + '.service'
unit_file = Path('/run/systemd/system') / name
timer_name = name.removesuffix('.service') + '.timer'
timer_file = Path('/run/systemd/system') / timer_name
drop = Path(str(unit_file) + '.d')
live = root / 'live'
image = 'fixture/consumer:immutable'
image_id = 'sha256:' + '1' * 64
image_requests = []
inventory_paths = []


def ctl(*args):
    return run(['/usr/bin/systemctl', '--system', *args])


def unit_text(home):
    return ('[Unit]\nConditionPathExists=' + str(root / 'never-start') +
            '\n[Service]\nUser=root\nWorkingDirectory=' + str(live) +
            '\nEnvironmentFile=' + str(env_file) + '\nEnvironment=OPENCLAUDE_HOME=' + str(home) +
            '\nExecStart=/usr/bin/npx tsx packages/cli/src/index.ts gateway\n')


def make_master(label, source):
    result = master(label, source)
    f = result / 'deploy/v5-selfhost' / pf.MASTER
    f.parent.mkdir(parents=True)
    f.write_text(unit_text(root / ('home-' + label)))
    run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; write_strong_release_marker_local "$2" "$3" "${3:0:12}" 20260101-000000 2',
         'private-complete-master', str(root / 'scripts/v5-selfhost-master-release-lib.sh'), str(result), source[0]])
    return result


def check(candidate=None, *, joint=False):
    return pf.initial(str(candidate or cm), str(cr) if joint else '', image if joint else '',
                      image_id if joint else '', '', time.monotonic() + 30,
                      repository=str(repo), live=str(live), releases=str(root), unit_name=name)


def refused(fn, label):
    try:
        fn()
    except (pf.Unknown, mod.Unknown, mod.paths.Unknown, mod.inventory_reader.Unknown):
        out['cases'].append(label)
        return
    raise AssertionError(label + ': unsafe preflight accepted')


try:
    for filename, encoded in OC206_ARTIFACT_FILES.items():
        f = root / filename; f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(base64.b64decode(encoded)); f.chmod(0o700)
    spec = importlib.util.spec_from_file_location('preflight', root / 'scripts/delegate-consumer-preflight.py')
    pf = importlib.util.module_from_spec(spec); spec.loader.exec_module(pf)
    mod = pf.artifacts
    repo = root / 'repo'; repo.mkdir(); run(['/usr/bin/git', 'init', '-q', str(repo)])
    legacy = commit('legacy'); closed = commit('closed', True, 'bootstrap-closed')
    enabled = commit('enabled', True, 'enabled')
    original_deploy = (root / 'scripts/deploy-v5-selfhost.sh').read_text()
    env_file = root / 'actual.env'
    lr, cr = runtime('legacy', legacy), runtime('closed', closed)
    (root / 'scripts/deploy-v5-selfhost.sh').write_text(original_deploy)
    lm, cm, em = make_master('legacy', legacy), make_master('closed', closed), make_master('enabled', enabled)
    # Distinct master paths must be kept even when the DB doesn't yet exist.
    for label in ('legacy', 'closed', 'enabled'):
        (root / ('home-' + label)).mkdir()
    live.symlink_to(lm)
    env_file.write_text('OC_RUNTIME_IMAGE=' + image + '\nOC_RUNTIME_IMAGE_ID=' + image_id +
                       '\nOC_RUNTIME_RELEASE=' + str(lr) + '\nOC_PLATFORM_BUNDLE=\nTOKEN=never-return-this\n')
    unit_file.write_text(unit_text(root / 'home-legacy'))
    drop.mkdir(); override = drop / '20-private.conf'
    override.write_text('[Service]\nEnvironment=OPENCLAUDE_DELEGATE_JOBS_DB=' + str(root / 'override.db') + '\n')
    timer_file.write_text('[Timer]\nOnActiveSec=1h\nUnit=' + name + '\n')
    ctl('daemon-reload'); ctl('start', timer_name)
    original_run = mod._run
    def transport(argv, deadline):
        if argv[0] == '/usr/bin/docker':
            assert argv == ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'image', 'inspect', '--format', '{{.Id}}', image]
            image_requests.append(argv)
            return (image_id + '\n').encode()
        return original_run(argv, deadline)
    mod._run = transport
    def volumes(paths, deadline):
        inventory_paths.append(paths)
        return mod.inventory_reader.collect([], [], paths)
    mod.inventory_reader.capture_local = volumes

    result = check(joint=True)
    assert result['status'] == 'compatible_snapshot' and result['requiresQuiescence'] is True
    assert set(inventory_paths[-1]) == {str(root / 'override.db')}, 'existing drop-in must apply to candidate too'
    assert image_requests and 'never-return-this' not in json.dumps(result)
    out['cases'].append('real-loaded-dropin-joint-source-pair-needs-barrier')
    override.write_text('[Service]\n'); ctl('daemon-reload')
    result = check(joint=True)
    assert result['status'] == 'compatible_snapshot'
    assert set(inventory_paths[-1]) == {str(root / 'home-legacy/delegate-jobs.db'), str(root / 'home-closed/delegate-jobs.db')}
    out['cases'].append('candidate-and-current-absent-master-paths-in-inventory')
    result = check(lm)
    assert result['status'] == 'compatible_snapshot'
    out['cases'].append('master-only-retains-exact-effective-tuple')
    result = check(em, joint=True)
    assert result['status'] == 'incompatible' and result['required'] == 2
    out['cases'].append('enabled-candidate-rejects-empty-legacy-fallback')
    mod._run = lambda argv, deadline: (('sha256:' + '2' * 64 + '\n').encode() if argv[0] == '/usr/bin/docker' else original_run(argv, deadline))
    refused(lambda: check(joint=True), 'immutable-tag-drift-refused')
    mod._run = transport
    saved = env_file.read_text()
    env_file.write_text(saved.replace('OC_RUNTIME_IMAGE_ID=' + image_id + '\n', ''))
    refused(lambda: check(joint=True), 'missing-image-id-not-ambient-default')
    env_file.write_text(saved.replace('OC_RUNTIME_RELEASE=' + str(lr), 'OC_RUNTIME_RELEASE='))
    refused(lambda: check(joint=True), 'embedded-without-source-adapter-unknown')
    env_file.write_text(saved)
    # Change actual EnvironmentFile after SQLite capture, not a synthetic hash.
    def race(paths, deadline):
        result = volumes(paths, deadline)
        env_file.write_text(saved + 'IGNORED_SECRET=changed\n')
        return result
    mod.inventory_reader.capture_local = race
    refused(lambda: check(joint=True), 'actual-env-change-after-inventory-refused')
    env_file.write_text(saved); mod.inventory_reader.capture_local = volumes
    # Actual loaded plan must not follow a changed on-disk drop-in without reload.
    override.write_text('[Service]\nEnvironment=OPENCLAUDE_HOME=' + str(root / 'changed') + '\n')
    refused(lambda: check(joint=True), 'pending-effective-unit-reload-refused')
    override.write_text('[Service]\n'); ctl('daemon-reload')
    def flip(paths, deadline):
        result = volumes(paths, deadline)
        live.unlink(); live.symlink_to(cm)
        return result
    mod.inventory_reader.capture_local = flip
    refused(lambda: check(joint=True), 'actual-selector-flip-after-inventory-refused')
    live.unlink(); live.symlink_to(lm); mod.inventory_reader.capture_local = volumes
    assert ctl('show', name, '--property=MainPID', '--value').strip() == '0'
    out['consumerStarts'] = 0

    # Extract the ORIGINAL cmd_cutover and initial-caller wrapper. The private
    # command reaches the real helper logic via a private transport harness;
    # markers prove rejected preflight cannot run original backup/arm/install.
    # No regex assertion of source order stands in for this business outcome.
    source = (root / 'scripts/deploy-v5-selfhost.sh').read_text().replace('/opt/openclaude/tmp', str(root / 'logs'))
    def function(name):
        start = source.index('\n' + name + '() {') + 1
        end = source.index('\n}\n', start) + 3
        return source[start:end]
    shell = root / 'private-caller.sh'
    shell.write_text('''set -eu
DRY=0; CUTOVER_JOINT=1; DEPLOY_BUILT_RELEASE="$1"; MASTER_LIVE_LINK="$2"
SCRIPT_DIR="$3"; BUILT_RUNTIME_RELEASE="$4"; RUNTIME_IMAGE=fixture/consumer:immutable
RUNTIME_IMAGE_ID="sha256:'''+ '1' * 64 +'''"; CUTOVER_TUPLE_BUNDLE=""
SELFHOST_DEPLOY_LOCK=/private/original-lock
cutover_clog(){ :; }; cutover_expected_source_commit(){ echo private; }
assert_master_release_static_gate(){ :; }; assert_master_release_tsx_selfcheck(){ :; }
dist_oc_build(){ echo private; }; snapshot_cutover_units_from_release(){ printf -v "$2" '%s' "$1/deploy/v5-selfhost"; }
gate_cutover_migrations(){ CUTOVER_HAS_MIGRATION=0; }
backup_installed_units_for_cutover(){ echo backup >>"$MARKERS"; return 90; }
cutover_arm_survivor(){ echo arm >>"$MARKERS"; return 90; }
install_unit(){ echo install >>"$MARKERS"; return 90; }
die(){ exit 91; }
python3(){ /usr/bin/python3 "$FIXTURE_GATE" "$@"; }
''' + function('cutover_consumer_preflight') + '\n' + function('cmd_cutover') + '\ncmd_cutover\n')
    # The original caller now runs the real preflight main() in a fresh process.
    # Only private path selection and Docker transport are explicit fixture seams;
    # no fake compatible verdict, SQL state, environment proof or gate exit.
    gate = root / 'private-gate.py'
    gate.write_text('''import importlib.util,json,os,pathlib,sys
assert sys.argv[2:] == json.loads(os.environ['EXPECTED_ARGS'])
spec=importlib.util.spec_from_file_location('private_real_preflight',sys.argv[1])
pf=importlib.util.module_from_spec(spec);spec.loader.exec_module(pf)
original=pf.initial
private=json.loads(os.environ['PRIVATE_CONTEXT'])
def initial(*args):
 return original(*args,repository=private['repository'],live=private['live'],
                 releases=private['releases'],unit_name=private['unit'])
pf.initial=initial
run=pf.artifacts._run
def transport(argv,deadline):
 if argv[0]=='/usr/bin/docker':
  assert argv==['/usr/bin/docker','--host=unix:///var/run/docker.sock','image','inspect','--format','{{.Id}}',private['image']]
  return ((private['image_id'] if os.environ['SCENARIO']=='incompatible' else 'invalid-image')+'\\n').encode()
 return run(argv,deadline)
pf.artifacts._run=transport
pf.inventory.capture_local=lambda paths,deadline: pf.inventory.collect([],[],paths)
sys.argv=sys.argv[1:]
rc=pf.main()
pathlib.Path(os.environ['GATE_CALLED']).write_text(str(rc))
raise SystemExit(rc)
''')
    marker = root / 'caller-markers'
    args = ['--candidate-master', str(em), '--candidate-runtime', str(cr), '--candidate-image', image,
            '--candidate-image-id', image_id, '--candidate-bundle', '']
    for scenario, status in [('incompatible', 1), ('unknown', 2)]:
        r = subprocess.run(['/bin/bash', str(shell), str(em), str(live), str(root / 'scripts'), str(cr)],
            capture_output=True, text=True, timeout=40,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'MARKERS': str(marker), 'FIXTURE_GATE': str(gate),
                 'EXPECTED_ARGS': json.dumps(args), 'SCENARIO': scenario, 'GATE_CALLED': str(root / 'gate-called'),
                 'PRIVATE_CONTEXT': json.dumps({'repository': str(repo), 'live': str(live), 'releases': str(root),
                                                'unit': name, 'image': image, 'image_id': image_id})})
        assert not marker.exists(), 'rejected original caller reached backup/arm/install'
        assert r.returncode == 1 and (root / 'gate-called').read_text() == str(status), r.stderr
        (root / 'gate-called').unlink()
    out['cases'].append('original-cutover-incompatible-and-unknown-before-mutation')
except BaseException as exc:
    error = type(exc).__name__ + ': ' + str(exc)
    out['failure'] = error
finally:
    cleanup_errors = []
    for filename, service in ((timer_file, timer_name), (unit_file, name)):
        try:
            if filename.exists():
                ctl('stop', service)
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__ + ': stop ' + service)
    for action in (lambda: shutil.rmtree(drop) if drop.exists() else None,
                   lambda: unit_file.unlink(missing_ok=True),
                   lambda: timer_file.unlink(missing_ok=True),
                   lambda: ctl('daemon-reload')):
        try:
            action()
        except BaseException as exc:
            cleanup_errors.append(type(exc).__name__)
    try:
        assert ctl('show', name, '--property=LoadState', '--value').strip() == 'not-found'
        assert ctl('show', timer_name, '--property=LoadState', '--value').strip() == 'not-found'
        shutil.rmtree(root)
        out['cleanupComplete'] = not cleanup_errors and not root.exists() and not unit_file.exists() and not drop.exists() and not timer_file.exists()
    except BaseException as exc:
        cleanup_errors.append(type(exc).__name__ + ': ' + str(exc))
    if cleanup_errors:
        out['cleanupFailures'] = cleanup_errors
print(json.dumps(out))
raise SystemExit(0 if error is None and len(out['cases']) == 11 and out['cleanupComplete'] else 1)
