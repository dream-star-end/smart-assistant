"""Root/private Git + original artifact builders/verifiers, no product boot.

Harness prepends exact OC206_ARTIFACT_FILES. Synthetic source commits declare
capabilities only to exercise provenance/format validation: they do NOT prove
that an actual gateway binary is bootstrap-closed or authorize any deployment.
No deps copied/installed, Docker, systemd or production data; fixture node_modules
contains only an empty tsx directory required by the original marker format.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time

assert os.geteuid() == 0
root = Path(tempfile.mkdtemp(prefix='oc-206-artifact-test-', dir='/var/lib'))
out = {'cases': [], 'cleanupComplete': False}
error = None


def run(argv, **kw):
    r = subprocess.run(argv, capture_output=True, text=True, timeout=15,
                       env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(root), 'LC_ALL': 'C'}, **kw)
    assert r.returncode == 0, 'private builder failed: ' + r.stderr[-1000:]
    return r.stdout.strip()


def git(*args):
    return run(['/usr/bin/git', '-C', str(repo), *args])


def commit(label, modern=False, admission=None):
    obj = {'capabilities': [mod.kernel.CAP] if modern else [],
           'runtimeCapabilities': [mod.kernel.CAP] if modern else []}
    if admission is not None:
        obj['delegateConsumerAdmission'] = admission
    file = repo / 'deploy/v5/release-metadata.json'
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(obj, indent=2) + '\n')
    git('add', '.')
    git('-c', 'user.name=Private Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', label)
    sha = git('rev-parse', 'HEAD')
    return sha, file.read_bytes(), obj


def master(label, source):
    sha, raw, _ = source
    r = root / ('rel-master-' + label); r.mkdir()
    for p in ('node_modules/tsx', 'packages/web-react/dist', 'deploy/v5'):
        (r / p).mkdir(parents=True)
    (r / 'package.json').write_text('{}\n')
    (r / 'VERSION.json').write_text(json.dumps({'commit': sha[:12]}))
    (r / 'packages/web-react/dist/index.html').write_text('<meta name="oc-build" content="private">')
    (r / 'deploy/v5/release-metadata.json').write_bytes(raw)
    run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; write_strong_release_marker_local "$2" "$3" "${3:0:12}" 20260101-000000 2',
         'private-master-builder', str(root / 'scripts/v5-selfhost-master-release-lib.sh'), str(r), sha])
    return r


def runtime(label, source):
    sha, _, metadata = source
    r = root / ('staging-' + label); r.mkdir()
    (r / 'payload.js').write_text('// private digest fixture; never executed\n')
    builder = root / 'scripts/deploy-v5-selfhost.sh'
    builder.write_text('set -euo pipefail\nsource "$1"\nwrite_flavor_manifest "$2" selfhost "$3"\n')
    run(['/bin/bash', str(builder), str(root / 'scripts/lib/assert-flavor.sh'), str(r), sha])
    digest = run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; oc_hotcfg_build_manifest "$2" 1 "$3" "" "" "" "$4"',
                  'private-runtime-builder', str(root / 'scripts/v5-runtime-release-lib.sh'), str(r), sha,
                  ' '.join(metadata['runtimeCapabilities'])])
    target = root / ('rel-' + digest)
    r.rename(target)
    return target


def capture(m, r):
    return mod.capture(str(m), str(r), str(repo), time.monotonic() + 30)


def deny(fn, label):
    try:
        fn()
    except mod.Unknown:
        out['cases'].append(label)
        return
    raise AssertionError(label + ': unbound declaration accepted')


try:
    for name, encoded in OC206_ARTIFACT_FILES.items():
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(base64.b64decode(encoded))
        p.chmod(0o700)
    spec = importlib.util.spec_from_file_location('artifacts', root / 'scripts/lib/delegate-consumer-artifacts.py')
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    repo = root / 'repo'; repo.mkdir()
    run(['/usr/bin/git', 'init', '-q', str(repo)])
    legacy = commit('legacy')
    closed = commit('closed', True, 'bootstrap-closed')
    enabled = commit('enabled', True, 'enabled')
    missing = commit('missing-admission', True)
    lm, lr = master('legacy', legacy), runtime('legacy', legacy)
    cm, cr = master('closed', closed), runtime('closed', closed)
    em = master('enabled', enabled)
    mm, mr = master('missing', missing), runtime('missing', missing)
    p = capture(lm, lr)
    assert p['master']['consumer'] == p['runtime']['consumer'] == 1
    assert p['runtime']['admission'] == 'legacy'
    old_proof = p
    out['cases'].append('original-digests-pinned-legacy-source')
    p = capture(cm, cr)
    assert p['master']['consumer'] == p['runtime']['consumer'] == 2
    assert p['runtime']['admission'] == 'bootstrap-closed'
    closed_proof = p
    out['cases'].append('original-digests-pinned-closed-declaration')
    p = capture(em, cr)
    assert p['master']['sourceCommit'] != p['runtime']['sourceCommit']
    assert p['master']['admission'] == 'enabled' and p['runtime']['admission'] == 'bootstrap-closed'
    enabled_proof = p
    out['cases'].append('different-pinned-source-pair-supported')
    # Real manifests include a large files index; exercise the >8 MiB read path
    # without installing/copying dependencies into this private fixture.
    mf = cr / 'MANIFEST.json'; compact = mf.read_bytes()
    large = json.loads(compact); large['fixturePadding'] = 'x' * (9 * 1024 * 1024)
    mf.write_text(json.dumps(large))
    try:
        p = capture(cm, cr)
    except mod.Unknown as exc:
        raise AssertionError('real-size manifest must be readable under artifact budget') from exc
    assert p['runtime']['consumer'] == 2
    # Unit/env readers still retain their original smaller bound.
    try:
        mod.paths._root_text(str(mf), time.monotonic() + 15)
    except mod.paths.Unknown:
        pass
    else:
        raise AssertionError('artifact budget must not widen ordinary unit/env reads')
    large['fixturePadding'] = 'x' * (mod.kernel.MAX_METADATA + 1)
    mf.write_text(json.dumps(large))
    deny(lambda: capture(cm, cr), 'oversize-artifact-still-unknown')
    mf.write_bytes(compact)
    # Refresh only the proofs changed by restoring MANIFEST file identity.
    closed_proof, enabled_proof = capture(cm, cr), capture(em, cr)
    out['cases'].append('large-manifest-supported-unit-budget-unchanged')
    database = root / 'empty.db'
    sqlite3.connect(database).close()
    inv = mod.inventory_reader.collect([], [], [str(database)])
    def classify(current, candidate, fallback):
        return mod.classify_transition(current, candidate, fallback, inv, time.monotonic() + 15)
    result = classify(old_proof, closed_proof, old_proof)
    assert result == {'status': 'compatible_snapshot', 'required': 1, 'requiresQuiescence': True, 'databaseCount': 1}
    out['cases'].append('closed-bootstrap-legacy-fallback-needs-barrier')
    result = classify(old_proof, enabled_proof, old_proof)
    assert result['status'] == 'incompatible' and result['required'] == 2, 'empty DB cannot permit enabled candidate with legacy fallback'
    out['cases'].append('enabled-first-write-cannot-use-legacy-fallback')
    result = classify(closed_proof, enabled_proof, closed_proof)
    assert result['status'] == 'compatible_snapshot' and result['required'] == 2 and result['requiresQuiescence'] is False
    out['cases'].append('enabled-candidate-paired-fallback')
    result = classify(enabled_proof, old_proof, old_proof)
    assert result['status'] == 'incompatible' and result['required'] == 2
    out['cases'].append('enabled-current-cannot-use-empty-snapshot-to-rollback')
    # Actual original runtime verifier STILL passes after changing only its
    # excluded MANIFEST capability. New source binding must reject it.
    file = lr / 'MANIFEST.json'; original = file.read_bytes()
    value = json.loads(original); value['capabilities'] = [mod.kernel.CAP]
    file.write_text(json.dumps(value))
    run(['/bin/bash', '-c', 'set -euo pipefail; source "$1"; oc_hotcfg_verify_manifest_full "$2"',
         'private-old-verifier', str(root / 'scripts/v5-runtime-release-lib.sh'), str(lr)])
    out['oldDigestAcceptedRewrittenCapabilities'] = True
    deny(lambda: capture(lm, lr), 'mutable-manifest-cannot-upgrade-source')
    file.write_bytes(original)
    value = json.loads(original); value['sourceCommit'] = closed[0]
    file.write_text(json.dumps(value))
    deny(lambda: capture(lm, lr), 'mutable-manifest-cannot-change-source')
    file.write_bytes(original)
    deny(lambda: capture(mm, mr), 'modern-missing-admission-unknown')
    file = cm / 'deploy/v5/release-metadata.json'; original = file.read_bytes()
    file.write_bytes(original + b' ')
    deny(lambda: capture(cm, cr), 'original-master-digest-tamper-refused')
    file.write_bytes(original)
    # Rewriting bytes back changes inode metadata included by the original
    # master digest. Do not fake that tree healthy again: use fresh lm below.
    file = lr / 'flavor.manifest.json'; original = file.read_bytes()
    value = json.loads(original); value['sourceCommit'] = closed[0]
    file.write_text(json.dumps(value))
    deny(lambda: capture(lm, lr), 'digest-covered-flavor-tamper-refused')
    file.write_bytes(original)
    deny(lambda: mod.capture(str(lm), '', str(repo), time.monotonic() + 30), 'embedded-needs-separate-proof')
    p = em / 'deploy/v5/release-metadata.json'; saved = p.with_suffix('.saved'); p.rename(saved); p.symlink_to(saved)
    deny(lambda: capture(em, cr), 'metadata-symlink-refused')
    p.unlink(); saved.rename(p)
    # Missing source object must not be reconstructed from mutable MANIFEST.
    hidden = repo / '.git.hidden'; (repo / '.git').rename(hidden)
    deny(lambda: capture(lm, lr), 'pinned-source-unavailable-unknown')
    hidden.rename(repo / '.git')
    # Real shell/hasher-style descendant: the total deadline must kill the
    # entire private process group, not leave an orphan writing after timeout.
    worker = root / 'private-timeout.py'
    writer_pid = root / 'writer.pid'
    counter = root / 'counter'
    worker.write_text('''import os,pathlib,sys,time
root=pathlib.Path(sys.argv[1])
pid=os.fork()
if pid:
 while True: time.sleep(1)
(root/'writer.pid').write_text(str(os.getpid()))
i=0
while True:
 i+=1
 (root/'counter').write_text(str(i))
 time.sleep(.02)
''')
    before = time.monotonic()
    deny(lambda: mod._run(['/usr/bin/python3', str(worker), str(root)], time.monotonic() + 0.8),
         'real-digest-subprocess-budget-kills-descendants')
    assert time.monotonic() - before < 3 and writer_pid.exists() and counter.exists()
    count = counter.read_text(); time.sleep(0.08)
    assert counter.read_text() == count, 'private hasher descendant kept writing after budget exit'
    proc = Path('/proc') / writer_pid.read_text() / 'stat'
    if proc.exists():
        text = proc.read_text()
        assert text[text.rfind(')') + 2:].split()[0] in {'Z', 'X'}, 'private descendant still runnable'
except BaseException as exc:
    error = type(exc).__name__ + ': ' + str(exc)
    out['failure'] = error
finally:
    shutil.rmtree(root)
    out['cleanupComplete'] = not root.exists()
print(json.dumps(out))
raise SystemExit(0 if error is None and len(out['cases']) == 18 and out['cleanupComplete'] else 1)
