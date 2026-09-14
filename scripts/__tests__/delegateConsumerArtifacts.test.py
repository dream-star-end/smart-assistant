#!/usr/bin/env python3
"""Explicit private-host provenance test; no runtime build or dependencies."""
import argparse
import base64
from pathlib import Path
import subprocess


def payload(root):
    names = ['scripts/lib/delegate-consumer-artifacts.py', 'scripts/lib/delegate-consumer-state.py',
             'scripts/lib/delegate-consumer-lock-owner.py', 'scripts/lib/delegate-consumer-unit-paths.py',
             'scripts/lib/delegate-consumer-inventory.py',
             'scripts/lib/assert-flavor.sh', 'scripts/delegate-consumer-compat.py',
             'scripts/v5-selfhost-master-release-lib.sh', 'scripts/v5-runtime-release-lib.sh']
    encoded = {n: base64.b64encode((root / n).read_bytes()).decode() for n in names}
    # Exact existing policy, not a test-rewritten flavor allowlist. Sparse trees
    # may not materialize the commercial path; read its frozen Git object only.
    rules = root / 'packages/commercial/src/flavor/flavor-rules.json'
    raw = rules.read_bytes() if rules.exists() else subprocess.check_output(
        ['git', '-C', str(root), 'show', 'HEAD:packages/commercial/src/flavor/flavor-rules.json'])
    encoded['scripts/lib/flavor-rules.json'] = base64.b64encode(raw).decode()
    return ('OC206_ARTIFACT_FILES=' + repr(encoded) + '\n' +
            (root / 'scripts/__tests__/fixtures/delegateConsumerArtifacts.fixture.py').read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    # host is the existing fixed SSH wrapper: stream source on stdin instead of
    # placing full frozen libraries in one argv (Linux MAX_ARG_STRLEN is 128KiB).
    result = subprocess.run(['host', 'python3 -'], input=payload(root), text=True, timeout=150)
    raise SystemExit(result.returncode)
