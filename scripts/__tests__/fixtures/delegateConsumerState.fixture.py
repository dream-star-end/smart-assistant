"""Opt-in root test of original survivor CLI and inherited original deploy FD8.

Harness prepends OC206_STATE_FILES (base64 exact source),
OC206_DEPLOY_LOCK_FUNCTIONS and OC206_DEPLOY_PHASE_FUNCTIONS. Only private /var/lib and /run directories, no real
unit/DB/production environment. Losing private /run simulates volatile loss;
new processes are real, but this is NOT a machine reboot or systemd start test.
"""
import base64
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile

assert os.geteuid() == 0
root = Path(tempfile.mkdtemp(prefix='oc-206-state-test-', dir='/var/lib'))
volatile = Path(tempfile.mkdtemp(prefix='oc-206-state-test-', dir='/run'))
child = None
out = {'cases': [], 'cleanupComplete': False}
error = None


def line():
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(6), 'private original lock holder timed out'
        return child.stdout.readline().strip()


def action(value):
    child.stdin.write(value + '\n')
    child.stdin.flush()
    return line()


def snapshot():
    return dict(line.split('=', 1) for line in durable.read_text().splitlines())


def run(*args):
    return subprocess.run(['/bin/bash', str(root / 'survivor.sh'), *args], env=env,
                          text=True, capture_output=True, timeout=6)


try:
    for name, content in OC206_STATE_FILES.items():
        path = root / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(base64.b64decode(content))
        path.chmod(0o700)
    # Any unexpected old disarm/systemd path stays private and is an assertion
    # failure, never a command against a production unit.
    private_bin = root / 'bin'
    private_bin.mkdir()
    for command in ('systemctl', 'systemd-run'):
        p = private_bin / command
        p.write_text('#!/bin/sh\nprintf reached >>"$PRIVATE_ROOT/unexpected-systemd"\nexit 99\n')
        p.chmod(0o700)
    durable = root / 'consumer.state'
    legacy = volatile / 'state'
    env = {'PATH': str(private_bin) + ':/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(root),
           'PRIVATE_ROOT': str(root), 'SURVIVOR_STATE': str(legacy),
           'SURVIVOR_COMMITTED': str(volatile / 'committed'), 'SURVIVOR_CONSUMER_STATE': str(durable),
           'SURVIVOR_CONSUMER_HELPER': str(root / 'lib/delegate-consumer-state.py'),
           'SURVIVOR_HEALTH_CMD': 'false', 'SURVIVOR_LIVE_WD_CMD': 'false',
           'SURVIVOR_RESTORE_CMD': 'printf RESTORED >"$PRIVATE_ROOT/restored"',
           'OC_V5_SELFHOST_DEPLOY_LOCK': str(volatile / 'deploy.lock')}
    survivor = (root / 'survivor.sh').read_text()
    definitions = survivor[:survivor.rindex('\ncase "${1:-}" in')]
    functions = base64.b64decode(OC206_DEPLOY_LOCK_FUNCTIONS).decode()
    phase_functions = base64.b64decode(OC206_DEPLOY_PHASE_FUNCTIONS).decode()
    script = '''set -euo pipefail
log() { :; }
die() { echo "$*" >&2; exit 1; }
SELFHOST_DEPLOY_LOCK_DIR="$1"
SELFHOST_DEPLOY_LOCK="$1/deploy.lock"
SELFHOST_DEPLOY_LOCK_WAIT=0
SELFHOST_DEPLOY_LOCK_POLL=1
''' + functions + '\nacquire_selfhost_deploy_lock\n' + definitions + '\n' + phase_functions + '''
CUTOVER_SURVIVOR_SCRIPT="$PRIVATE_ROOT/survivor.sh"
cutover_clog() { log "$@"; }
write_state "$$" "$PRIVATE_ROOT/backup" armed '2026-01-01T00:00:00Z'
printf 'ready\\n'
while read -r action; do
  rc=0
  case "$action" in
    begin) bash "$PRIVATE_ROOT/survivor.sh" --consumer-begin "$$" >"$PRIVATE_ROOT/command.log" 2>&1 || rc=$? ;;
    phase) bash "$PRIVATE_ROOT/survivor.sh" --set-phase mutated >"$PRIVATE_ROOT/command.log" 2>&1 || rc=$? ;;
    caller-phase) cutover_persist_phase symlink-flipped >"$PRIVATE_ROOT/command.log" 2>&1 || rc=$? ;;
    partial) bash "$PRIVATE_ROOT/survivor.sh" --set-phase migrated >"$PRIVATE_ROOT/command.log" 2>&1 && touch "$PRIVATE_ROOT/allowed" || rc=$? ;;
    commit) bash "$PRIVATE_ROOT/survivor.sh" --disarm >"$PRIVATE_ROOT/command.log" 2>&1 || rc=$? ;;
    finish) exit 0 ;;
  esac
  printf 'rc=%s\\n' "$rc"
done
'''
    child = subprocess.Popen(['/bin/bash', '-c', script, 'private-deploy', str(volatile)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env)
    assert line() == 'ready'
    assert action('begin') == 'rc=0', 'original holder must durably enroll its armed transition'
    first = snapshot()
    assert first['consumer_phase'] == 'quiescing' and int(first['executor_pid']) == child.pid
    assert json.loads(first['consumer_owner'])['pid'] == child.pid
    assert len(first['consumer_epoch']) == 32 and (durable.stat().st_mode & 0o777) == 0o600
    out['cases'].append('original-FD8-enrollment')
    assert action('phase') == 'rc=0', 'original --set-phase must preserve and persist consumer fields'
    second = snapshot()
    assert second['phase'] == 'mutated' and second['consumer_revision'] == '1'
    for key in ('consumer_owner', 'consumer_epoch', 'consumer_phase', 'armed_at', 'backup_dir'):
        assert second[key] == first[key], 'original four-field rewrite lost consumer authority'
    out['cases'].append('original-phase-preserves-binding')
    assert action('begin') != 'rc=0' and snapshot() == second
    out['cases'].append('re-enrollment-refused')
    unowned = run('--set-phase', 'restarted')
    assert unowned.returncode != 0 and snapshot() == second, 'PID argument is not inherited lock ownership'
    out['cases'].append('unowned-writer-refused')
    assert action('commit') != 'rc=0' and not (volatile / 'committed').exists()
    assert not (root / 'unexpected-systemd').exists()
    out['cases'].append('no-unverified-commit')
    legacy.unlink()
    assert action('caller-phase') == 'rc=0'
    assert snapshot()['phase'] == 'symlink-flipped', 'original cutover caller must not skip persistent phase when /run is absent'
    assert legacy.is_file() and snapshot()['consumer_revision'] == '2'
    out['cases'].append('original-cutover-caller-after-volatile-loss')
    # A durable update may succeed while the old volatile projection fails.
    # It must still return failure BEFORE its caller can authorize mutation.
    legacy.unlink(); legacy.mkdir()
    assert action('partial') != 'rc=0' and not (root / 'allowed').exists()
    assert snapshot()['phase'] == 'migrated' and snapshot()['consumer_revision'] == '3', 'durable migrated phase must survive failed legacy projection'
    out['cases'].append('projection-fault-fails-caller')
    child.kill(); child.wait(timeout=5)
    legacy.rmdir()
    # Fresh executable after real SIGKILL and loss of the volatile state.
    r = run('--read-phase')
    assert r.returncode == 0 and r.stdout.strip() == 'migrated', 'volatile loss must not erase persisted phase'
    out['cases'].append('fresh-process-after-SIGKILL-and-volatile-loss')
    (volatile / 'committed').write_text('committed_at=stale\n')
    assert run('--recover').returncode != 0 and not (root / 'restored').exists()
    out['cases'].append('stale-marker-cannot-restore')
    # A replacement process retaining the numeric PID cannot mutate the dead
    # holder's transition; there is no live inherited FLOCK in this new CLI.
    before = durable.read_bytes()
    assert run('--set-phase', 'restarted').returncode != 0 and durable.read_bytes() == before
    out['cases'].append('dead-holder-write-refused')
    legacy.write_text('phase=committed\nexecutor_pid=123\nbackup_dir=/private\narmed_at=stale\n')
    durable.write_bytes(before + b'phase=committed\n')
    assert run('--read-phase').returncode != 0 and run('--recover').returncode != 0
    assert not (root / 'restored').exists(), 'corrupt durable state cannot fall back to a green /run snapshot'
    durable.write_bytes(before)
    out['cases'].append('corrupt-durable-no-volatile-fallback')
    saved = root / 'saved.state'; durable.rename(saved); durable.symlink_to(saved)
    assert run('--read-phase').returncode != 0 and run('--recover').returncode != 0
    assert not (root / 'restored').exists()
    durable.unlink(); saved.rename(durable)
    out['cases'].append('symlink-durable-refused')
    assert not list(root.glob('.*.tmp.*')) and not (root / 'unexpected-systemd').exists()
except BaseException as exc:
    error = type(exc).__name__ + ': ' + str(exc)
    out['failure'] = error
    if (root / 'command.log').exists():
        out['lastCommand'] = (root / 'command.log').read_text()[-2000:]
finally:
    try:
        if child is not None:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            for pipe in (child.stdin, child.stdout, child.stderr):
                pipe.close()
        shutil.rmtree(root)
        shutil.rmtree(volatile)
        out['cleanupComplete'] = not root.exists() and not volatile.exists() and (child is None or child.returncode is not None)
    except BaseException as exc:
        out['cleanupFailure'] = type(exc).__name__
print(json.dumps(out))
raise SystemExit(0 if error is None and len(out['cases']) == 12 and out['cleanupComplete'] else 1)
