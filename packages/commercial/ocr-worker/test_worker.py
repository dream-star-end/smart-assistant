#!/usr/bin/env python3
from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
import socket
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import Api, Handler
from worker_common import claim_job, cleanup_expired, connect, ensure_count, init_db, mark_terminal


TOKEN = "test-worker-token"
OWNER = "a" * 43


class WorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.api = Api(self.root, [0, 1], TOKEN, "test-release")
        for card in (0, 1):
            (self.api.ready / f"pp-{card}").write_text("ready")
            (self.api.ready / f"vl-{card}").write_text("ready")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.api = self.api
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, method: str, path: str, body: bytes = b"", headers: dict[str, str] | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        final = {"authorization": f"Bearer {TOKEN}", **(headers or {})}
        conn.request(method, path, body=body, headers=final)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, response.headers, data

    def submit(self, payload: bytes = b"fake-pdf") -> dict:
        status, _, data = self.request(
            "POST",
            "/v1/jobs",
            payload,
            {
                "x-ocr-owner": OWNER,
                "x-ocr-filename": "scan.pdf",
                "x-ocr-mode": "hybrid",
                "x-ocr-fallback": "0.10",
                "content-length": str(len(payload)),
            },
        )
        self.assertEqual(status, 202, data)
        return json.loads(data)

    def test_ready_submit_status_cancel_and_quota_release(self) -> None:
        status, _, body = self.request("GET", "/ready")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["cards"], [0, 1])
        job = self.submit()
        status, _, body = self.request("GET", f"/v1/jobs/{job['job_id']}", headers={"x-ocr-owner": OWNER})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "queued")
        status, _, body = self.request("POST", f"/v1/jobs/{job['job_id']}/cancel", b"{}", {"x-ocr-owner": OWNER})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "cancelled")
        db = connect(self.api.db_path)
        row = db.execute("SELECT source_bytes FROM jobs WHERE id=?", (job["job_id"],)).fetchone()
        db.close()
        self.assertEqual(row["source_bytes"], 0)

    def test_fifo_claim_across_cards_and_restart_recovery(self) -> None:
        first, second = self.submit(b"one"), self.submit(b"two")
        claimed0 = claim_job(self.api.db_path, 0)
        claimed1 = claim_job(self.api.db_path, 1)
        self.assertEqual(claimed0["id"], first["job_id"])
        self.assertEqual(claimed1["id"], second["job_id"])
        init_db(self.api.db_path)
        db = connect(self.api.db_path)
        rows = db.execute("SELECT id,status,pages_done FROM jobs ORDER BY created_at,id").fetchall()
        db.close()
        self.assertEqual([row["status"] for row in rows], ["queued", "queued"])
        self.assertEqual([row["pages_done"] for row in rows], [0, 0])

    def test_complete_result_is_streamed_without_truncation_then_expires(self) -> None:
        job = self.submit()
        job_id = job["job_id"]
        job_dir = self.api.jobs / job_id
        expected = ("完整页面\n" * 20000).encode()
        (job_dir / "result.md").write_bytes(expected)
        (job_dir / "result.jsonl").write_text('{"page":1,"text":"完整"}\n', encoding="utf-8")
        mark_terminal(self.api.db_path, self.api.jobs, job_id, "completed", None, 3600)
        status, headers, body = self.request("GET", f"/v1/jobs/{job_id}/result?format=markdown", headers={"x-ocr-owner": OWNER})
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["content-length"]), len(expected))
        self.assertEqual(body, expected)
        db = connect(self.api.db_path)
        db.execute("UPDATE jobs SET result_expires_at=? WHERE id=?", (time.time() - 1, job_id))
        db.close()
        cleanup_expired(self.api.db_path, self.api.jobs)
        status, _, _ = self.request("GET", f"/v1/jobs/{job_id}/result", headers={"x-ocr-owner": OWNER})
        self.assertEqual(status, 410)

    def test_auth_owner_isolation_and_active_job_limit(self) -> None:
        status, _, _ = self.request("GET", "/ready", headers={"authorization": "Bearer wrong"})
        self.assertEqual(status, 401)
        job = self.submit()
        status, _, _ = self.request("GET", f"/v1/jobs/{job['job_id']}", headers={"x-ocr-owner": "b" * 43})
        self.assertEqual(status, 404)
        self.api.owner_max_jobs = 1
        status, _, body = self.request(
            "POST", "/v1/jobs", b"second",
            {"x-ocr-owner": OWNER, "x-ocr-mode": "pp", "content-length": "6"},
        )
        self.assertEqual(status, 429, body)

    def test_declared_upload_that_ends_early_is_deleted_not_queued(self) -> None:
        self.api.disk_reserve = 0
        client = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5)
        request = (
            "POST /v1/jobs HTTP/1.1\r\n"
            f"Host: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n"
            f"X-OCR-Owner: {OWNER}\r\nX-OCR-Mode: pp\r\nContent-Length: 20\r\n\r\nabc"
        ).encode()
        client.sendall(request)
        client.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
        client.close()
        self.assertIn(b" 400 ", response.split(b"\r\n", 1)[0])
        db = connect(self.api.db_path)
        count = db.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        db.close()
        self.assertEqual(count, 0)
        self.assertEqual(list(self.api.jobs.iterdir()), [])

    def test_model_batch_count_mismatch_fails_loud(self) -> None:
        ensure_count("test stage", 2, 2)
        with self.assertRaisesRegex(RuntimeError, "refusing incomplete OCR"):
            ensure_count("test stage", 2, 1)


if __name__ == "__main__":
    unittest.main()
