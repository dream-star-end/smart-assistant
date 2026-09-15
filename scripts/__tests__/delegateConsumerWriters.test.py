#!/usr/bin/env python3
"""Private original initial caller + immutable writer source binding.

Actual PID1 loaded unit/env, root artifact builders/Git/digests and SQLite;
Docker transport/launch metadata are fixtures, NOT live Docker/process proof.
"""
import argparse
import base64
import importlib.util
from pathlib import Path
import subprocess
import textwrap


def payload(root, negative=False):
    spec = importlib.util.spec_from_file_location('original_preflight_fixture', root / 'scripts/__tests__/delegateConsumerPreflight.test.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    full = helper.payload(root)
    prefix, _ = full.split('\n    result = check(joint=True)', 1)
    cleanup = full[full.rindex('\nexcept BaseException as exc:\n    error ='):]
    cleanup = cleanup.replace("len(out['cases']) == 16", "len(out['cases']) == 11")
    mutation = ''
    if negative:
        name = 'scripts/lib/delegate-consumer-artifacts.py'
        source = (root / name).read_text()
        before = "may_seal = may_seal or any(proof['runtime']['admission'] == 'enabled' for proof in writers)"
        assert source.count(before) == 1
        changed = base64.b64encode(source.replace(before, 'pass # virtual removal of actual writer floor').encode()).decode()
        # Insert before the fixture writes the frozen sources, never edit the WIP.
        anchor = '\ntry:\n    for filename, encoded in OC206_ARTIFACT_FILES.items():'
        assert prefix.count(anchor) == 1
        mutation = '\nOC206_ARTIFACT_FILES[' + repr(name) + ']=' + repr(changed) + '\n'
        prefix = prefix.replace(anchor, mutation + anchor)
    return prefix + '\n' + textwrap.indent((root / 'scripts/__tests__/fixtures/delegateConsumerWriters.fixture.py').read_text(), '    ') + cleanup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.add_argument('--negative-control', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['host', 'python3 -'], input=payload(root, args.negative_control), text=True, timeout=200)
    raise SystemExit(result.returncode)
