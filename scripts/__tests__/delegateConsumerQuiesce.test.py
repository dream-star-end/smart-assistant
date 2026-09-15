#!/usr/bin/env python3
"""Private original FD8/caller enrollment and actual PID1 subtree stop."""
import argparse
import base64
from pathlib import Path
import subprocess


def payload(root, negative=None):
    names = ['scripts/v5-selfhost-cutover-survivor.sh', 'scripts/delegate-consumer-preflight.py', 'scripts/deploy-v5-selfhost.sh', 'scripts/lib/delegate-consumer-cgroup.py', 'scripts/lib/delegate-consumer-artifacts.py', 'scripts/lib/delegate-consumer-state.py',
             'scripts/lib/delegate-consumer-lock-owner.py', 'scripts/lib/delegate-consumer-unit-paths.py',
             'scripts/lib/delegate-consumer-inventory.py',
             'scripts/lib/assert-flavor.sh', 'scripts/delegate-consumer-compat.py',
             'scripts/v5-selfhost-master-release-lib.sh', 'scripts/v5-runtime-release-lib.sh']
    encoded = {n: base64.b64encode((root / n).read_bytes()).decode() for n in names}
    cases = ('normal', 'descendant-remains', 'no-fd', 'incompatible', 'unknown')
    if negative:
        file = 'scripts/lib/delegate-consumer-cgroup.py' if negative == 'populated' else 'scripts/deploy-v5-selfhost.sh'
        source = base64.b64decode(encoded[file]).decode()
        if negative == 'populated':
            before = 'require(not populated and _identity(self.cgroup)[1] == self.identity)'
            after = 'require(_identity(self.cgroup)[1] == self.identity)'
            cases = ('descendant-remains',)
        else:
            before = 'python3 "$SCRIPT_DIR/delegate-consumer-preflight.py" "${args[@]}"'
            after = ': # virtual removal of the original caller'
            cases = ('normal',)
        assert source.count(before) == 1, 'negative control must mutate the actual unique product guard'
        encoded[file] = base64.b64encode(source.replace(before, after).encode()).decode()
    # Exact existing policy, not a test-rewritten flavor allowlist. Sparse trees
    # may not materialize the commercial path; read its frozen Git object only.
    rules = root / 'packages/commercial/src/flavor/flavor-rules.json'
    raw = rules.read_bytes() if rules.exists() else subprocess.check_output(
        ['git', '-C', str(root), 'show', 'HEAD:packages/commercial/src/flavor/flavor-rules.json'])
    encoded['scripts/lib/flavor-rules.json'] = base64.b64encode(raw).decode()
    return ('OC206_ARTIFACT_FILES=' + repr(encoded) + '\nOC206_QUIESCE_CASES=' + repr(cases) + '\n' +
            (root / 'scripts/__tests__/fixtures/delegateConsumerArtifacts.fixture.py').read_text().split('\ntry:\n', 1)[0] + '\n' +
            (root / 'scripts/__tests__/fixtures/delegateConsumerQuiesce.fixture.py').read_text())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', action='store_true', required=True)
    parser.add_argument('--negative-control', choices=('populated', 'caller'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    # host is the existing fixed SSH wrapper: stream source on stdin instead of
    # placing full frozen libraries in one argv (Linux MAX_ARG_STRLEN is 128KiB).
    result = subprocess.run(['host', 'python3 -'], input=payload(root, args.negative_control), text=True, timeout=240)
    raise SystemExit(result.returncode)
