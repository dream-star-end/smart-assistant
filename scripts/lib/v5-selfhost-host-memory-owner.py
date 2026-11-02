#!/usr/bin/env python3
"""Private stdio adapter to the *original* deploy process's owner guard.

This is not an independent installation CLI or a source of authority. EOF,
timeouts and anything except the exact response reject the write. The official
caller retains its existing lock and performs the real fencing predicate.
"""
import importlib.util
import json
from pathlib import Path
import re
import select
import sys

sys.dont_write_bytecode = True
OPERATION_ID = re.compile(r"tr-[A-Za-z0-9][A-Za-z0-9_-]{0,124}\Z")


def main():
    if len(sys.argv) not in (3, 4) or not OPERATION_ID.fullmatch(sys.argv[2]):
        return 79
    action = sys.argv[3] if len(sys.argv) == 4 else "apply"
    if action not in ("apply", "restore"):
        return 79
    helper = Path(__file__).with_name("v5-selfhost-host-memory-install.py")
    spec = importlib.util.spec_from_file_location("selfhost_host_memory_install", helper)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    def owner_check():
        print("OWNER_CHECK", flush=True)
        ready, _, _ = select.select([sys.stdin], [], [], 30)
        if not ready or sys.stdin.readline() != "OWNER_OK\n":
            raise module.OwnershipRequired("Original release owner did not authorize mutation")

    try:
        installer = module.Installer()
        if action == "restore":
            # The official owner selects only an action. The original receipt,
            # not a caller-supplied path, selects this operation's first snapshot.
            owner_check()
            snapshot = installer.snapshot_for_operation(sys.argv[2])
            result = installer.rollback(snapshot, owner_check=owner_check,
                                        operation_id=sys.argv[2])
            if result.get("restored") is not True:
                raise module.InstallError("Snapshot restore was not verified")
        else:
            result = installer.apply(Path(sys.argv[1]), owner_check=owner_check,
                                     operation_id=sys.argv[2])
        safe = {key: result[key] for key in ("changed", "snapshot", "state", "restored") if key in result}
        print("RESULT " + json.dumps(safe, separators=(",", ":")), flush=True)
        return 0
    except module.OwnershipRequired:
        print("ERROR OwnershipRequired", flush=True)
        return 86
    except module.RecoveryRequired as exc:
        print("ERROR " + json.dumps({"type": "RecoveryRequired", "snapshot": str(exc.snapshot)},
                                    separators=(",", ":")), flush=True)
        return 79
    except Exception as exc:
        # Never echo exception messages, command output or unknown payloads.
        print("ERROR " + type(exc).__name__, flush=True)
        return 79


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("ERROR " + type(exc).__name__, flush=True)
        sys.exit(79)
