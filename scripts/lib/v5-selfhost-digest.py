#!/usr/bin/env python3
"""Selfhost full verification; byte-compatible with the shared shell digest.

Keep the shared runtime/commercial implementation untouched. Never print a
digest until every directory, regular file and symlink has been read.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import stat
import sys


def file_rows(root):
    pending = [b'']
    while pending:
        relative = pending.pop()
        with os.scandir(os.path.join(root, relative)) as entries:
            for entry in entries:
                path = os.path.join(relative, entry.name)
                mode = entry.stat(follow_symlinks=False).st_mode
                if stat.S_ISDIR(mode):
                    pending.append(path)
                elif stat.S_ISLNK(mode) or (stat.S_ISREG(mode) and entry.name not in
                                           (b'MANIFEST.json', b'MANIFEST.json.tmp')):
                    yield path, mode


def hash_row(root, item):
    path, mode = item
    absolute = os.path.join(root, path)
    if stat.S_ISLNK(mode):
        # Bash command substitution removes all trailing newlines from readlink.
        value = b'link:' + os.readlink(absolute).rstrip(b'\n')
        size, permissions = b'0', b'777'
    else:
        digest = hashlib.sha256()
        with open(absolute, 'rb') as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            size = str(os.fstat(stream.fileno()).st_size).encode('ascii')
        # GNU sha256sum prefixes escaped filename output, including its hash,
        # with a backslash; the old cut keeps that prefix in the hash field.
        escaped = b'\\' if b'\\' in path or b'\n' in path else b''
        value = escaped + digest.hexdigest().encode('ascii')
        permissions = format(stat.S_IMODE(mode), 'o').encode('ascii')
    return b'\t'.join((path, value, size, permissions)) + b'\n'


def digest_tree(root):
    root = os.fsencode(root)
    # Retain the old TSV round trip, even for unusual symlink targets containing
    # tabs/newlines. sort -t TAB -k1,1 uses the entire line to break equal keys.
    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
        rows = b''.join(pool.map(lambda item: hash_row(root, item), file_rows(root)))
    lines = rows.split(b'\n')[:-1]
    lines.sort(key=lambda line: (line.split(b'\t', 1)[0], line))
    digest = hashlib.sha256()
    for line in lines:
        # IFS=TAB read -r p h s m: TAB is IFS whitespace, so leading/trailing
        # separators are stripped; only the last field keeps internal tabs.
        rest = line.lstrip(b'\t')
        fields = []
        for _ in range(3):
            first, separator, rest = rest.partition(b'\t')
            fields.append(first)
            rest = rest.lstrip(b'\t') if separator else b''
        path, value, _size = fields
        if path:
            digest.update(path + b'\0' + value + b'\0' + rest.rstrip(b'\t') + b'\n')
    return digest.hexdigest()[:12]


def main():
    action, root = sys.argv[1:]
    if action not in ('digest', 'verify'):
        raise ValueError('expected digest or verify')
    if action == 'verify':
        with open(os.path.join(root, 'MANIFEST.json'), encoding='utf-8') as stream:
            want = json.load(stream).get('digest')
        if not isinstance(want, str) or not want:
            raise ValueError('MANIFEST has no digest')
    have = digest_tree(root)
    if action == 'verify' and have != want:
        raise ValueError(f'digest mismatch: computed={have} manifest={want}')
    print(have)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f'selfhost digest: {error}', file=sys.stderr)
        sys.exit(1)
