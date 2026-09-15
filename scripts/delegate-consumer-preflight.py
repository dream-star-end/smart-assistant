#!/usr/bin/env python3
"""Original cutover's initial read-only rejection gate, NOT a start permit.

Bind the loaded master, exact selected candidate and still-current fallback to
root-owned unit/env, original artifact verifiers, immutable local Docker image
and the full original inventory/B0 oracle. The snapshot must be taken AGAIN
under the real writer barrier by the later authorization stage.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys
import time

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('preflight_artifacts', ROOT / 'lib/delegate-consumer-artifacts.py')
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)
paths = artifacts.paths
inventory = artifacts.inventory_reader
cgroups = artifacts._load('consumer_quiesce_cgroups', ROOT / 'lib/delegate-consumer-cgroup.py')
MASTER = 'openclaude-v5-selfhost.service'
LIVE = '/opt/openclaude/openclaude-v5-selfhost-live'
RELEASES = '/opt/openclaude/openclaude-v5-selfhost-releases'
REPOSITORY = '/opt/openclaude/openclaude-v5-selfhost'


class Unknown(Exception):
    pass


def require(value):
    if not value:
        raise Unknown('unverifiable_consumer_preflight')


def link_snapshot(link):
    # Only the exact original selector may be a symlink. Every ancestor and
    # selected physical release is still checked by the pinned root reader.
    artifacts._directory(str(Path(link).parent))
    info = os.lstat(link)
    require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0)
    target = os.readlink(link)
    require(Path(target).is_absolute())
    physical = str(paths.path(target))
    return {'path': link, 'target': physical, 'identity': paths._file_identity(info)}


def tuple_values(env):
    require(isinstance(env, dict) and set(env) == paths.TUPLE_KEYS)
    image, image_id = env['OC_RUNTIME_IMAGE'], env['OC_RUNTIME_IMAGE_ID']
    require(isinstance(image, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@-]{0,255}', image))
    require(isinstance(image_id, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id))
    runtime, bundle = env['OC_RUNTIME_RELEASE'], env['OC_PLATFORM_BUNDLE']
    # Embedded image source needs its own immutable source/metadata adapter.
    # It is UNKNOWN here, never "legacy" or a guessed release directory.
    require(isinstance(runtime, str) and runtime)
    paths.path(runtime)
    require(isinstance(bundle, str))
    if bundle:
        paths.path(bundle)
    return dict(env)


def image_snapshot(values, deadline):
    # Explicit local daemon; ambient DOCKER_HOST/context/config cannot redirect.
    raw = artifacts._run(['/usr/bin/docker', '--host=unix:///var/run/docker.sock',
                          'image', 'inspect', '--format', '{{.Id}}',
                          values['OC_RUNTIME_IMAGE']], deadline)
    require(raw.decode().strip() == values['OC_RUNTIME_IMAGE_ID'])
    return values['OC_RUNTIME_IMAGE_ID']


def runtime_snapshot(unit, projection, master, deadline):
    """Loaded config is not proof that a running supervisor ate that config.

    Read only the exact PID supplied by the local system manager. Pin its proc
    directory and start time/cgroup; retain only non-secret projection values.
    MainPID=0 is an inactive CONFIG snapshot, explicitly not subtree emptiness.
    """
    keys = {'MainPID', 'ControlGroup', 'ActiveState', 'SubState', 'InvocationID'}
    def show():
        raw = artifacts._run(['/usr/bin/systemctl', '--system', 'show', '--no-pager',
                              '--property=' + ','.join(sorted(keys)), '--', unit], deadline)
        result = {}
        for line in raw.decode().splitlines():
            key, sep, value = line.partition('=')
            require(sep and key in keys and key not in result)
            result[key] = value
        require(set(result) == keys and result['MainPID'].isdigit())
        return result
    before = show()
    pid = int(before['MainPID'])
    if not pid:
        require(before['ActiveState'] in {'inactive', 'failed'} and before['SubState'] in {'dead', 'failed'})
        require(show() == before)
        return {'properties': before, 'process': None, 'quiescenceProven': False}
    require(before['ActiveState'] == 'active' and before['SubState'] == 'running')
    require(re.fullmatch(r'[a-f0-9]{32}', before['InvocationID']))
    cgroup = str(paths.path(before['ControlGroup']))
    require(cgroup != '/')
    fd = os.open('/proc/' + str(pid), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(info.st_uid == 0)
        def read(name):
            require(time.monotonic() < deadline)
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            try:
                data = bytearray()
                while True:
                    chunk = os.read(file, min(65536, paths.MAX_TEXT + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                    require(len(data) <= paths.MAX_TEXT and time.monotonic() < deadline)
                return bytes(data)
            finally:
                os.close(file)
        def identity():
            raw = read('stat').decode()
            fields = raw[raw.rfind(')') + 2:].split()
            require(len(fields) >= 20 and fields[0] not in {'Z', 'X'})
            group = read('cgroup').decode().splitlines()
            require(group == ['0::' + cgroup])
            require(os.readlink('cwd', dir_fd=fd) == master)
            return [info.st_dev, info.st_ino, fields[19], cgroup, master]
        process = identity()
        selected = {}
        raw_env = read('environ')
        require(raw_env.endswith(b'\0'))
        for entry in raw_env[:-1].split(b'\0'):
            key, sep, value = entry.partition(b'=')
            require(sep)
            # Do not decode or retain ignored credentials at all.
            if key in {k.encode() for k in paths.PROJECTED_KEYS}:
                key = key.decode(); require(key not in selected)
                selected[key] = value.decode()
        require({k: v for k, v in selected.items() if k in paths.TUPLE_KEYS} == projection['runtimeEnvironment'])
        actual = paths.resolve_unit_paths({'environment': selected, 'environmentFiles': [],
            'workingDirectory': master, 'argv': projection['argv']}, {}, pwd.getpwnam('root').pw_dir)
        require(actual['database'] == projection['database'])
        require(identity() == process and show() == before)
        require(os.stat('/proc/' + str(pid)).st_ino == info.st_ino)
        return {'properties': before, 'process': process, 'quiescenceProven': False}
    finally:
        os.close(fd)


def capture_context(unit, master, values, repository, deadline):
    require(unit['projection']['runtimeEnvironment'] == values)
    code = artifacts.capture(master, values['OC_RUNTIME_RELEASE'], repository, deadline)
    image = image_snapshot(values, deadline)
    return {'unit': unit, 'tuple': values, 'image': image, 'code': code}


def revalidate_context(context, deadline):
    for proof in context['unit']['inputs']:
        require(paths._root_identity(proof['path'], optional=proof['file'] is None) == proof)
    artifacts.revalidate(context['code'], deadline)
    require(image_snapshot(context['tuple'], deadline) == context['image'])


def capture_transition(candidate_master, candidate_runtime, candidate_image, candidate_image_id,
            candidate_bundle, deadline, *, repository=REPOSITORY, live=LIVE,
            releases=RELEASES, unit_name=MASTER):
    """Internal explicit-path adapter permits private tests, not CLI overrides.

    Candidate tuple values come only from the ORIGINAL root deploy builder.
    An empty candidate_runtime selects master-only and preserves the complete
    effective tuple; an empty bundle in a joint selection means original saga
    unchanged, not a guessed ambient value. No allowance/state write occurs.
    """
    require(os.geteuid() == 0 and 0 < deadline - time.monotonic() <= 30)
    selector = link_snapshot(live)
    current_master = selector['target']
    for master in (current_master, candidate_master):
        require(Path(master).parent == Path(releases) and Path(master).name.startswith('rel-'))
    # Production is exact allowlist; private fixture uses the same actual
    # systemctl implementation through its internal private-unit entrypoint.
    loaded = paths._capture_effective_unit(unit_name, deadline)
    require(loaded['projection']['workingDirectory'] == live)
    running = runtime_snapshot(unit_name, loaded['projection'], current_master, deadline)
    current_values = tuple_values(loaded['projection']['runtimeEnvironment'])
    current = capture_context(loaded, current_master, current_values, repository, deadline)
    template = str(Path(candidate_master) / 'deploy/v5-selfhost' / MASTER)
    # Installing the candidate main fragment does not delete existing drop-ins.
    # Include the same effective suffix, including path/DB overrides, rather
    # than accidentally proving a bare template the service will never use.
    proposed = paths.capture_root_files([template, *loaded['fragments'][1:]], deadline)
    require(proposed['projection']['workingDirectory'] == live)
    # Candidate may not silently replace the environment source or its tuple.
    # New unit path overrides ARE included as separate inventory paths.
    require(proposed['projection']['runtimeEnvironment'] == current_values)
    proposed_values = dict(current_values)
    if candidate_runtime:
        proposed_values.update(OC_RUNTIME_RELEASE=candidate_runtime,
                               OC_RUNTIME_IMAGE=candidate_image,
                               OC_RUNTIME_IMAGE_ID=candidate_image_id)
        if candidate_bundle:
            proposed_values['OC_PLATFORM_BUNDLE'] = candidate_bundle
    else:
        require(not candidate_image and not candidate_image_id and not candidate_bundle)
    proposed_values = tuple_values(proposed_values)
    # Preserve root-input identities while applying precisely the original
    # upcoming saga tuple, not a runtime/body-provided environment replacement.
    proposed['projection'] = {**proposed['projection'], 'runtimeEnvironment': proposed_values}
    candidate = capture_context(proposed, candidate_master, proposed_values, repository, deadline)
    inv = inventory.capture_local([loaded['projection']['database'], proposed['projection']['database']], deadline)
    decision = artifacts.classify_transition(current['code'], candidate['code'], current['code'], inv, deadline)
    revalidate_context(current, deadline)
    revalidate_context(candidate, deadline)
    require(paths._show_effective(unit_name, deadline)['plan'] == loaded['unitPlan'])
    require(runtime_snapshot(unit_name, loaded['projection'], current_master, deadline) == running)
    require(link_snapshot(live) == selector)
    inventory.revalidate(inv)
    require(time.monotonic() < deadline)
    return {'decision': decision, 'current': current, 'candidate': candidate,
            'inventory': inv, 'selector': selector, 'running': running}


def initial(*args, **kwargs):
    return capture_transition(*args, **kwargs)['decision']


def quiesce_master(snapshot, state_path, owner, deadline):
    """Stop the original provisioning master and prove its held cgroup dead.

    This is ONE stage, not all-volume writer quiescence or start permission.
    No container is started or removed. Unknown/inactive-without-live-pin must
    use the later trusted recovery path, not treat a missing cgroup as empty.
    """
    unit = snapshot['current']['unit']['unit']
    running = snapshot['running']
    require(running['process'] is not None)
    record = artifacts.state.read(state_path)
    require(record['consumer_phase'] == 'quiescing' and int(record['executor_pid']) == owner['pid'])
    artifacts.state._owner(owner)
    current = snapshot['current']
    require(runtime_snapshot(unit, current['unit']['projection'], current['code']['master']['root'], deadline) == running)
    with cgroups.PinnedCgroup(running['properties']['ControlGroup']) as held:
        artifacts.state._owner(owner)
        artifacts._run(['/usr/bin/systemctl', '--system', 'stop', '--', unit], deadline)
        artifacts.state._owner(owner)
        stopped = runtime_snapshot(unit, current['unit']['projection'], current['code']['master']['root'], deadline)
        require(stopped['process'] is None)
        proof = held.verify_stopped()
        artifacts.state._owner(owner)
        artifacts.state.update_phase(state_path, 'consumer-master-stopped')
        return proof


def enroll(args, state_path, legacy, lock_path, pid, *, quiesce=False, **private):
    """Original FD8 holder enrolls selected immutable intent before mutation.

    Still quiescing: no start authorization, command execution or compensation
    permission is granted here. Never accept a serialized snapshot from CLI.
    """
    owner = artifacts.state.lock.capture_holder(lock_path, pid, 8)
    artifacts.state._owner(owner)
    snapshot = capture_transition(*args, **private)
    if snapshot['decision']['status'] != 'compatible_snapshot':
        return snapshot['decision']
    def identity(context):
        p = context['unit']['projection']
        return {'master': context['code']['master'], 'runtime': context['code']['runtime'],
                'tuple': context['tuple'], 'database': p['database'],
                'unit': {k: p[k] for k in ('workingDirectory', 'argv', 'pathEnvironment')}}
    descriptor = {'current': identity(snapshot['current']), 'candidate': identity(snapshot['candidate']),
                  'required': snapshot['decision']['required']}
    intent = {'schema': 1, 'descriptor': descriptor,
              'sha256': hashlib.sha256(json.dumps(descriptor, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    artifacts.state._owner(owner)
    result = artifacts.state.begin(state_path, legacy, lock_path, pid, intent=intent)
    if quiesce:
        try:
            quiesce_master(snapshot, state_path, owner, time.monotonic() + 20)
        except (Unknown, artifacts.Unknown, artifacts.state.Unknown, artifacts.state.lock.Unknown,
                cgroups.Unknown, OSError, ValueError, TypeError, KeyError):
            # The service may have stopped even if systemctl timed out. Keep
            # the durable uncertainty; do not restore/start an unchecked target.
            artifacts.state.mark_manual(state_path)
            raise
    return {'status': 'enrolled_quiescing', 'epoch': result['consumer_epoch'], 'intent': intent['sha256']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-master', required=True)
    parser.add_argument('--candidate-runtime', default='')
    parser.add_argument('--candidate-image', default='')
    parser.add_argument('--candidate-image-id', default='')
    parser.add_argument('--candidate-bundle', default='')
    parser.add_argument('--enroll', action='store_true')
    parser.add_argument('--quiesce-master', action='store_true')
    parser.add_argument('--state')
    parser.add_argument('--legacy')
    parser.add_argument('--lock')
    parser.add_argument('--holder-pid', type=int)
    args = parser.parse_args()
    try:
        selected = (args.candidate_master, args.candidate_runtime, args.candidate_image,
                    args.candidate_image_id, args.candidate_bundle, time.monotonic() + 15)
        if args.enroll:
            require(args.state and args.legacy and args.lock and args.holder_pid)
            result = enroll(selected, args.state, args.legacy, args.lock, args.holder_pid, quiesce=args.quiesce_master)
        else:
            require(not any((args.state, args.legacy, args.lock, args.holder_pid, args.quiesce_master)))
            result = initial(*selected)
        # Only bounded verdict/counters leave this process, not env or paths.
        print(json.dumps(result))
        return 0 if result['status'] in {'compatible_snapshot', 'enrolled_quiescing'} else 1
    except (Unknown, artifacts.Unknown, paths.Unknown, inventory.Unknown,
            artifacts.state.Unknown, artifacts.state.lock.Unknown, artifacts.kernel.Unknown, cgroups.Unknown, OSError, ValueError,
            TypeError, KeyError, UnicodeError):
        print('consumer preflight unknown; no stop/install/flip permission', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
