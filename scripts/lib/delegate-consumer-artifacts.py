#!/usr/bin/env python3
"""Read-only artifact/source binding for the selfhost consumer caller.

Executes the ORIGINAL master/runtime digest verifiers, never candidate code.
Runtime MANIFEST is outside its own digest: its capabilities/sourceCommit alone
are NOT source authority. Bind them to the digest-covered flavor identity and
the exact pinned Git metadata used by the original runtime builder instead.

This proves artifact declarations, not the live image/env, complete inventory,
quiescence, bootstrap business behavior or permission to start/rollback.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import time


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


LIB = Path(__file__).resolve().parent
paths = _load('consumer_artifact_paths', LIB / 'delegate-consumer-unit-paths.py')
state = _load('consumer_artifact_state', LIB / 'delegate-consumer-state.py')
kernel = _load('consumer_artifact_kernel', LIB.parent / 'delegate-consumer-compat.py')
inventory_reader = _load('consumer_artifact_inventory', LIB / 'delegate-consumer-inventory.py')
MAX_BYTES = 1024 * 1024
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/', 'LC_ALL': 'C',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0'}


class Unknown(Exception):
    pass


def require(value):
    if not value:
        raise Unknown('unverifiable_consumer_artifact')


def _directory(path):
    fd = state._directory(path)
    try:
        st = os.fstat(fd)
        return [st.st_dev, st.st_ino, st.st_mode, st.st_uid]
    finally:
        os.close(fd)


def _run(argv, deadline, *, pass_fds=()):
    remaining = deadline - time.monotonic()
    require(0 < remaining <= 30)
    child = subprocess.Popen(argv, env=ENV, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=pass_fds)
    try:
        try:
            output, _ = child.communicate(timeout=remaining)
        except subprocess.TimeoutExpired:
            # The original digest verifier uses shell/find/xargs descendants.
            # Killing only its parent would leave private/real hashers running.
            os.killpg(child.pid, signal.SIGKILL)
            child.communicate()
            raise Unknown('consumer_artifact_budget') from None
        require(child.returncode == 0 and len(output) <= MAX_BYTES and time.monotonic() < deadline)
        return output
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        child.stdout.close()


def _json(raw):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj)
            obj[key] = value
        return obj
    value = json.loads(raw, object_pairs_hook=unique)
    require(isinstance(value, dict))
    return value


def _read(path, deadline, proofs, *, max_bytes=MAX_BYTES):
    raw, proof = paths._root_text(path, deadline, max_bytes=max_bytes)
    require(path not in proofs or proofs[path] == proof)
    proofs[path] = proof
    return raw.encode('utf-8'), _json(raw)


def _git_metadata(repository, commit, deadline):
    require(isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit))
    # The official selfhost canonical repository is a real root-owned checkout,
    # not a tenant worktree/gitfile, remote URL, replacement object or HEAD guess.
    root = _directory(repository)
    git_dir = str(Path(repository) / '.git')
    git_identity = _directory(git_dir)
    objects = _directory(str(Path(git_dir) / 'objects'))
    base = ['/usr/bin/git', '--no-optional-locks', '--git-dir=' + git_dir,
            '-c', 'core.fsmonitor=false']
    object_id = commit + ':deploy/v5/release-metadata.json'
    size = _run(base + ['cat-file', '-s', object_id], deadline).strip()
    require(size.isdigit() and 0 < int(size) <= MAX_BYTES)
    raw = _run(base + ['cat-file', 'blob', object_id], deadline)
    require(len(raw) == int(size))
    require(_directory(repository) == root and _directory(git_dir) == git_identity and
            _directory(str(Path(git_dir) / 'objects')) == objects)
    return raw, _json(raw)


def _caps(value):
    require(isinstance(value, list) and all(isinstance(v, str) for v in value))
    require(len(value) == len(set(value)))
    require(all(c == kernel.CAP for c in value if c.startswith('delegate-receipt-consumer-')))
    return sorted(value)


def _admission(source, floor):
    value = source.get('delegateConsumerAdmission')
    if floor == 1:
        require(value is None)
        return 'legacy'
    require(value in {'bootstrap-closed', 'enabled'})
    return value


def capture(master_release, runtime_release, repository, deadline):
    """Capture physically verified master/runtime declarations (different SHAs OK).

    No caller-supplied verified flag, manifest JSON, capability override or env
    source. Empty/embedded runtime is deliberately unknown here; its separate
    immutable-image adapter must supply its own proof before full caller wiring.
    """
    try:
        return _capture(master_release, runtime_release, repository, deadline)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, RecursionError,
            paths.Unknown, state.Unknown, kernel.Unknown):
        raise Unknown('unverifiable_consumer_artifact') from None


def _capture(master_release, runtime_release, repository, deadline):
    require(os.geteuid() == 0 and 0 < deadline - time.monotonic() <= 30)
    require(all(isinstance(p, str) and p for p in (master_release, runtime_release, repository)))
    master_proof = capture_master(master_release, repository, deadline)
    roots = {**master_proof['roots'], runtime_release: _directory(runtime_release)}
    proofs = {p['path']: p for p in master_proof['inputs']}
    runtime = Path(runtime_release)
    _, manifest = _read(str(runtime / 'MANIFEST.json'), deadline, proofs, max_bytes=kernel.MAX_METADATA)
    _, flavor = _read(str(runtime / 'flavor.manifest.json'), deadline, proofs)
    # Call the existing whole-artifact digest algorithms, not a new digest or a
    # statement that files matching a manifest already imply trusted capability.
    runtime_lib = str(LIB.parent / 'v5-runtime-release-lib.sh')
    flavor_lib = str(LIB / 'assert-flavor.sh')
    for lib in (runtime_lib, flavor_lib):
        _, proof = paths._root_text(lib, deadline)
        proofs[lib] = proof
    # A canonical checkout keeps the original rules in packages/commercial;
    # a stable installed helper keeps them colocated. Resolve via the ORIGINAL
    # selector, allow only these two layouts, pin the file, and recheck the
    # selection in the actual parser invocation. Never require an invented
    # colocated file that the official checkout does not contain.
    rules = _run(['/bin/bash', '-c', 'source "$1"; flavor_rules_path',
                  'consumer-flavor-rules', flavor_lib], deadline).decode()
    require(rules in {str(LIB / 'flavor-rules.json'),
                      str(LIB.parent.parent / 'packages/commercial/src/flavor/flavor-rules.json')})
    _read(rules, deadline, proofs)
    _run(['/bin/bash', '-c', '''set -euo pipefail
source "$1"
oc_hotcfg_verify_manifest_full "$2"
source "$3"
[[ "$(flavor_rules_path)" == "$4" ]]
flavor_parse_manifest "$2/flavor.manifest.json" >/dev/null
''', 'consumer-runtime-verify', runtime_lib, runtime_release, flavor_lib, rules], deadline)
    require(flavor.get('flavor') == 'selfhost' and flavor.get('builder') == 'deploy-v5-selfhost.sh')
    require(manifest.get('sourceCommit') == flavor.get('sourceCommit'))
    require(isinstance(manifest.get('digest'), str) and re.fullmatch(r'[a-f0-9]{12}', manifest['digest']))
    require(runtime.name == 'rel-' + manifest['digest'])
    _, runtime_meta = _git_metadata(repository, flavor.get('sourceCommit'), deadline)
    require(_caps(manifest.get('capabilities')) == _caps(runtime_meta.get('runtimeCapabilities')))
    # Original B0 remains the only consumer-capability parser/floor oracle.
    runtime_floor = kernel.candidate(str(runtime / 'MANIFEST.json'))
    result = {'master': master_proof['master'],
              'runtime': {'root': runtime_release, 'sourceCommit': flavor['sourceCommit'],
                          'artifact': manifest['digest'], 'consumer': runtime_floor,
                          'admission': _admission(runtime_meta, runtime_floor)},
              'inputs': list(proofs.values()), 'roots': roots}
    revalidate(result, deadline)
    return result


def capture_master(master_release, repository, deadline):
    """The same original master verifier, shared by source and baked tuples."""
    try:
        require(os.geteuid() == 0 and 0 < deadline - time.monotonic() <= 30)
        roots = {p: _directory(p) for p in (master_release, repository)}
        proofs = {}
        master = Path(master_release)
        _, marker = _read(str(master / '.complete'), deadline, proofs)
        metadata_raw, metadata = _read(str(master / 'deploy/v5/release-metadata.json'), deadline, proofs)
        lib = str(LIB.parent / 'v5-selfhost-master-release-lib.sh')
        _, proof = paths._root_text(lib, deadline); proofs[lib] = proof
        _run(['/bin/bash', '-c', '''set -euo pipefail
die() { exit 2; }
source "$1"
assert_master_release_static_gate "$2"
''', 'consumer-master-verify', lib, master_release], deadline)
        source, meta = _git_metadata(repository, marker.get('sourceCommit'), deadline)
        require(metadata_raw == source)
        require(hashlib.sha256(metadata_raw).hexdigest() == marker.get('metadataSha256'))
        require(_caps(metadata.get('capabilities')) == _caps(meta.get('capabilities')))
        floor = kernel.candidate(str(master / 'deploy/v5/release-metadata.json'))
        result = {'master': {'root': master_release, 'sourceCommit': marker['sourceCommit'],
                             'artifact': marker['artifactSha256'], 'consumer': floor,
                             'admission': _admission(meta, floor)},
                  'inputs': list(proofs.values()), 'roots': roots}
        revalidate(result, deadline)
        return result
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, paths.Unknown, state.Unknown, kernel.Unknown):
        raise Unknown('unverifiable_consumer_master') from None


def capture_embedded(master_release, image_id, repository, deadline):
    master = capture_master(master_release, repository, deadline)
    runtime = capture_image_runtime(image_id, repository, deadline)
    result = {**runtime, 'master': master['master'],
              'roots': {**master['roots'], **runtime['roots']},
              'inputs': master['inputs'] + runtime['inputs']}
    revalidate(result, deadline)
    return result


def _runtime_image_snapshot(image_id, deadline):
    require(isinstance(image_id, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image_id))
    raw = _run(['/usr/bin/docker', '--host=unix:///var/run/docker.sock', 'image', 'inspect', image_id], deadline)
    images = json.loads(raw)
    require(isinstance(images, list) and len(images) == 1 and isinstance(images[0], dict))
    image = images[0]
    require(image.get('Id') == image_id and isinstance(image.get('Config'), dict))
    labels = image['Config'].get('Labels')
    require(isinstance(labels, dict))
    keys = ('oc.runtime.embed_source', 'oc.runtime.source_commit', 'oc.runtime.features')
    require(all(isinstance(labels.get(key), str) for key in keys))
    return {'id': image_id, 'labels': {key: labels[key] for key in keys}}


def capture_image_runtime(image_id, repository, deadline):
    """Original baked-image labels + exact Git source, never mutable tags.

    Only explicit embed_source=1 can certify baked source. Toolchain labels are
    not source authority. Feature tokens and the original source metadata must
    agree on the B0 consumer capability; modern admission also comes from that
    source. This proves declarations, not that a synthetic build ran its code.
    """
    try:
        require(os.geteuid() == 0 and 0 < deadline - time.monotonic() <= 30)
        roots = {p: _directory(p) for p in (repository, str(Path(repository) / '.git'),
                                           str(Path(repository) / '.git/objects'))}
        image = _runtime_image_snapshot(image_id, deadline)
        labels = image['labels']
        require(labels['oc.runtime.embed_source'] == '1')
        source = labels['oc.runtime.source_commit']
        _, metadata = _git_metadata(repository, source, deadline)
        features = labels['oc.runtime.features'].split()
        declared = _caps(metadata.get('runtimeCapabilities'))
        floor = kernel.candidate_object({'capabilities': features})
        require(floor == kernel.candidate_object({'capabilities': declared}))
        require({v for v in features if v.startswith('delegate-receipt-consumer-')} ==
                {v for v in declared if v.startswith('delegate-receipt-consumer-')})
        result = {'runtime': {'root': None, 'imageId': image_id, 'sourceCommit': source,
                              'artifact': image_id, 'consumer': floor,
                              'admission': _admission(metadata, floor)},
                  'inputs': [], 'roots': roots, 'image': image}
        revalidate(result, deadline)
        return result
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, paths.Unknown, state.Unknown, kernel.Unknown):
        raise Unknown('unverifiable_embedded_consumer_source') from None


def revalidate(proof, deadline):
    require(time.monotonic() < deadline)
    for path, identity in proof['roots'].items():
        require(_directory(path) == identity)
    for value in proof['inputs']:
        root = proof.get('runtime', {}).get('root')
        limit = kernel.MAX_METADATA if root and value['path'] == str(Path(root) / 'MANIFEST.json') else MAX_BYTES
        require(paths._root_identity(value['path'], max_bytes=limit) == value)
    if 'image' in proof:
        require(_runtime_image_snapshot(proof['image']['id'], deadline) == proof['image'])
    require(time.monotonic() < deadline)


def classify_transition(current, candidate, fallback, inventory, deadline, *, writers=()):
    """Classify trusted in-process captures using the original B0 DB reader.

    A compatible_snapshot is NOT permission: if legacy is involved the real
    caller must quiesce writers/provision and retake this inventory. Paired-v2
    still needs the original mutation lock, immutable tuple and start guard.
    Never deserialize caller/body JSON as any of these trusted capture objects.
    """
    try:
        require(0 < deadline - time.monotonic() <= 30)
        pairs = (current, candidate, fallback)
        for proof in pairs:
            revalidate(proof, deadline)
        require(len(writers) == len(inventory['writers']))
        for proof in writers:
            revalidate(proof, deadline)
        inventory_reader.revalidate(inventory)
        databases = inventory['databases']
        require(0 < len(databases) <= kernel.MAX_DATABASES)
        snapshots = [kernel.inventory(db['path'], deadline) for db in databases]
        required = max(value['required'] for value in snapshots)
        floors = []
        for proof in pairs:
            master, runtime = proof['master'], proof['runtime']
            if master['consumer'] != runtime['consumer']:
                return {'status': 'incompatible', 'reason': 'unpaired_consumer'}
            floors.append(master['consumer'])
        # The moment an enabled current/candidate can serve, a later empty DB
        # snapshot cannot make its legacy fallback safe (first-write race).
        may_seal = any(side['admission'] == 'enabled'
                       for proof in (current, candidate) for side in (proof['master'], proof['runtime']))
        may_seal = may_seal or any(proof['runtime']['admission'] == 'enabled' for proof in writers)
        if may_seal:
            required = max(required, 2)
        for proof in pairs:
            revalidate(proof, deadline)
        for proof in writers:
            revalidate(proof, deadline)
        inventory_reader.revalidate(inventory)
        require(time.monotonic() < deadline)
        if floors[1] < required or floors[2] < required:
            return {'status': 'incompatible', 'reason': 'consumer_floor', 'required': required}
        return {'status': 'compatible_snapshot', 'required': required,
                'requiresQuiescence': 1 in floors or any(p['runtime']['consumer'] == 1 for p in writers),
                'databaseCount': len(snapshots)}
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, paths.Unknown, state.Unknown,
            kernel.Unknown, inventory_reader.Unknown):
        raise Unknown('unverifiable_consumer_transition_snapshot') from None
