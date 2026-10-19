#!/usr/bin/env python3
"""Commercial adapter data/observations. No shell, SQL, credentials or runtime writes."""
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.request

spec = importlib.util.spec_from_file_location('release_policy', Path(__file__).with_name('v5-release-policy.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
ROOT = Path(os.environ.get('CP_ROOT', '/var/lib/openclaude-v5/release-policy'))
ACTIVE = ROOT / 'active.json'
MARKER = Path(os.environ.get('CP_RECOVERY_MARKER', '/opt/openclaude/openclaude-v5-releases/.manual-recovery-required'))

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def context():
    try:
        raw = json.loads(ACTIVE.read_text())
        operation = raw['operationId']
        c = p.load(ACTIVE, operation)
    except FileNotFoundError:
        marker = json.loads(MARKER.read_text())
        p.require(marker.get('policy') == p.POLICY, 'no exact policy recovery marker')
        operation = marker['operationId']
        c = p.load(ACTIVE.with_name(ACTIVE.name + '.resolved.' + operation + '.json'), operation)
        o = c['observations']
        p.require(c['phase'] == 'resolved' and c['resolution'] == 'forward' and o.get('allRequiredPassed') is True
                  and o.get('lineageCoherent') is True and o.get('verifiedDirection') == 'target'
                  and o.get('verifiedStackSha256') == p.stack_digest(c['target']), 'archive is not exact forward acceptance')
    d = descriptor(operation)
    p.require(c['edition'] == 'commercial' and d['operationId'] == operation, 'wrong commercial operation')
    for key in ['candidateSha', 'owner', 'before', 'target', 'history']:
        p.require(c[key] == d[key], 'descriptor differs from context: ' + key)
    return c, d

def descriptor(operation):
    p.ident(operation, 'operation')
    filename = ROOT / (operation + '.json')
    p.check_parent(filename)
    info = filename.lstat()
    p.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0, 'unsafe descriptor')
    d = json.loads(filename.read_text())
    p.require(set(d) == {'schema', 'operationId', 'candidateSha', 'owner', 'before', 'target', 'history', 'options'}, 'descriptor keys differ')
    body = {key: value for key, value in d.items() if key != 'operationId'}
    p.require(operation == 'c-' + hashlib.sha256(canonical(body)).hexdigest(), 'descriptor digest differs')
    p.require(set(d['options']) == {'withDist', 'restartEgress', 'egressBefore', 'egressTargetSlot', 'queueId', 'bundleDigest', 'authority'}, 'invalid options')
    p.require(all(type(d['options'][key]) is bool for key in ['withDist', 'restartEgress']), 'invalid boolean options')
    p.require(re.fullmatch(r'[0-9a-f]{64}', d['options']['bundleDigest'] or ''), 'invalid code bundle digest')
    p.require(d['options']['egressTargetSlot'] in ['', 'A', 'B'], 'invalid egress target slot')
    p.ident(d['options']['queueId'], 'queue id')
    return d

def values(filename):
    result = {key: None for key in p.TUPLE_KEYS}
    for line in Path(filename).read_text().splitlines():
        match = re.fullmatch(r'\s*(OC_RUNTIME_IMAGE|OC_RUNTIME_IMAGE_ID|OC_RUNTIME_RELEASE|OC_PLATFORM_BUNDLE)=(.*)', line)
        if match:
            result[match[1]] = match[2]
    return result

def current(root):
    q = Path(root) / 'current'
    if q.is_symlink():
        return os.readlink(q)
    p.require(not q.exists(), 'current is not a symlink')
    return ''

def stack(master, env, root, slot, port):
    q = Path(master).resolve(strict=True)
    raw = (q / '.complete').read_bytes()
    return dict(masterRelease=str(q), currentTarget=current(root), tuple=values(env),
                sourceCommit=json.loads(raw)['sourceCommit'], sourceDigest=hashlib.sha256(raw).hexdigest(),
                slot=slot, port=int(port))

def unit_info(unit):
    raw = subprocess.check_output(['systemctl', 'show', unit, '-p', 'ActiveState,MainPID', '--value'], text=True).splitlines()
    p.require(len(raw) == 2, 'invalid unit observation')
    state, pid = raw
    if state.isdigit():
        pid, state = state, pid
    cwd = ''
    if pid.isdigit() and int(pid) > 0:
        cwd = str((Path('/proc') / pid / 'cwd').resolve(strict=True))
    return state, pid, cwd

def health(port):
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:' + str(port) + '/healthz', timeout=4) as response:
            body = json.load(response)
        return body.get('ok') is True and body.get('channel') == 'v5' and body.get('sessionsDb') == 'ok'
    except (OSError, ValueError):
        return False

class FenceError(p.PolicyError):
    pass

def assert_owner():
    lock = Path(os.environ['CP_LOCK'])
    meta = json.loads(Path(str(lock) + '.meta').read_text())
    p.require(meta['deploy_id'] == os.environ['CP_DEPLOY_ID'] and time.time() < meta['started_at'] + meta['ttl'], 'lease fencing differs/expired')
    pid = int(meta['remote_pid'])
    raw = Path('/proc', str(pid), 'stat').read_text()
    p.require(raw[raw.rfind(')') + 2:].split()[0] not in ['Z', 'T', 't'], 'holder is not running')
    fd = Path('/proc', str(pid), 'fd/9')
    a, b = fd.stat(), lock.stat()
    p.require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), 'holder lock inode differs')
    p.require(re.search(r'^lock:\s+.*\bFLOCK\s+ADVISORY\s+WRITE\s+', Path('/proc', str(pid), 'fdinfo/9').read_text(), re.M), 'holder has no flock')
    p.require(Path(str(lock) + '.admission-nonce').read_text().strip() == os.environ['CP_ADMISSION'], 'admission nonce differs')
    marker = json.loads(Path(os.environ['CP_LANE_MARKER']).read_text())
    p.require(marker['nonce'] == os.environ['CP_LANE_NONCE'], 'lane nonce differs')
    again = json.loads(Path(str(lock) + '.meta').read_text())
    p.require(again == meta, 'holder changed during observation')

def owner():
    try:
        assert_owner()
    except (OSError, ValueError, KeyError, TypeError, p.PolicyError) as error:
        raise FenceError(str(error)) from error

def verify(c, direction, env, root, live, unit):
    wanted = c[direction]
    actual = stack(live, env, root, wanted['slot'], wanted['port'])
    p.require(actual == wanted, 'live stack differs from ' + direction)
    one = unit_info(unit)
    p.require(one[0] == 'active' and one[2] == wanted['masterRelease'] and health(wanted['port']), 'master is not usable exact source')
    p.require(unit_info(unit) == one and stack(live, env, root, wanted['slot'], wanted['port']) == actual, 'stack/process generation changed')
    return p.stack_digest(actual)


def clear_marker(operation):
    info = MARKER.lstat()
    p.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, 'unsafe recovery marker')
    marker = json.loads(MARKER.read_text())
    p.require(marker == {'policy': p.POLICY, 'operationId': operation}, 'recovery marker belongs to another operation')
    owner()
    MARKER.unlink()
    p.sync_directory(MARKER.parent)

def main(action, a):
    if action == 'owner':
        owner()
        return
    if action == 'present':
        try:
            ACTIVE.lstat()
        except FileNotFoundError:
            return
        raise p.PolicyError('unresolved commercial policy context')
    if action == 'prepare':
        config, snap, old_current, env, root, hist, image, iid, runtime, bundle, master, previous, kind = a
        options = json.loads(config)
        owner()
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        before = stack(previous, env, root, options['slot'], options['port'])
        target = stack(master, env, root, options['slot'], options['port'])
        captured = {}
        for line in Path(snap).read_text().splitlines():
            key, value = line.split('=', 1)
            captured[key] = None if value == '<UNSET>' else value
        p.require(before['tuple'] == captured and before['currentTarget'] == old_current, 'predecessor differs from saga')
        target['tuple'] = dict(zip(['OC_RUNTIME_IMAGE', 'OC_RUNTIME_IMAGE_ID', 'OC_RUNTIME_RELEASE', 'OC_PLATFORM_BUNDLE'], [image, iid, runtime, bundle]))
        if bundle:
            target['currentTarget'] = 'bundles/' + Path(bundle).name
        p.require(target['sourceCommit'] == options.pop('sha'), 'candidate SHA differs')
        options.pop('slot'); options.pop('port')
        d = dict(schema=1, candidateSha=target['sourceCommit'], owner=dict(deploymentId=os.environ['CP_DEPLOY_ID'], nonce=os.environ['CP_LANE_NONCE']),
                 before=before, target=target, history=dict(path=hist, predecessorSha256=hashlib.sha256(Path(hist).read_bytes()).hexdigest(), transitionKind=kind), options=options)
        operation = 'c-' + hashlib.sha256(canonical(d)).hexdigest()
        d['operationId'] = operation
        p.atomic_write(ROOT / (operation + '.json'), d, create=True)
        owner()
        p.prepare(ACTIVE, {key: d[key] for key in ['operationId', 'candidateSha', 'owner', 'before', 'target', 'history']} | {'edition': 'commercial'})
        context()
        owner()
        p.atomic_write(MARKER, {'policy': p.POLICY, 'operationId': operation}, create=True)
        return
    c, d = context()
    operation = c['operationId']
    if action == 'archived':
        print('true' if c['phase'] == 'resolved' else 'false')
        return
    if action == 'field':
        value = d
        for key in a[0].split('.'):
            value = value[key]
        print(json.dumps(value, separators=(',', ':')) if isinstance(value, (dict, list, bool)) or value is None else value)
        return
    owner()
    if action == 'arm':
        owner()
        p.checkpoint(ACTIVE, operation, dict(phase='exposure-armed', mayHaveServed=True))
    elif action == 'failure':
        stage, authority, env, root, live, unit = a
        identity, service = 'unknown', 'unknown'
        try:
            actual = stack(live, env, root, c['target']['slot'], c['target']['port'])
            if actual == c['target']:
                identity = 'exact'
            observed = unit_info(unit)
            if observed[0] == 'active' and observed[2] == c['target']['masterRelease'] and health(c['target']['port']):
                service = 'usable'
        except (OSError, ValueError, KeyError, subprocess.SubprocessError, p.PolicyError):
            pass
        # Only direct, candidate-bound local unavailability authorizes automatic rollback.
        facts = dict(ownerHeld=True, identity=identity, service=service, authority=authority)
        if identity == 'exact':
            state = unit_info(unit)[0]
            try:
                with socket.create_connection(('127.0.0.1', c['target']['port']), timeout=3):
                    pass
            except OSError as error:
                if state == 'failed' and error.errno == errno.ECONNREFUSED:
                    facts.update(service='unavailable', impact=dict(kind='local-service-unavailable', candidateSha=c['candidateSha'], masterRelease=c['target']['masterRelease'], unitState='failed', loopbackError='ECONNREFUSED', port=c['target']['port']))
        owner()
        decision = p.decide(c, facts)
        try:
            if decision != 'PREPARATION_ABORT':
                p.checkpoint(ACTIVE, operation, dict(phase='held', failure=dict(stage=stage, decision=decision)))
        except (OSError, p.PolicyError):
            decision = 'HOLD_UNKNOWN'
        print(decision)
    elif action == 'verify':
        direction, env, root, live, unit = a
        print(verify(c, direction, env, root, live, unit))
    elif action == 'resolve':
        direction, authority, env, root, live, unit = a
        digest = verify(c, direction, env, root, live, unit)
        owner()
        p.checkpoint(ACTIVE, operation, dict(phase='repairing', observations=dict(identity='exact', service='usable', authority=authority,
                     allRequiredPassed=True, lineageCoherent=True, verifiedDirection=direction, verifiedStackSha256=digest)))
        owner()
        p.resolve(ACTIVE, operation, 'forward' if direction == 'target' else 'compensated')
        clear_marker(operation)
    elif action == 'clear-accepted-marker':
        p.require(c['phase'] == 'resolved' and c['resolution'] == 'forward', 'archive not accepted')
        verify(c, 'target', *a)
        clear_marker(operation)
    elif action == 'history-status':
        raw = Path(c['history']['path']).read_bytes()
        before = c['history']['predecessorSha256']
        if hashlib.sha256(raw).hexdigest() == before:
            print('missing')
        else:
            lines = raw.splitlines(keepends=True)
            p.require(lines and hashlib.sha256(b''.join(lines[:-1])).hexdigest() == before, 'history prefix advanced or differs')
            last = json.loads(lines[-1]); t = c['target']; v = t['tuple']
            want = dict(image=v['OC_RUNTIME_IMAGE'], image_id=v['OC_RUNTIME_IMAGE_ID'], release=v['OC_RUNTIME_RELEASE'], bundle=v['OC_PLATFORM_BUNDLE'],
                        masterRelease=t['masterRelease'], previousMasterRelease=c['before']['masterRelease'], transitionKind=c['history']['transitionKind'])
            p.require(all(last.get(k) == val for k, val in want.items()), 'history target differs')
            print('applied')
    else:
        raise p.PolicyError('unsupported commercial action')

if __name__ == '__main__':
    try:
        main(sys.argv[1], sys.argv[2:])
    except FenceError as error:
        print('commercial-release-policy: fencing lost', file=sys.stderr)
        sys.exit(86)
    except (OSError, ValueError, KeyError, TypeError, AssertionError, subprocess.SubprocessError, p.PolicyError) as error:
        print('commercial-release-policy: ' + str(error), file=sys.stderr)
        sys.exit(86 if sys.argv[1] == 'owner' else 79)
