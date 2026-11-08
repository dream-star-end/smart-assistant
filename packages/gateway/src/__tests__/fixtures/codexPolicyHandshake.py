"""Validate actual gateway handshake frames using the unchanged production node Policy."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

repo = Path(__file__).resolve().parents[5]
spec = importlib.util.spec_from_file_location('node_policy', repo / 'scripts/agent-remote/codex-host-controller.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='codex-policy-fixture-') as temp:
    root = Path(temp)
    (root / 'model-list.json').write_text('[]')
    (root / 'model-list.json').chmod(0o600)
    policy = module.Policy(root, {'nativeThreadId': None}, None)
    for frame in json.load(sys.stdin):
        policy.incoming(frame)
        policy.outgoing({'id': frame['id'], 'result': {}})
