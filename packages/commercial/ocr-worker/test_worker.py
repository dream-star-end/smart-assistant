#!/usr/bin/env python3
from __future__ import annotations

import http.client
import json
import os
import signal
import subprocess
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

    def test_ssh_stdout_disconnect_stops_supervisor_and_all_children(self) -> None:
        worker_dir = Path(__file__).resolve().parent
        state = self.root / "supervisor-state"
        fake_python = self.root / "fake-python"
        fake_python.write_text(
            """#!/bin/bash
set -euo pipefail
ready=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --ready ]]; then ready=$2; shift 2; else shift; fi
done
if [[ -n "$ready" ]]; then mkdir -p "$(dirname "$ready")"; : >"$ready"; fi
printf '%s\\n' "$$" >>"$FAKE_CHILD_PIDS"
exec sleep 300
""",
            encoding="utf-8",
        )
        fake_python.chmod(0o755)
        dtk_env = self.root / "dtk-env.sh"
        dtk_env.write_text(":\n", encoding="utf-8")
        child_pids = self.root / "child-pids"
        env = {
            **os.environ,
            "OC_OCR_ROOT": str(state),
            "OC_OCR_WORKER_TOKEN": "test-token",
            "OC_OCR_WORKER_RELEASE": "test-release",
            "OC_OCR_CARDS": "0",
            "OC_OCR_PP_PYTHON": str(fake_python),
            "OC_OCR_VL_PYTHON": str(fake_python),
            "OC_OCR_DET_MODEL": "det",
            "OC_OCR_REC_MODEL": "rec",
            "OC_OCR_VL_MODEL": "vl",
            "OC_OCR_PROBE_IMAGE": "probe",
            "OC_OCR_DTK_ENV": str(dtk_env),
            "OC_OCR_SSH_HEARTBEAT_SECONDS": "0.05",
            "FAKE_CHILD_PIDS": str(child_pids),
        }
        supervisor = subprocess.Popen(
            ["bash", str(worker_dir / "run-supervisor.sh")],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.time() + 5
            while time.time() < deadline:
                if child_pids.exists() and len(child_pids.read_text().splitlines()) == 3:
                    break
                time.sleep(0.02)
            self.assertTrue(child_pids.exists(), "fake model/server children did not start")
            pids = [int(value) for value in child_pids.read_text().splitlines()]
            self.assertEqual(len(pids), 3)
            assert supervisor.stdout is not None
            supervisor.stdout.close()
            self.assertNotEqual(supervisor.wait(timeout=5), 0)
            for pid in pids:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            self.assertEqual(list((state / "ready").iterdir()), [])
            self.assertEqual(list((state / "run").glob("*.sock")), [])
        finally:
            if supervisor.poll() is None:
                supervisor.send_signal(signal.SIGTERM)
                supervisor.wait(timeout=5)
            assert supervisor.stderr is not None
            supervisor.stderr.close()

    def test_host_tunnel_discards_only_heartbeat_stdout(self) -> None:
        source = (Path(__file__).resolve().parent / "host-tunnel.sh").read_text()
        self.assertIn('run-supervisor.sh\'" \\\n  >/dev/null', source)
        self.assertNotIn("2>/dev/null", source)


if __name__ == "__main__":
    unittest.main()
