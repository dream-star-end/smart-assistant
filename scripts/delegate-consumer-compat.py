#!/usr/bin/env python3
"""Read-only delegate consumer compatibility kernel (not a release authorization).

The trusted caller must enumerate ALL durable databases and hold the original
writer/cutover barrier, including new-database creation. This snapshot cannot
replace that barrier or prove a rollback safe after a candidate has served.
Exit 0: compatible snapshot; 1: incompatible; 2: unknown (never skip a database).
No paths, identities, credentials or result payloads are emitted.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import sys
import time

CAP = "delegate-receipt-consumer-v2"
MAX_DATABASES = 4096
MAX_METADATA = 1024 * 1024
MAX_BUDGET_MS = 30000
JOB_COLUMNS = """job_id agent_id state kind session_key parent_session_key generation
owner_instance_id owner_lease_until claim_token attempt_no fencing_epoch
checkpoint_kind callback callback_state callback_epoch idempotency_key
failure_class failure_detail result_json created_at updated_at last_activity_at
expires_at parent_engine notify_lane notify_id""".split()
DELIVERY_COLUMNS = """callback_origin_session_key callback_origin_user_id notify_retry_at
notify_attempt notify_delivery_token notify_claimed_until terminal_committed_at""".split()
INBOX_COLUMNS = "job_id generation user_id parent_session child_session summary_code summary_text failed_at ack_at".split()
RECEIPT_COLUMNS = """job_id generation user_id parent_session parent_turn_key native_tool_use_id
receipt_nonce_hash result_digest state created_at updated_at""".split()
SOURCE_COLUMNS = """job_id generation user_id parent_client_session_id parent_session child_session
target_agent_id metadata_json created_at retired_at""".split()
ACTION_COLUMNS = """user_id source_job_id generation action_id target_job_id state created_at
dispatched_at terminal_code""".split()
JOB_STATES = "queued running paused_for_cutover completed failed cancelled killed_by_cutover".split()
RECEIPT_STATES = "offered ingest_claimed ingested notify_pending notify_claimed notified".split()


class Unknown(Exception):
    pass


class BudgetExpired(Unknown):
    pass


def require(condition):
    if not condition:
        raise Unknown()


def checked_path(value, allow_missing=False):
    """No realpath normalization through untrusted links; retain ancestry identity."""
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts)
    chain = []
    current = Path(path.anchor)
    parts = path.parts[1:]
    require(bool(parts))
    for i, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            require(allow_missing and i == len(parts) - 1)
            return path, tuple(chain), None
        require(stat.S_ISREG(info.st_mode) if i == len(parts) - 1 else stat.S_ISDIR(info.st_mode))
        chain.append((info.st_dev, info.st_ino))
    return path, tuple(chain), info


def unchanged(value, identity, missing=False):
    _, after, info = checked_path(value, allow_missing=missing)
    require(after == identity and (not missing or info is None))


def candidate(value):
    path, identity, info = checked_path(value)
    require(info.st_size <= MAX_METADATA)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == identity[-1])
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(MAX_METADATA + 1)
        require(len(raw) <= MAX_METADATA)
        after = os.fstat(fd)
        require((opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
    finally:
        os.close(fd)
    unchanged(value, identity)
    obj = json.loads(raw)
    require(isinstance(obj, dict))
    caps = obj.get("capabilities")
    require(isinstance(caps, list) and all(isinstance(c, str) for c in caps))
    require(all(c == CAP for c in caps if c.startswith("delegate-receipt-consumer-")))
    return 2 if CAP in caps else 1


def shape(db, table, columns):
    row = db.execute("SELECT type,sql FROM sqlite_schema WHERE name=?", (table,)).fetchone()
    require(row is not None and row[0] == "table" and
            row[1] is not None and "VIRTUAL TABLE" not in row[1].upper())
    actual = {r[1] for r in db.execute('PRAGMA table_info("' + table + '")')}
    require(set(columns) <= actual)


def count(db, table, where="1"):
    value = db.execute('SELECT count(*) FROM "' + table + '" WHERE ' + where).fetchone()[0]
    require(isinstance(value, int) and 0 <= value <= 9007199254740991)
    return value


def states(db, table, column, allowed):
    invalid = db.execute('SELECT 1 FROM "' + table + '" WHERE "' + column +
                         '" IS NULL OR "' + column + '" NOT IN (' +
                         ','.join('?' for _ in allowed) + ') LIMIT 1', allowed).fetchone()
    require(invalid is None)


def inventory(value, deadline):
    path, identity, info = checked_path(value, allow_missing=True)
    # SQLite may follow WAL/SHM/journal links independently of the main file.
    for suffix in ("-wal", "-shm", "-journal"):
        _, _, sidecar = checked_path(str(path) + suffix, allow_missing=True)
        require(info is not None or sidecar is None)
    if info is None:
        unchanged(value, identity, missing=True)
        return {"schema": None, "required": 1, "absent": True}
    require(time.monotonic() < deadline)
    # Never immutable=1: committed rows can exist only in the live WAL.
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.25)
    try:
        unchanged(value, identity)
        db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        version = db.execute("PRAGMA user_version").fetchone()[0]
        require(isinstance(version, int) and 0 <= version <= 11)
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        if version == 0:
            require(db.execute("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").fetchone() is None)
            result = {"schema": 0, "required": 1, "absent": False}
        else:
            expected = {"delegate_jobs"}
            columns = list(JOB_COLUMNS)
            if version >= 2:
                columns += DELIVERY_COLUMNS
            if version >= 3:
                columns += ["notify_a_attempted_at"]
            if version >= 4:
                columns += ["retired_at"]
            if version >= 5:
                columns += ["failure_inbox_enabled"]
                expected.add("delegate_failure_inbox")
            if version >= 6:
                columns += ["delivery_receipt_context"]
                expected.add("delegate_delivery_receipt")
            if version >= 9:
                expected.update(("delegate_retry_source", "delegate_retry_action", "delegate_retry_parent_fence"))
            require(tables == expected)
            shape(db, "delegate_jobs", columns)
            states(db, "delegate_jobs", "state", JOB_STATES)
            states(db, "delegate_jobs", "kind", "delegate review send_to_agent cron taskboard ccb_local advisor".split())
            states(db, "delegate_jobs", "callback", "none origin-inject stdout-wait cron-origin-inject".split())
            states(db, "delegate_jobs", "callback_state", "none pending injecting delivered abandoned skipped_silent".split())
            states(db, "delegate_jobs", "checkpoint_kind", ["none", "runner_quiesced"])
            totals = {"jobs": count(db, "delegate_jobs"), "inboxEnrolled": 0, "enrolled": 0, "receipts": 0,
                      "unacknowledged": 0, "sources": 0, "actions": 0, "parentFences": 0}
            if version >= 5:
                shape(db, "delegate_failure_inbox", INBOX_COLUMNS)
                states(db, "delegate_jobs", "failure_inbox_enabled", [0, 1])
                totals["inboxEnrolled"] = count(db, "delegate_jobs", "failure_inbox_enabled=1")
                totals["unacknowledged"] = count(db, "delegate_failure_inbox", "ack_at IS NULL")
            if version >= 6:
                shape(db, "delegate_delivery_receipt", RECEIPT_COLUMNS +
                      (["owner_token", "parent_owner_epoch", "input_proof"] if version >= 7 else []))
                states(db, "delegate_delivery_receipt", "state", RECEIPT_STATES)
                totals["enrolled"] = count(db, "delegate_jobs", "delivery_receipt_context IS NOT NULL")
                totals["receipts"] = count(db, "delegate_delivery_receipt")
            if version >= 9:
                shape(db, "delegate_retry_source", SOURCE_COLUMNS + (["storage_user_id"] if version >= 10 else []))
                shape(db, "delegate_retry_action", ACTION_COLUMNS)
                shape(db, "delegate_retry_parent_fence", ["user_id", "client_session_id", "deleted_at"])
                states(db, "delegate_retry_action", "state", ["accepted", "dispatched", "terminal", "source_deleted"])
                totals["sources"] = count(db, "delegate_retry_source")
                totals["actions"] = count(db, "delegate_retry_action")
                totals["parentFences"] = count(db, "delegate_retry_parent_fence")
            need_v2 = version >= 10 or any(v for k, v in totals.items() if k != "jobs")
            result = {"schema": version, "required": 2 if need_v2 else 1,
                      "absent": False, "counts": totals}
        db.rollback()
    finally:
        db.close()
    unchanged(value, identity)
    require(time.monotonic() < deadline)
    return result


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's default error quotes input paths; keep diagnostics private.
        raise Unknown()


def budget_expired(_signum, _frame):
    raise BudgetExpired()


def main():
    result = {"status": "unknown", "reason": "unreadable_or_invalid"}
    code = 2
    try:
        parser = Parser(description=__doc__)
        parser.add_argument("--database", action="append", required=True)
        parser.add_argument("--runtime-manifest", required=True)
        parser.add_argument("--master-metadata", required=True)
        parser.add_argument("--budget-ms", type=int, default=15000)
        args = parser.parse_args()
        require(len(args.database) <= MAX_DATABASES and 0 < args.budget_ms <= MAX_BUDGET_MS)
        signal.signal(signal.SIGALRM, budget_expired)
        signal.setitimer(signal.ITIMER_REAL, args.budget_ms / 1000)
        deadline = time.monotonic() + args.budget_ms / 1000
        runtime = candidate(args.runtime_manifest)
        master = candidate(args.master_metadata)
        snapshots = [inventory(path, deadline) for path in args.database]
        require(time.monotonic() < deadline)
        required = max(row["required"] for row in snapshots)
        compatible = runtime == master and runtime >= required
        result = {"status": "compatible" if compatible else "incompatible",
                  "runtime": runtime, "master": master, "required": required,
                  "databases": snapshots}
        code = 0 if compatible else 1
    except BudgetExpired:
        result = {"status": "unknown", "reason": "budget_exhausted"}
        code = 2
    except (Unknown, OSError, sqlite3.Error, ValueError, TypeError, RecursionError):
        result = {"status": "unknown", "reason": "unreadable_or_invalid"}
        code = 2
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps(result, separators=(",", ":")))
    return code


if __name__ == "__main__":
    sys.exit(main())
