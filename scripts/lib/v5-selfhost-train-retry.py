#!/usr/bin/env python3
"""Fail-closed classification of the four existing selfhost transient failures."""
import json
from pathlib import Path
import re
import sqlite3
import sys


def classify(row):
    if row['status'] != 'failed':
        return ''
    evidence = json.loads(row['evidence_json'] or '{}')
    # A held/published policy or any live mutation is never an S2 retry.
    if not isinstance(evidence, dict) or any(k.startswith('releasePolicy') for k in evidence):
        return ''
    if evidence.get('phase') not in (None, '', 'pre-install', 'pre-mutation', 'armed'):
        return ''
    path = Path(row['log_path'] or '')
    summary = json.loads(path.with_suffix('.summary.json').read_text())
    if (summary.get('trainId') != row['id'] or summary.get('sourceCommit') != row['target_sha']
            or summary.get('final') is not True or summary.get('result') != 'failed'):
        return ''
    phase, notes = summary.get('failedPhase'), summary.get('notes', {})
    if not isinstance(notes, dict):
        return ''
    # A real C/D failure wins over a concurrent admission timeout.
    if any(k.startswith('job.') and k.endswith('.rc') and str(v) != '0' for k, v in notes.items()):
        return ''
    text = path.read_text(errors='replace')
    if phase == 'E3.wait-idle' and re.search(
            r'^.*  ✗ 等待空闲 600s 超时;拒绝切换,旧 master 继续运行$', text, re.M):
        return 'user_idle_timeout'
    if phase in ('A', 'C.parallel', 'C.box-gates') or (isinstance(phase, str) and phase.startswith('C.')):
        if any((k.startswith('hostIdle.') and k.endswith('.timeout')) or
               (k.startswith('job.') and k.endswith('.admissionFailure') and v == 'admission-timeout')
               for k, v in notes.items()):
            return 'admission_timeout'
    # Assert-tip itself is the terminal error; never accept this phrase in TAP output.
    errors = re.findall(r'^✗ (.+)$', text, re.M)
    if errors and re.fullmatch(r'selfhost tip changed; discard prepared ' + row['target_sha'] +
                               r' and prepare the new tip', errors[-1]):
        return 'tip_advanced'
    if phase not in ('B', 'P.runtime-wait') or not errors:
        return ''
    if phase == 'B':
        tail = text.rsplit('── B ', 1)[-1]
        terminal = errors[-1] == 'staging npm ci 失败'
    else:
        # This child log contains dependency installation/build output, never gate TAP.
        tail = text.rsplit('── build runtime release(git archive + prune + finalize) ──', 1)
        if len(tail) != 2:
            return ''
        tail = tail[-1]
        terminal = bool(re.fullmatch(r'runtime release 后台构建失败 rc=[1-9][0-9]*\(live 未改;日志见上\)', errors[-1]) or
                        errors[-1] == 'release finalize 失败(npm ci / ccb bun build / MANIFEST)')
    network = re.search(r'^npm (?:ERR!|error) code (?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$', tail, re.M)
    download = re.search(r'^error: failed to download [@A-Za-z0-9][^\r\n]*$', tail, re.M)
    return 'dependency_download_failed' if terminal and (network or download) else ''


def main():
    con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    row = con.execute('SELECT * FROM train WHERE id=? AND resource=?',
                      (sys.argv[2], 'deploy:selfhost')).fetchone()
    if row:
        print(classify(row))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError, sqlite3.Error):
        # Missing/corrupt evidence cannot authorize a retry.
        sys.exit(1)
