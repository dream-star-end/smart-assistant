#!/usr/bin/env python3
"""Root-owned prepare receipts. Caller holds the selfhost artifact flock.

Only this helper publishes/consumes receipts; JSON is data, never shell input.
The master seal and runtime/platform manifests are reverified by the deploy lane.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


def trusted(path, directory=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('non-canonical prepared path')
    # Include every parent: a root-owned leaf below a writable/symlink parent is unsafe.
    for item in reversed([path, *path.parents]):
        mode = item.lstat()
        if stat.S_ISLNK(mode.st_mode) or mode.st_uid != 0 or mode.st_mode & 0o022:
            raise ValueError('untrusted prepared path: ' + str(item))
        if item != path or directory:
            if not stat.S_ISDIR(mode.st_mode):
                raise ValueError('expected directory: ' + str(item))
        elif not stat.S_ISREG(mode.st_mode):
            raise ValueError('expected regular file: ' + str(item))
    return path


def digest(path):
    return hashlib.sha256(trusted(path).read_bytes()).hexdigest()


def artifact(path, root, marker, pattern):
    root = trusted(root, True)
    path = trusted(path, True)
    if path.parent != root or not re.fullmatch(pattern, path.name):
        raise ValueError('artifact outside expected root')
    data = json.loads(trusted(path / marker).read_text())
    return {'path': str(path), 'markerSha256': digest(path / marker)}, data


def ancestors(repo, sha):
    # Ancestor retention is an optimization. Incomplete/unreadable history
    # falls back to the original exact-SHA rule without blocking preparation.
    # Never treat a truncated rev-list as a complete ancestry proof.
    try:
        shallow = subprocess.run(['git', '-C', repo, 'rev-parse', '--is-shallow-repository'],
                                 check=True, capture_output=True, text=True)
        if shallow.stdout.strip() != 'false':
            return {sha}
        result = subprocess.run(['git', '-C', repo, 'rev-list', sha], check=True,
                                capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError):
        return {sha}
    return set(result.stdout.splitlines())


def main():
    action, root, sha, *args = sys.argv[1:]
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('invalid prepared SHA')
    root = Path(root)
    if action == 'init':
        # Check the existing parent before creating anything.
        trusted(root.parent, True)
        root.mkdir(mode=0o700, exist_ok=True)
    root = trusted(root, True)
    receipt = root / (sha + '.json')
    if action == 'init':
        return
    if action == 'prune':
        history = ancestors(args[0], sha)
        for partial in root.glob('.receipt-*'):
            trusted(partial).unlink()  # exclusive artifact lock proves no active publisher
        for old in root.glob('*.json'):
            if re.fullmatch('[0-9a-f]{40}\.json', old.name):
                trusted(old)
                if old.stem in history:
                    continue  # newer merges do not invalidate fully gated ancestors
                trusted(old).unlink()
        return
    if action == 'consume':
        history = ancestors(args[1], sha)
        if receipt.exists():
            doc = json.loads(trusted(receipt).read_text())
            if doc['master']['path'] != args[0]:
                return
            receipt.unlink()
        # Called only after durable commit. This train covers its strict
        # ancestors; retain next-train receipts and same-SHA/different-master.
        for old in root.glob('*.json'):
            if old.stem != sha and old.stem in history:
                trusted(old).unlink()
        return
    if action == 'remove':
        if receipt.exists() or receipt.is_symlink():
            trusted(receipt).unlink()
        return
    if action == 'pending':
        # Unknown/malformed state is conservative: never authorize GC through it.
        sys.exit(0 if any(root.iterdir()) else 1)
    tree, options, image, image_id, master_root, runtime_root, bundle_root, *paths = args
    identity = {'schema': 1, 'sourceCommit': sha, 'sourceTree': tree,
                'options': options, 'image': image, 'imageId': image_id}
    if not re.fullmatch('[0-9a-f]{40}', tree) or not re.fullmatch('sha256:[0-9a-f]{64}', image_id):
        raise ValueError('invalid tree/image identity')
    if action == 'write':
        master, runtime, bundle = paths
    else:
        doc = json.loads(trusted(receipt).read_text())
        if any(doc.get(k) != v for k, v in identity.items()):
            raise ValueError('prepared identity/options differ')
        master, runtime, bundle = (doc[k]['path'] for k in ('master', 'runtime', 'bundle'))
    m, meta = artifact(master, master_root, '.complete', r'rel-[A-Za-z0-9-]+')
    r, runtime_meta = artifact(runtime, runtime_root, 'MANIFEST.json', r'rel-[0-9a-f]{12}')
    b, _ = artifact(bundle, bundle_root, 'MANIFEST.json', r'[0-9a-f]{12}')
    if meta.get('sourceCommit') != sha or runtime_meta.get('sourceCommit') != sha:
        raise ValueError('prepared source mismatch')
    # Identical platform bytes can reuse a content-addressed bundle from an older
    # SHA. The root-owned receipt binds its exact manifest to this preparation.
    identity.update(master=m, runtime=r, bundle=b)
    if action == 'write':
        fd, name = tempfile.mkstemp(prefix='.receipt-', dir=root)
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump(identity, out, sort_keys=True)
                out.write('\n')
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, receipt)
            dfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        finally:
            if os.path.exists(name):
                os.unlink(name)
    elif action == 'read':
        if doc != identity:
            raise ValueError('prepared artifact marker changed')
        print(json.dumps(identity))
    else:
        raise ValueError('unknown prepared operation')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print('prepared receipt rejected: ' + str(error), file=sys.stderr)
        sys.exit(2)
