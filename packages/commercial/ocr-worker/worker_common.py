#!/usr/bin/env python3
"""Shared durable queue primitives for the OpenClaude OCR worker."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from pathlib import Path


TERMINAL = {"completed", "failed", "cancelled"}
ACTIVE = {"uploading", "queued", "running"}


def ensure_count(stage: str, expected: int, actual: int) -> None:
    if actual != expected:
        raise RuntimeError(f"{stage} returned {actual} outputs for {expected} inputs; refusing incomplete OCR")


def connect(db_path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    return db


def init_db(db_path: Path) -> None:
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
    # A killed runner never owns a job indefinitely. Partial artifacts are
    # discarded by the next claimant before it starts from page one.
    now = time.time()
    db.execute(
        "UPDATE jobs SET status='queued', phase='recovered', current_card=NULL, "
        "cancel_requested=0, pages_done=0, started_at=NULL, updated_at=? WHERE status='running'",
        (now,),
    )
    db.close()


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
        "SELECT SUM(CASE WHEN status IN ('uploading','queued','running') THEN 1 ELSE 0 END) AS active, "
        "COALESCE(SUM(source_bytes + result_bytes),0) AS bytes FROM jobs WHERE owner=?",
        (owner,),
    ).fetchone()
    return int(row["active"] or 0), int(row["bytes"] or 0)


def queue_position(db: sqlite3.Connection, row: sqlite3.Row) -> int | None:
    if row["status"] != "queued":
        return None
    value = db.execute(
        "SELECT COUNT(*) AS n FROM jobs WHERE status='queued' AND (created_at < ? OR (created_at=? AND id<=?))",
        (row["created_at"], row["created_at"], row["id"]),
    ).fetchone()
    return int(value["n"])


def claim_job(db_path: Path, card: int) -> sqlite3.Row | None:
    db = connect(db_path)
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").fetchone()
    if row:
        now = time.time()
        changed = db.execute(
            "UPDATE jobs SET status='running',phase='starting',current_card=?,started_at=?,updated_at=? "
            "WHERE id=? AND status='queued'",
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
    }


def mark_terminal(db_path: Path, jobs_dir: Path, job_id: str, status: str, error: str | None, retention_s: int) -> None:
    assert status in TERMINAL
    job_dir = jobs_dir / job_id
    source = job_dir / "source"
    source.unlink(missing_ok=True)
    for path in job_dir.glob("page-*.jpg"):
        path.unlink(missing_ok=True)
    for path in job_dir.glob("crop-*.jpg"):
        path.unlink(missing_ok=True)
    now = time.time()
    db = connect(db_path)
    result_bytes = 0
    result_jsonl = result_md = None
    if status == "completed":
        jp = job_dir / "result.jsonl"
        mp = job_dir / "result.md"
        result_bytes = (jp.stat().st_size if jp.exists() else 0) + (mp.stat().st_size if mp.exists() else 0)
        result_jsonl, result_md = str(jp), str(mp)
    else:
        (job_dir / "result.jsonl.tmp").unlink(missing_ok=True)
        (job_dir / "result.md.tmp").unlink(missing_ok=True)
    db.execute(
        "UPDATE jobs SET status=?, phase=?, source_path=NULL, source_bytes=0, result_jsonl=?, result_md=?, "
        "result_bytes=?, current_card=NULL, error=?, completed_at=?, result_expires_at=?, updated_at=? WHERE id=?",
        (status, status, result_jsonl, result_md, result_bytes, error, now, now + retention_s, now, job_id),
    )
    db.close()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
