#!/usr/bin/env python3
"""Opt-in: python3 scripts/__tests__/delegateConsumerState.test.py --host.

Run the permanent frozen-source fixture through the existing selfhost host
channel. It creates only private root directories/processes, not platform units.
No install, dependency copy, daemon mutation or production database access.
"""
import argparse
import base64
from pathlib import Path
import subprocess


def payload(root):
    script = (root / 'scripts/deploy-v5-selfhost.sh').read_text()
    lock_functions = script[script.index('selfhost_lock_holder_info() {'):script.index('maybe_acquire_selfhost_deploy_lock() {')]
    phase_functions = script[script.index('cutover_survivor_script() {'):script.index('cutover_persist_phase_or_compensate() {')]
    files = {'survivor.sh': 'scripts/v5-selfhost-cutover-survivor.sh',
             'lib/delegate-consumer-state.py': 'scripts/lib/delegate-consumer-state.py',
             'lib/delegate-consumer-lock-owner.py': 'scripts/lib/delegate-consumer-lock-owner.py'}
    encoded = {name: base64.b64encode((root / source).read_bytes()).decode() for name, source in files.items()}
    return ('OC206_STATE_FILES=' + repr(encoded) + '\nOC206_DEPLOY_LOCK_FUNCTIONS=' +
            repr(base64.b64encode(lock_functions.encode()).decode()) + '\nOC206_DEPLOY_PHASE_FUNCTIONS=' +
            repr(base64.b64encode(phase_functions.encode()).decode()) + '\n' +
            (root / 'scripts/__tests__/fixtures/delegateConsumerState.fixture.py').read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True,
                        help='explicitly opt in to isolated root host fixture')
    parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(['host', "python3 - <<'OC206_STATE_TEST'\n" + payload(root) + '\nOC206_STATE_TEST'], timeout=80)
    raise SystemExit(result.returncode)
