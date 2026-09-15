#!/usr/bin/env python3
"""Real pinned history/unit/snapshot recovery projections and original B0."""
import argparse
import importlib.util
from pathlib import Path
import subprocess
import textwrap


def payload(root, negative=False):
    spec = importlib.util.spec_from_file_location('preflight_fixture', root / 'scripts/__tests__/delegateConsumerPreflight.test.py')
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    full = helper.payload(root)
    prefix, _ = full.split('\n    result = check(joint=True)', 1)
    cleanup = full[full.rindex('\nexcept BaseException as exc:\n    error ='):]
    cleanup = cleanup.replace("len(out['cases']) == 16", "len(out['cases']) == 12")
    cleanup = cleanup.replace("except BaseException as exc:\n    error =", "except BaseException as exc:\n    import traceback; traceback.print_exc()\n    error =")
    fixture = (root / 'scripts/__tests__/fixtures/delegateConsumerRecoveryContext.fixture.py').read_text()
    return prefix + '\n' + textwrap.indent('NEGATIVE = ' + repr(negative) + '\n' + fixture, '    ') + cleanup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.add_argument('--negative-control', action='store_true')
    args = parser.parse_args()
    result = subprocess.run(['host', 'python3 -'], input=payload(Path(__file__).resolve().parents[2], args.negative_control), text=True, timeout=180)
    raise SystemExit(result.returncode)
