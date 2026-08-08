#!/usr/bin/env python3
"""Shared durable queue primitives for the OpenClaude OCR worker."""
from __future__ import annotations

import json
import hashlib
import os
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path


TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE = {"uploading", "queued", "waiting", "running"}


def ensure_count(stage: str, expected: int, actual: int) -> None:
    if actual != expected:
        raise RuntimeError(f"{stage} returned {actual} outputs for {expected} inputs; refusing incomplete OCR")


def connect(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    return db


def _add_column(db: sqlite3.Connection, name: str, declaration: str) -> None:
    columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)")}
    if name not in columns:
        db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {declaration}")


def init_db(db_path: Path, jobs_dir: Path | None = None) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = connect(db_path)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          filename TEXT NOT NULL,
          mode TEXT NOT NULL,
          fallback REAL NOT NULL,
          status TEXT NOT NULL,
          phase TEXT NOT NULL,
          source_path TEXT,
          source_bytes INTEGER NOT NULL DEFAULT 0,
          result_jsonl TEXT,
          result_md TEXT,
          result_bytes INTEGER NOT NULL DEFAULT 0,
          pages_total INTEGER,
          pages_done INTEGER NOT NULL DEFAULT 0,
          current_card INTEGER,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          started_at REAL,
          completed_at REAL,
          result_expires_at REAL
        );
        CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at, id);
        CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, status);
        """
    )
    _add_column(db, "request_id", "TEXT")
    _add_column(db, "contract_digest", "TEXT")
    _add_column(db, "source_sha256", "TEXT")
    _add_column(db, "retry_count", "INTEGER NOT NULL DEFAULT 0")
    _add_column(db, "next_retry_at", "REAL")
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_request "
        "ON jobs(owner,request_id) WHERE request_id IS NOT NULL"
    )
    # Recovery is deliberately split by durable cancellation intent. A killed
    # runner must never clear cancel_requested and resurrect canceled work.
    now = time.time()
    canceled = db.execute(
        "SELECT id FROM jobs WHERE status='running' AND cancel_requested=1"
    ).fetchall()
    db.execute(
        "UPDATE jobs SET status='cancelled',phase='cancelled',current_card=NULL,"
        "source_path=NULL,source_bytes=0,completed_at=?,result_expires_at=?,updated_at=? "
        "WHERE status='running' AND cancel_requested=1",
        (now, now + int(os.environ.get("OC_OCR_RESULT_RETENTION_SECONDS", str(7 * 86400))), now),
    )
    db.execute(
        "UPDATE jobs SET status='waiting', phase='recovered', current_card=NULL, "
        "next_retry_at=?, started_at=NULL, updated_at=? "
        "WHERE status='running' AND cancel_requested=0",
        (now, now),
    )
    db.execute(
        "UPDATE jobs SET status='cancelled',phase='cancelled',current_card=NULL,"
        "source_path=NULL,source_bytes=0,completed_at=?,result_expires_at=?,updated_at=? "
        "WHERE status='waiting' AND cancel_requested=1",
        (now, now + int(os.environ.get("OC_OCR_RESULT_RETENTION_SECONDS", str(7 * 86400))), now),
    )
    db.close()
    root = jobs_dir or db_path.parent / "jobs"
    for row in canceled:
        job_dir = root / row["id"]
        (job_dir / "source").unlink(missing_ok=True)
        shutil.rmtree(job_dir / "pages", ignore_errors=True)
        for name in ("page-manifest.json", "result.jsonl.tmp", "result.md.tmp"):
            (job_dir / name).unlink(missing_ok=True)
        for pattern in ("page-*.jpg", "crop-*.jpg"):
            for path in job_dir.glob(pattern):
                path.unlink(missing_ok=True)


def cleanup_expired(db_path: Path, jobs_dir: Path, now: float | None = None) -> int:
    now = time.time() if now is None else now
    db = connect(db_path)
    rows = db.execute(
        "SELECT id FROM jobs WHERE status IN ('completed','failed','cancelled') "
        "AND result_expires_at IS NOT NULL AND result_expires_at <= ?",
        (now,),
    ).fetchall()
    for row in rows:
        shutil.rmtree(jobs_dir / row["id"], ignore_errors=True)
        db.execute(
            "UPDATE jobs SET source_path=NULL, source_bytes=0, result_jsonl=NULL, result_md=NULL, "
            "result_bytes=0, phase='expired', updated_at=? WHERE id=?",
            (now, row["id"]),
        )
    db.close()
    return len(rows)


def owner_usage(db: sqlite3.Connection, owner: str) -> tuple[int, int]:
    row = db.execute(
        "SELECT SUM(CASE WHEN status IN ('uploading','queued','waiting','running') THEN 1 ELSE 0 END) AS active, "
        "COALESCE(SUM(source_bytes + result_bytes),0) AS bytes FROM jobs WHERE owner=?",
        (owner,),
    ).fetchone()
    return int(row["active"] or 0), int(row["bytes"] or 0)


def queue_position(db: sqlite3.Connection, row: sqlite3.Row) -> int | None:
    if row["status"] not in {"queued", "waiting"}:
        return None
    value = db.execute(
        "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','waiting') "
        "AND (status='queued' OR next_retry_at IS NULL OR next_retry_at<=?) "
        "AND (created_at < ? OR (created_at=? AND id<=?))",
        (time.time(), row["created_at"], row["created_at"], row["id"]),
    ).fetchone()
    return int(value["n"])


def claim_job(db_path: Path, card: int) -> sqlite3.Row | None:
    db = connect(db_path)
    db.execute("BEGIN IMMEDIATE")
    now = time.time()
    row = db.execute(
        "SELECT * FROM jobs WHERE status='queued' OR "
        "(status='waiting' AND (next_retry_at IS NULL OR next_retry_at<=?)) "
        "ORDER BY created_at,id LIMIT 1",
        (now,),
    ).fetchone()
    if row:
        changed = db.execute(
            "UPDATE jobs SET status='running',phase='starting',current_card=?,started_at=?,error=NULL,updated_at=? "
            "WHERE id=? AND status IN ('queued','waiting') AND cancel_requested=0",
            (card, now, now, row["id"]),
        ).rowcount
        row = db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone() if changed else None
    db.execute("COMMIT")
    db.close()
    return row


def public_status(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    elapsed = max(0.0, time.time() - float(row["started_at"] or time.time()))
    done = int(row["pages_done"] or 0)
    total = row["pages_total"]
    eta = None
    if done > 0 and total is not None and int(total) > done:
        eta = elapsed / done * (int(total) - done)
    return {
        "job_id": row["id"],
        "status": row["status"],
        "phase": row["phase"],
        "mode": row["mode"],
        "pages_total": total,
        "pages_done": done,
        "queue_position": queue_position(db, row),
        "eta_seconds": eta,
        "error": row["error"],
        "result_expires_at": row["result_expires_at"],
        "request_id": row["request_id"],
        "contract_digest": row["contract_digest"],
    }


def mark_terminal(db_path: Path, jobs_dir: Path, job_id: str, status: str, error: str | None, retention_s: int) -> None:
    assert status in TERMINAL
    job_dir = jobs_dir / job_id
    source = job_dir / "source"
    now = time.time()
    db = connect(db_path)
    result_bytes = 0
    result_jsonl = result_md = None
    if status == "completed":
        jp = job_dir / "result.jsonl"
        mp = job_dir / "result.md"
        result_bytes = (jp.stat().st_size if jp.exists() else 0) + (mp.stat().st_size if mp.exists() else 0)
        result_jsonl, result_md = str(jp), str(mp)
    db.execute(
        "UPDATE jobs SET status=?, phase=?, source_path=NULL, source_bytes=0, result_jsonl=?, result_md=?, "
        "result_bytes=?, current_card=NULL, error=?, completed_at=?, result_expires_at=?, updated_at=? WHERE id=?",
        (status, status, result_jsonl, result_md, result_bytes, error, now, now + retention_s, now, job_id),
    )
    db.close()
    # Cleanup follows the durable terminal row. A crash before the UPDATE must
    # leave every source/checkpoint required for recovery intact.
    source.unlink(missing_ok=True)
    for pattern in ("page-*.jpg", "crop-*.jpg"):
        for path in job_dir.glob(pattern):
            path.unlink(missing_ok=True)
    shutil.rmtree(job_dir / "pages", ignore_errors=True)
    (job_dir / "page-manifest.json").unlink(missing_ok=True)
    if status != "completed":
        (job_dir / "result.jsonl.tmp").unlink(missing_ok=True)
        (job_dir / "result.md.tmp").unlink(missing_ok=True)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_dir(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _checkpoint_identity(
    contract_digest: str, worker_release: str, pipeline_digest: str
) -> dict:
    if not contract_digest or not worker_release or not pipeline_digest:
        raise RuntimeError("OCR checkpoint identity is incomplete")
    return {
        "version": 2,
        "contract_digest": contract_digest,
        "worker_release": worker_release,
        "pipeline_digest": pipeline_digest,
    }


def load_page_checkpoints(
    job_dir: Path, contract_digest: str, worker_release: str, pipeline_digest: str
) -> list[dict]:
    manifest_path = job_dir / "page-manifest.json"
    if not manifest_path.exists():
        return []
    identity = _checkpoint_identity(contract_digest, worker_release, pipeline_digest)
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or any(raw.get(key) != value for key, value in identity.items()):
            shutil.rmtree(job_dir / "pages", ignore_errors=True)
            atomic_write(
                manifest_path,
                (json.dumps({**identity, "pages": []}) + "\n").encode(),
            )
            return []
        declared = raw.get("pages", [])
    except (OSError, ValueError):
        return []
    valid = []
    for expected, entry in enumerate(declared, 1):
        if not isinstance(entry, dict) or entry.get("page") != expected:
            break
        jp = job_dir / "pages" / f"page-{expected:08d}.jsonl"
        mp = job_dir / "pages" / f"page-{expected:08d}.md"
        try:
            if (
                jp.stat().st_size != entry.get("jsonl_size")
                or mp.stat().st_size != entry.get("md_size")
                or _file_sha256(jp) != entry.get("jsonl_sha256")
                or _file_sha256(mp) != entry.get("md_sha256")
            ):
                break
        except OSError:
            break
        valid.append(entry)
    if len(valid) != len(declared):
        atomic_write(
            manifest_path,
            (json.dumps({**identity, "pages": valid}, ensure_ascii=False) + "\n").encode(),
        )
    return valid


def publish_page_checkpoint(
    job_dir: Path, contract_digest: str, worker_release: str,
    pipeline_digest: str, page: int, payload: dict, markdown: str
) -> dict:
    identity = _checkpoint_identity(contract_digest, worker_release, pipeline_digest)
    entries = load_page_checkpoints(
        job_dir, contract_digest, worker_release, pipeline_digest
    )
    if page <= len(entries):
        return entries[page - 1]
    if page != len(entries) + 1:
        raise RuntimeError("OCR checkpoint pages must be published contiguously")
    pages = job_dir / "pages"
    jp = pages / f"page-{page:08d}.jsonl"
    mp = pages / f"page-{page:08d}.md"
    json_bytes = (json.dumps(payload, ensure_ascii=False) + "\n").encode()
    md_bytes = f"\n\n## Page {page}\n\n{markdown.rstrip()}\n".encode()
    atomic_write(jp, json_bytes)
    atomic_write(mp, md_bytes)
    entry = {
        "page": page,
        "jsonl_size": len(json_bytes),
        "jsonl_sha256": hashlib.sha256(json_bytes).hexdigest(),
        "md_size": len(md_bytes),
        "md_sha256": hashlib.sha256(md_bytes).hexdigest(),
    }
    entries.append(entry)
    atomic_write(
        job_dir / "page-manifest.json",
        (json.dumps({**identity, "pages": entries}, ensure_ascii=False) + "\n").encode(),
    )
    return entry


def assemble_page_checkpoints(
    job_dir: Path, contract_digest: str, worker_release: str,
    pipeline_digest: str, filename: str
) -> None:
    entries = load_page_checkpoints(
        job_dir, contract_digest, worker_release, pipeline_digest
    )
    json_data = b"".join(
        (job_dir / "pages" / f"page-{entry['page']:08d}.jsonl").read_bytes()
        for entry in entries
    )
    md_data = f"# OCR: {filename}\n".encode() + b"".join(
        (job_dir / "pages" / f"page-{entry['page']:08d}.md").read_bytes()
        for entry in entries
    )
    atomic_write(job_dir / "result.jsonl", json_data)
    atomic_write(job_dir / "result.md", md_data)


def mark_waiting(
    db_path: Path, jobs_dir: Path, job_id: str, error: str, retention_s: int
) -> None:
    db = connect(db_path)
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT retry_count,cancel_requested FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        db.execute("ROLLBACK")
        db.close()
        return
    if row["cancel_requested"]:
        now = time.time()
        db.execute(
            "UPDATE jobs SET status='cancelled',phase='cancelled',current_card=NULL,"
            "source_path=NULL,source_bytes=0,result_bytes=0,completed_at=?,result_expires_at=?,updated_at=? "
            "WHERE id=? AND status='running' AND cancel_requested=1",
            (now, now + retention_s, now, job_id),
        )
        db.execute("COMMIT")
        db.close()
        job_dir = jobs_dir / job_id
        (job_dir / "source").unlink(missing_ok=True)
        shutil.rmtree(job_dir / "pages", ignore_errors=True)
        (job_dir / "page-manifest.json").unlink(missing_ok=True)
        for pattern in ("page-*.jpg", "crop-*.jpg"):
            for path in job_dir.glob(pattern):
                path.unlink(missing_ok=True)
        return
    count = int(row["retry_count"] or 0) + 1
    delay = min(300.0, float(2 ** min(count, 8)))
    now = time.time()
    db.execute(
        "UPDATE jobs SET status='waiting',phase='waiting',current_card=NULL,retry_count=?,"
        "next_retry_at=?,error=?,updated_at=? WHERE id=? AND status='running' AND cancel_requested=0",
        (count, now + delay, error[:1000], now, job_id),
    )
    db.execute("COMMIT")
    db.close()
