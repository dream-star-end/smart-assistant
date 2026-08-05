import hashlib
import io
import json
import os
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from worker import Conflict, Handler, ThreadingHTTPServer, Worker, worker_bind_host


class Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class WorkerContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["H3_WORKER_STATE"] = self.tmp.name
        os.environ["H3_WORKER_RELEASE"] = str(Path(__file__).resolve().parents[2])
        os.environ["H3_WORKER_TOKEN"] = "test-token"
        os.environ.pop("H3_SESSION_SUPERVISOR_PID", None)
        os.environ.pop("H3_WORKER_HOST", None)
        os.environ.pop("H3_WORKER_ALLOW_PUBLIC_BIND", None)
        self.worker = Worker()

    def tearDown(self):
        self.worker.store.db.close()
        self.tmp.cleanup()

    def upload(self, job="job-1", attempt="attempt-1", fence=1, ordinal=0, data=b"image"):
        digest = hashlib.sha256(data).hexdigest()
        headers = Headers({
            "X-Content-SHA256": digest,
            "X-Content-Size": str(len(data)),
            "Content-Type": "image/png",
            "X-Input-Kind": "reference_image",
            "X-Input-Filename": "reference.png",
        })
        self.worker.put_input(job, attempt, fence, ordinal, headers, io.BytesIO(data))
        return digest

    def chunk_upload(
        self,
        data,
        full_data,
        offset,
        job="job-chunk",
        attempt="attempt-chunk",
        fence=1,
        ordinal=0,
        mime="application/octet-stream",
    ):
        digest = hashlib.sha256(full_data).hexdigest()
        headers = Headers({
            "X-Content-SHA256": digest,
            "X-Content-Size": str(len(full_data)),
            "Content-Length": str(len(data)),
            "Content-Type": mime,
            "X-Input-Kind": "reference_image",
            "X-Input-Filename": "chunked.bin",
            "X-Upload-Offset": str(offset),
        })
        self.worker.put_input(job, attempt, fence, ordinal, headers, io.BytesIO(data))
        return digest

    def running_attempt(self, job="job-running", attempt="attempt-running", resource="gpu-h3", request=None):
        if request is None:
            request = {"prompt": {"1": {"class_type": "Output", "inputs": {}}}}
        self.worker.store.ensure_staging(job, attempt, 1, resource)
        self.worker.store.submit(job, attempt, 1, resource, "d" * 64, request)
        return self.worker.store.start_execution(job, attempt)

    def server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.worker = self.worker
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        return server, thread

    @staticmethod
    def stop_server(server, thread):
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    def test_public_bind_requires_exact_explicit_opt_in(self):
        self.assertEqual(worker_bind_host(), "127.0.0.1")
        with patch.dict(os.environ, {"H3_WORKER_HOST": "0.0.0.0"}, clear=False):
            with self.assertRaisesRegex(SystemExit, "explicitly enabled"):
                worker_bind_host()
        with patch.dict(
            os.environ,
            {"H3_WORKER_HOST": "0.0.0.0", "H3_WORKER_ALLOW_PUBLIC_BIND": "1"},
            clear=False,
        ):
            self.assertEqual(worker_bind_host(), "0.0.0.0")
        with patch.dict(
            os.environ,
            {"H3_WORKER_HOST": "192.0.2.1", "H3_WORKER_ALLOW_PUBLIC_BIND": "1"},
            clear=False,
        ):
            with self.assertRaisesRegex(SystemExit, "loopback-only"):
                worker_bind_host()

    def test_session_lease_signal_is_pinned_to_supervisor_parent(self):
        with patch("worker.os.kill") as kill:
            self.worker.touch_session_lease()
        kill.assert_not_called()

        self.worker.session_supervisor_pid = 4321
        with (
            patch("worker.os.getppid", return_value=4321),
            patch("worker.os.kill") as kill,
        ):
            self.worker.touch_session_lease()
        kill.assert_called_once_with(4321, signal.SIGUSR1)

        with (
            patch("worker.os.getppid", return_value=1),
            patch("worker.os.kill") as kill,
        ):
            self.worker.touch_session_lease()
        kill.assert_not_called()

    def test_input_transfer_refreshes_session_lease_per_progress_chunk(self):
        data = b"x" * (2 * 64 * 1024 + 1)
        with patch.object(self.worker, "touch_session_lease") as touch:
            self.upload(job="lease-upload", attempt="a1", data=data)
        self.assertEqual(touch.call_count, 3)

    def test_input_transfer_uses_non_buffer_filling_read1(self):
        chunks = [b"abc", b"de"]

        class IncrementalStream:
            def read(self, _size):
                raise AssertionError("blocking read must not be used")

            def read1(self, _size):
                return chunks.pop(0)

        data = b"abcde"
        headers = Headers({
            "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
            "X-Content-Size": str(len(data)),
            "Content-Type": "application/octet-stream",
            "X-Input-Kind": "reference_image",
            "X-Input-Filename": "incremental.bin",
        })
        self.worker.put_input("lease-read1", "a1", 1, 0, headers, IncrementalStream())
        row = self.worker.store.inputs("lease-read1", "a1")[0]
        self.assertEqual(Path(row["path"]).read_bytes(), data)

    def test_chunked_input_is_immutable_idempotent_and_published_only_when_complete(self):
        payload = b"abcdefghij"
        self.chunk_upload(payload[:4], payload, 0)
        self.chunk_upload(payload[:4], payload, 0)
        upload_dir = self.worker._attempt_dir("job-chunk", "attempt-chunk") / "inputs/.upload-000"
        self.assertEqual(len(list(upload_dir.glob("*.chunk"))), 1)
        self.assertEqual(self.worker.store.inputs("job-chunk", "attempt-chunk"), [])

        self.chunk_upload(payload[4:8], payload, 4)
        self.chunk_upload(payload[8:], payload, 8)
        rows = self.worker.store.inputs("job-chunk", "attempt-chunk")
        self.assertEqual(len(rows), 1)
        self.assertEqual(Path(rows[0]["path"]).read_bytes(), payload)
        self.assertFalse(upload_dir.exists())

        self.chunk_upload(payload[:4], payload, 0)
        self.assertEqual(len(self.worker.store.inputs("job-chunk", "attempt-chunk")), 1)

    def test_chunked_input_rejects_gaps_overlaps_and_manifest_drift_without_committing_them(self):
        payload = b"abcdefghij"
        self.chunk_upload(payload[:4], payload, 0)
        upload_dir = self.worker._attempt_dir("job-chunk", "attempt-chunk") / "inputs/.upload-000"
        committed = [(path.name, path.read_bytes()) for path in upload_dir.glob("*.chunk")]

        with self.assertRaisesRegex(Conflict, "upload_offset_conflict"):
            self.chunk_upload(payload[8:], payload, 8)
        with self.assertRaisesRegex(Conflict, "upload_offset_conflict"):
            self.chunk_upload(payload[2:6], payload, 2)
        with self.assertRaisesRegex(Conflict, "upload_manifest_conflict"):
            self.chunk_upload(payload[4:8], payload, 4, mime="image/png")
        self.assertEqual([(path.name, path.read_bytes()) for path in upload_dir.glob("*.chunk")], committed)

    def test_chunked_input_short_body_commits_nothing_and_whole_sha_failure_resets_cleanly(self):
        payload = b"abcdef"
        headers = Headers({
            "X-Content-SHA256": hashlib.sha256(payload).hexdigest(),
            "X-Content-Size": str(len(payload)),
            "Content-Length": "4",
            "Content-Type": "application/octet-stream",
            "X-Input-Kind": "reference_image",
            "X-Input-Filename": "chunked.bin",
            "X-Upload-Offset": "0",
        })
        with self.assertRaisesRegex(ValueError, "short_input_stream"):
            self.worker.put_input("short", "a1", 1, 0, headers, io.BytesIO(b"ab"))
        short_inputs = self.worker._attempt_dir("short", "a1") / "inputs"
        self.assertEqual(list(short_inputs.iterdir()), [])

        self.chunk_upload(b"abcX", payload, 0)
        with self.assertRaisesRegex(ValueError, "input_sha256_mismatch"):
            self.chunk_upload(payload[4:], payload, 4)
        upload_dir = self.worker._attempt_dir("job-chunk", "attempt-chunk") / "inputs/.upload-000"
        self.assertFalse(upload_dir.exists())
        self.assertEqual(self.worker.store.inputs("job-chunk", "attempt-chunk"), [])

        self.chunk_upload(payload[:4], payload, 0)
        self.chunk_upload(payload[4:], payload, 4)
        row = self.worker.store.inputs("job-chunk", "attempt-chunk")[0]
        self.assertEqual(Path(row["path"]).read_bytes(), payload)

    def test_ack_wins_after_chunk_body_lands_without_recreating_attempt_artifacts(self):
        payload = b"abcdefgh"
        digest = hashlib.sha256(payload).hexdigest()
        headers = Headers({
            "X-Content-SHA256": digest,
            "X-Content-Size": str(len(payload)),
            "Content-Length": str(len(payload)),
            "Content-Type": "application/octet-stream",
            "X-Input-Kind": "reference_image",
            "X-Input-Filename": "chunked.bin",
            "X-Upload-Offset": "0",
        })
        job_id = "job-ack-race"
        attempt_id = "attempt-ack-race"
        errors = []

        def upload():
            try:
                self.worker.put_input(
                    job_id, attempt_id, 1, 0, headers, io.BytesIO(payload)
                )
            except Exception as exc:
                errors.append(exc)

        directory = self.worker._attempt_dir(job_id, attempt_id)
        with self.worker.upload_lock:
            thread = threading.Thread(target=upload)
            thread.start()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                pending = list((directory / "inputs").glob(".upload-000-pending-*"))
                if pending and pending[0].stat().st_size == len(payload):
                    break
                time.sleep(0.01)
            else:
                self.fail("chunk body did not land before timeout")
            self.assertTrue(
                self.worker.store.cas_terminal(job_id, attempt_id, 1, "canceled")
            )
            self.worker.ack(job_id, attempt_id, 1)

        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], Conflict)
        self.assertEqual(str(errors[0]), "attempt_not_staging")
        self.assertFalse(directory.exists())
        self.assertEqual(self.worker.store.inputs(job_id, attempt_id), [])

    def test_chunked_input_recovers_final_publish_before_database_registration(self):
        payload = b"abcdefgh"
        self.chunk_upload(payload[:4], payload, 0)
        with patch.object(self.worker.store, "put_input", side_effect=RuntimeError("lost-db-write")):
            with self.assertRaisesRegex(RuntimeError, "lost-db-write"):
                self.chunk_upload(payload[4:], payload, 4)
        self.assertEqual(self.worker.store.inputs("job-chunk", "attempt-chunk"), [])

        self.chunk_upload(payload[:4], payload, 0)
        row = self.worker.store.inputs("job-chunk", "attempt-chunk")[0]
        self.assertEqual(Path(row["path"]).read_bytes(), payload)

    def test_only_authenticated_requests_refresh_session_lease(self):
        server, thread = self.server()
        url = f"http://127.0.0.1:{server.server_port}/v1/health"
        try:
            with patch.object(self.worker, "touch_session_lease") as touch:
                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(url, timeout=5)
                self.assertEqual(unauthorized.exception.code, 401)
                touch.assert_not_called()

                request = Request(url, headers={"Authorization": "Bearer test-token"})
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    response.read()
                touch.assert_called_once()
        finally:
            self.stop_server(server, thread)

    def test_exact_root_readiness_is_public_without_refreshing_session_lease(self):
        server, thread = self.server()
        root = f"http://127.0.0.1:{server.server_port}/"
        try:
            with patch.object(self.worker, "touch_session_lease") as touch:
                with urlopen(root, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response), {"ok": True})
                touch.assert_not_called()

                with self.assertRaises(HTTPError) as unauthorized:
                    urlopen(f"{root}?probe=1", timeout=5)
                self.assertEqual(unauthorized.exception.code, 401)
                touch.assert_not_called()
        finally:
            self.stop_server(server, thread)

    def test_result_transfer_refreshes_session_lease_per_progress_chunk(self):
        job = "lease-result"
        attempt = "a1"
        self.worker.store.ensure_staging(job, attempt, 1)
        directory = self.worker._attempt_dir(job, attempt)
        directory.mkdir(parents=True, exist_ok=True)
        payload = b"v" * (2 * 64 * 1024 + 1)
        result = directory / "result.mp4"
        result.write_bytes(payload)
        self.worker.store.cas_terminal(
            job, attempt, 1, "completed",
            result_path=str(result),
            result_sha256=hashlib.sha256(payload).hexdigest(),
            result_size=len(payload),
        )

        server, thread = self.server()
        request = Request(
            f"http://127.0.0.1:{server.server_port}/v1/attempts/{job}/{attempt}/result",
            headers={"Authorization": "Bearer test-token", "X-Fence-Version": "1"},
        )
        try:
            with patch.object(self.worker, "touch_session_lease") as touch:
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(response.read(), payload)
                self.assertEqual(touch.call_count, 4)
        finally:
            self.stop_server(server, thread)

    def test_input_is_immutable_and_fenced(self):
        digest = self.upload()
        self.upload()
        row = self.worker.store.inputs("job-1", "attempt-1")[0]
        self.assertEqual(row["sha256"], digest)
        with self.assertRaises(Conflict):
            self.upload(fence=2)
        with self.assertRaises(Conflict):
            self.upload(data=b"different")

    def test_submit_is_idempotent_and_resource_is_exclusive(self):
        self.upload()
        self.worker._execute = lambda *_args: None
        request = {"prompt": {"1": {"class_type": "Output", "inputs": {}}}}
        body = {"fence_version": 1, "resource_class": "gpu-h3", "request": request}
        first = self.worker.submit("job-1", "attempt-1", body)
        second = self.worker.submit("job-1", "attempt-1", body)
        self.assertEqual(first["job_id"], second["job_id"])
        self.worker.store.ensure_staging("job-2", "attempt-2", 1)
        with self.assertRaises(Conflict):
            self.worker.store.submit("job-2", "attempt-2", 1, "gpu-h3", "d" * 64, {})

    def test_old_fence_cannot_cancel_or_publish(self):
        self.worker.store.ensure_staging("job-1", "attempt-1", 7)
        with self.assertRaises(Conflict):
            self.worker.cancel("job-1", "attempt-1", 6)
        self.assertFalse(self.worker.store.cas_terminal("job-1", "attempt-1", 6, "completed"))
        self.assertTrue(self.worker.store.cas_terminal("job-1", "attempt-1", 7, "canceled"))
        self.assertFalse(self.worker.store.cas_terminal("job-1", "attempt-1", 7, "completed"))

    def test_recovery_restarts_durably_queued_attempt(self):
        self.worker.store.ensure_staging("job-queued", "attempt-queued", 1)
        self.worker.store.submit(
            "job-queued", "attempt-queued", 1, "gpu-h3", "d" * 64,
            {"prompt": {"1": {"class_type": "Output", "inputs": {}}}},
        )
        with patch("worker.threading.Thread") as thread:
            self.worker._recover()
        thread.assert_called_once()
        self.assertEqual(thread.call_args.kwargs["target"], self.worker._execute)
        self.assertEqual(thread.call_args.kwargs["args"], ("job-queued", "attempt-queued"))

    def test_queued_cancellation_cannot_be_resurrected_by_execution_thread(self):
        self.worker.store.ensure_staging("job-cancel", "attempt-cancel", 1)
        self.worker.store.submit(
            "job-cancel", "attempt-cancel", 1, "gpu-h3", "d" * 64,
            {"prompt": {"1": {"class_type": "Output", "inputs": {}}}},
        )
        canceled = self.worker.cancel("job-cancel", "attempt-cancel", 1)
        self.assertEqual(canceled["status"], "canceled")
        with patch.object(self.worker, "_execute_h3") as execute:
            self.worker._execute("job-cancel", "attempt-cancel")
        execute.assert_not_called()
        self.assertEqual(self.worker.store.row("job-cancel", "attempt-cancel")["status"], "canceled")

    def test_staging_cancellation_is_terminal_and_cannot_be_submitted(self):
        self.upload(job="job-staging", attempt="attempt-staging")
        canceled = self.worker.cancel("job-staging", "attempt-staging", 1)
        self.assertEqual(canceled["status"], "canceled")
        with self.assertRaisesRegex(Conflict, "attempt_not_staging"):
            self.worker.store.submit(
                "job-staging", "attempt-staging", 1, "gpu-h3", "d" * 64,
                {"prompt": {"1": {"class_type": "Output", "inputs": {}}}},
            )

    def test_running_cancellation_signals_process_group_before_terminal_ack_scrub(self):
        row = self.running_attempt(
            job="job-running-cancel", attempt="attempt-running-cancel",
            request={"prompt": {"secret": "private prompt"}},
        )
        self.worker.store.update(
            row["job_id"], row["attempt_id"], pid=4321, pid_start_ticks=99,
        )
        with (
            patch.object(self.worker, "_process_matches", return_value=True),
            patch("worker.os.killpg") as killpg,
        ):
            canceling = self.worker.cancel(row["job_id"], row["attempt_id"], 1)
        killpg.assert_called_once_with(4321, signal.SIGTERM)
        self.assertEqual(canceling["status"], "running")
        self.assertIsNotNone(
            self.worker.store.row(row["job_id"], row["attempt_id"])["cancel_requested_at"]
        )

        self.assertTrue(
            self.worker.store.cas_terminal(
                row["job_id"], row["attempt_id"], 1, "canceled",
                pid=None, pid_start_ticks=None,
            )
        )
        self.worker.ack(row["job_id"], row["attempt_id"], 1)
        scrubbed = self.worker.store.row(row["job_id"], row["attempt_id"])
        self.assertEqual(scrubbed["status"], "canceled")
        self.assertIsNone(scrubbed["request_json"])
        self.assertIsNotNone(scrubbed["acked_at"])

    def test_ack_deletes_artifacts_and_scrubs_sensitive_database_fields(self):
        self.upload(job="job-ack", attempt="attempt-ack", data=b"private image")
        self.worker.store.submit(
            "job-ack", "attempt-ack", 1, "gpu-h3", "d" * 64,
            {"prompt": {"secret": "private prompt"}},
        )
        directory = self.worker._attempt_dir("job-ack", "attempt-ack")
        result = directory / "result.mp4"
        result.write_bytes(b"video")
        self.worker.store.cas_terminal(
            "job-ack", "attempt-ack", 1, "completed",
            result_path=str(result), result_sha256=hashlib.sha256(b"video").hexdigest(),
            result_size=5,
        )

        self.worker.ack("job-ack", "attempt-ack", 1)

        row = self.worker.store.row("job-ack", "attempt-ack")
        self.assertFalse(directory.exists())
        self.assertEqual(self.worker.store.inputs("job-ack", "attempt-ack"), [])
        self.assertIsNone(row["request_json"])
        self.assertIsNone(row["result_path"])
        self.assertIsNotNone(row["acked_at"])
        self.assertEqual(row["request_digest"], "d" * 64)

    def test_ack_does_not_confirm_when_artifact_deletion_fails(self):
        self.upload(job="job-ack-fail", attempt="attempt-ack-fail", data=b"private image")
        self.worker.store.cas_terminal("job-ack-fail", "attempt-ack-fail", 1, "failed")
        with patch("worker.shutil.rmtree", side_effect=OSError("disk error")):
            with self.assertRaisesRegex(OSError, "disk error"):
                self.worker.ack("job-ack-fail", "attempt-ack-fail", 1)
        row = self.worker.store.row("job-ack-fail", "attempt-ack-fail")
        self.assertIsNone(row["acked_at"])
        self.assertEqual(len(self.worker.store.inputs("job-ack-fail", "attempt-ack-fail")), 1)

    def test_continuity_frame_is_last_decoded_frame(self):
        target = Path(self.tmp.name) / "continuity-last.png"

        class FakeImage:
            def save(self, path, format):
                self.asserted = format
                Path(path).write_bytes(b"last-frame")

        class FakeFrame:
            def __init__(self, value):
                self.value = value

            def to_image(self):
                image = FakeImage()
                image.save = lambda path, format: Path(path).write_bytes(self.value)
                return image

        class FakeContainer:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def decode(self, video):
                self.video = video
                return iter((FakeFrame(b"first"), FakeFrame(b"last")))

        fake_av = type("FakeAv", (), {"open": staticmethod(lambda _path: FakeContainer())})
        with patch.dict("sys.modules", {"av": fake_av}):
            self.worker._extract_continuity_frame(Path("source.mp4"), target)
        self.assertEqual(target.read_bytes(), b"last")
        self.assertFalse(target.with_suffix(".part.png").exists())

    def test_recovered_h3_attempt_releases_ranks_before_terminal_completion(self):
        row = self.running_attempt()
        directory = self.worker._attempt_dir(row["job_id"], row["attempt_id"])
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "coordinator-result.json").write_text("{}")
        result = directory / "result.mp4"
        events = []
        terminal = self.worker.store.cas_terminal

        def publish(_row, _coordinator_result):
            result.write_bytes(b"video")
            return result

        def stop_ranks():
            events.append("stop")

        def record_terminal(*args, **kwargs):
            events.append("terminal")
            return terminal(*args, **kwargs)

        with (
            patch.object(self.worker, "_process_matches", return_value=False),
            patch.object(self.worker, "_publish_h3_result", side_effect=publish),
            patch.object(self.worker, "_stop_ranks", side_effect=stop_ranks),
            patch.object(self.worker.store, "cas_terminal", side_effect=record_terminal),
        ):
            self.worker._monitor_recovered(dict(row))
        recovered = self.worker.store.row(row["job_id"], row["attempt_id"])
        self.assertEqual(events, ["stop", "terminal"])
        self.assertEqual(recovered["status"], "completed")
        self.assertEqual(recovered["result_sha256"], hashlib.sha256(b"video").hexdigest())
        self.assertIsNone(recovered["pid"])
        self.assertIsNone(recovered["pid_start_ticks"])

    def test_gpu_cleanup_failure_keeps_resource_poisoned_and_retries(self):
        row = self.running_attempt(job="poison", attempt="attempt-poison")
        self.worker.store.update(row["job_id"], row["attempt_id"], cancel_requested_at=1)
        with (
            patch.object(self.worker, "_process_matches", return_value=False),
            patch.object(self.worker, "_stop_ranks", side_effect=RuntimeError("still allocated")),
            patch.object(self.worker, "_schedule_recovery_retry") as retry,
        ):
            self.worker._monitor_recovered(dict(row))
        poisoned = self.worker.store.row(row["job_id"], row["attempt_id"])
        self.assertEqual(poisoned["status"], "running")
        self.assertEqual(poisoned["phase"], "gpu_cleanup_failed")
        self.assertEqual(poisoned["error_code"], "gpu_cleanup_failed")
        retry.assert_called_once()
        self.worker.store.ensure_staging("next", "attempt-next", 1)
        with self.assertRaisesRegex(Conflict, "resource_busy"):
            self.worker.store.submit(
                "next", "attempt-next", 1, "gpu-h3", "e" * 64,
                {"prompt": {"1": {"class_type": "Output", "inputs": {}}}},
            )

    def test_process_reattach_rejects_reused_or_unrelated_pid(self):
        row = dict(self.running_attempt(resource="cpu-compose", request={"mode": "normalize"}))
        process = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            row["pid"] = process.pid
            row["pid_start_ticks"] = 1
            with patch("worker.pid_start_ticks", return_value=2):
                self.assertFalse(self.worker._process_matches(row))
            row["pid_start_ticks"] = __import__("worker").pid_start_ticks(process.pid)
            self.assertFalse(self.worker._process_matches(row))
        finally:
            process.terminate()
            process.wait(timeout=5)

    def test_compose_rejects_options_the_worker_does_not_implement(self):
        unsupported = self.running_attempt(
            job="compose-option", attempt="attempt-option", resource="cpu-compose",
            request={"mode": "normalize", "fps": 30},
        )
        with self.assertRaisesRegex(ValueError, "unsupported_compose_option"):
            self.worker._execute_compose(unsupported)
        self.worker.store.update(
            unsupported["job_id"], unsupported["attempt_id"],
            request_json=json.dumps({"mode": "transition"}),
        )
        bad_mode = self.worker.store.row(unsupported["job_id"], unsupported["attempt_id"])
        with self.assertRaisesRegex(ValueError, "unsupported_compose_mode"):
            self.worker._execute_compose(bad_mode)


if __name__ == "__main__":
    unittest.main()
