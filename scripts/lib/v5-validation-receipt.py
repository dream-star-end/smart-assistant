#!/usr/bin/env python3
"""Persist a model-scope result under the existing production mutation owner."""
import base64
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


def require(value, message):
    if not value:
        raise ValueError(message)


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", value)


def verify_owner(lock, operation, admission):
    meta_path = Path(str(lock) + '.meta')
    info = meta_path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and not info.st_mode & 0o022, 'unsafe lease metadata')
    meta = json.loads(meta_path.read_text())
    require(meta['deploy_id'] == operation
            and time.time() < meta['started_at'] + meta['ttl'], 'lease differs or expired')
    proc = Path('/proc', str(int(meta['remote_pid'])))
    state = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[0]
    require(state not in ['Z', 'T', 't'], 'holder is not running')
    a, b = (proc / 'fd/9').stat(), lock.stat()
    require((a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), 'holder lock differs')
    require(re.search(r'^lock:\s+.*\bFLOCK\s+ADVISORY\s+WRITE\s+',
                      (proc / 'fdinfo/9').read_text(), re.M), 'holder has no write flock')
    require(Path(str(lock) + '.admission-nonce').read_text().strip() == admission,
            'admission differs')
    require(json.loads(meta_path.read_text()) == meta, 'owner changed')


def validate(value, operation):
    require(identifier(operation), 'invalid operation identifier')
    require(set(value) == {'schemaVersion', 'executingDeploymentId', 'scope', 'phase',
                          'releaseUnderTest', 'grokMatrix', 'grokJourney',
                          'deepseekMatrix', 'deepseekJourney'}, 'unexpected receipt fields')
    require(value['schemaVersion'] == 1 and value['executingDeploymentId'] == operation,
            'receipt owner differs')
    scope = value['scope']
    require(scope['profile'] == 'skip-grok' and identifier(scope['operationId']),
            'unbound scope')
    require(re.fullmatch(r'[0-9a-f]{40}', scope['sourceSha'])
            and re.fullmatch(r'rq-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}', scope['queueId']),
            'invalid source or batch')
    require(value['grokMatrix'] == value['grokJourney'] == 'SKIPPED', 'Grok was not passed')
    require(value['phase'] in ['declared', 'running', 'passed', 'failed'], 'invalid phase')
    states = (value['deepseekMatrix'], value['deepseekJourney'])
    require(all(s in ['not-run', 'pending', 'passed', 'failed'] for s in states),
            'invalid result')
    if value['phase'] == 'passed':
        require(states == ('passed', 'passed'), 'cannot accept unpassed checks')
    if value['phase'] == 'failed':
        require('failed' in states, 'failure needs an actual failed check')


def persist(directory, operation, value):
    validate(value, operation)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and not info.st_mode & 0o077, 'unsafe receipt directory')
    filename = directory / (operation + '.json')
    if filename.exists() or filename.is_symlink():
        info = filename.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077, 'unsafe existing receipt')
        old = json.loads(filename.read_text())
        require(old['scope'] == value['scope']
                and old['executingDeploymentId'] == operation, 'scope changed')
    temporary = filename.with_name(filename.name + '.tmp.' + str(os.getpid()))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, sort_keys=True, separators=(',', ':'))
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, filename)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        require(json.loads(filename.read_text()) == value, 'receipt readback differs')
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        root, operation, lock_path, admission, encoded = sys.argv[1:]
        value = json.loads(base64.b64decode(encoded, validate=True))
        validate(value, operation)
        verify_owner(Path(lock_path), operation, admission)
        persist(Path(root), operation, value)
        verify_owner(Path(lock_path), operation, admission)
        print('validation scope receipt persisted: Grok SKIPPED; phase=' + value['phase'])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('validation scope receipt refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
