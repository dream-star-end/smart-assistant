"""Test-only structured adapter; never captures real Docker or executes a caller."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('inventory',
    Path(__file__).resolve().parents[2] / 'lib/delegate-consumer-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
try:
    data = json.load(sys.stdin)
    print(json.dumps(inventory.collect(data['volumes'], data['containers'], data['masters'])))
except inventory.Unknown:
    print('{"status":"unknown"}')
    sys.exit(2)
