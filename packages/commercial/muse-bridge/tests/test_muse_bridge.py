import base64, hashlib, importlib.util, json, os, signal, subprocess, sys, tempfile, threading, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.environ.get("MUSE_BRIDGE_PATH") or os.path.join(HERE, "..", "muse_bridge.py")
FAKE = os.path.join(HERE, "fake-media-generation")
spec = importlib.util.spec_from_file_location("mb", BRIDGE); mb = importlib.util.module_from_spec(spec); spec.loader.exec_module(mb)
sys.path.insert(0, HERE); import mock_master as mm
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LEGACY = ("--image-file", "--image-id", "--reference-image-file", "--reference-image-id")
SUBAGENT = ("--media-subagent-output-type", "--conversation-json", "--resume-from-snapshot-id")
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"1" * 100
def b64(b): return base64.b64encode(b).decode()
def argv_lines(path):
    with open(path) as f: return [json.loads(l) for l in f]

class Pure(unittest.TestCase):
    L = mb.effective_limits()
    def test_argv_unicode_and_whitelist(self):
        job = mb.validate_job({"id": "j1", "kind": "image", "prompt": '红狐 "quote"\n🦊', "orientation": "square",
                               "aspect_ratio": "4:5", "image_format": "png", "evil": "--upload-only"}, self.L)
        argv = mb.build_argv("/x/cli", job, "/o")
        self.assertEqual(json.loads(argv[argv.index("--conversation-json") + 1]), [{"text": '红狐 "quote"\n🦊'}])
        self.assertNotIn("--upload-only", argv); self.assertIn("--image-output-format", argv)
    def test_video_timeout_floor_and_clamp(self):
        self.assertEqual(mb.validate_job({"id": "v", "kind": "video", "prompt": "x"}, self.L)["timeout_secs"], 300)
        self.assertEqual(mb.validate_job({"id": "v", "kind": "video", "prompt": "x", "timeout_secs": 60}, self.L)["timeout_secs"], 300)
        self.assertEqual(mb.validate_job({"id": "v", "kind": "video", "prompt": "x", "timeout_secs": 9999}, self.L)["timeout_secs"], 600)
        v = mb.validate_job({"id": "v", "kind": "video", "prompt": "x", "orientation": "landscape"}, self.L)
        argv = mb.build_argv("/c", v, "/o")
        self.assertNotIn("--image-output-format", argv)
        with self.assertRaises(mb.JobError) as c:
            mb.validate_job({"id": "v", "kind": "video", "prompt": "x", "image_format": "png"}, self.L)
        self.assertEqual(c.exception.code, "MUSE_INVALID_INPUT")
    def test_check_binary_body_ok_and_short_and_bad_cr(self):
        class H(dict):
            def get(self, k, default=None):
                return dict.get(self, k, default)
        payload = b"x" * 10
        ok_h = H({"Content-Range": "bytes 0-9/100"})
        mb._check_binary_body(payload, ok_h, "bytes=0-9", 10)
        with self.assertRaises(IOError) as c:
            mb._check_binary_body(payload[:5], ok_h, "bytes=0-9", 10)
        self.assertIn("short read", str(c.exception))
        bad_h = H({"Content-Range": "bytes 1-10/100"})
        with self.assertRaises(IOError) as c2:
            mb._check_binary_body(payload, bad_h, "bytes=0-9", 10)
        self.assertIn("Content-Range mismatch", str(c2.exception))
        with self.assertRaises(IOError) as c3:
            mb._check_binary_body(payload, H({}), "bytes=0-9", 10)
        self.assertIn("Content-Range", str(c3.exception))
        expected = "bytes 0-9/100"
        mb._check_binary_body(payload, ok_h, "bytes=0-9", 10, expected_content_range=expected)
        with self.assertRaises(IOError) as c4:
            mb._check_binary_body(payload, ok_h, "bytes=0-9", 10, expected_content_range="bytes 0-9/999")
        self.assertIn("Content-Range mismatch", str(c4.exception))
    def test_two_step_argv(self):
        job = mb.validate_job({"id": "e", "kind": "image", "prompt": "make it blue", "image_format": "png",
                               "source_images": [{"base64": b64(PNG)}, {"base64": b64(WEBP)}],
                               "resume_snapshot_id": "5421fa39-fc25:v6485l"}, self.L)
        self.assertEqual([e for _, e in job["source_images"]], ["png", "webp"])
        up = mb.build_upload_argv("/c", ["/u/1.png", "/u/2.webp"], "/u")
        self.assertEqual(up, ["/c", "--upload-only", "--image-file", "/u/1.png", "--image-file", "/u/2.webp", "--output-dir", "/u"])
        gen = mb.build_argv("/c", job, "/o", ["11", "22"])
        self.assertFalse(any(x in gen for x in LEGACY))
        self.assertEqual(json.loads(gen[gen.index("--conversation-json") + 1]), [{"image": "11"}, {"image": "22"}, {"text": "make it blue"}])
        self.assertEqual(gen[gen.index("--resume-from-snapshot-id") + 1], "5421fa39-fc25:v6485l")
    def test_source_and_snapshot_validation(self):
        bad = [{"source_images": {"base64": b64(PNG)}}, {"source_images": [{"base64": b64(PNG)}] * 5},
               {"source_images": [{"base64": b64(b"GIF89a")}]}, {"source_images": [{"base64": "!!"}]},
               {"resume_snapshot_id": "a b"}, {"resume_snapshot_id": "--output-dir"[:0]}, {"resume_snapshot_id": 5}]
        for extra in bad:
            j = {"id": "a", "kind": "image", "prompt": "x"}; j.update(extra)
            with self.assertRaises(mb.JobError, msg=str(extra)[:60]) as c: mb.validate_job(j, self.L)
            self.assertEqual(c.exception.code, "MUSE_INVALID_INPUT")
    def test_source_refs_validation(self):
        ref = {"n": 0, "bytes": len(PNG), "sha256": hashlib.sha256(PNG).hexdigest(), "mime": "image/png"}
        base = {"id": "refs", "kind": "image", "prompt": "x", "source_refs": [ref]}
        self.assertEqual(mb.validate_job(base, self.L)["source_refs"], [ref])
        for patch in ({"n": True}, {"n": 1}, {"bytes": 0}, {"bytes": self.L["source_max_bytes"] + 1},
                      {"sha256": "bad"}, {"mime": "video/mp4"}):
            with self.assertRaises(mb.JobError):
                mb.validate_job(dict(base, source_refs=[dict(ref, **patch)]), self.L)
        with self.assertRaises(mb.JobError):
            mb.validate_job(dict(base, source_images=[{"base64": b64(PNG)}]), self.L)
    def test_upload_mapping(self):
        self.assertEqual(mb.map_upload_outcome(0, json.dumps({"image_ids": ["1", 2], "upload_count": 2}), "", 2), ["1", "2"])
        for rc, out, n in ((0, json.dumps({"image_ids": ["1"]}), 2), (0, json.dumps({"image_ids": ["a b"]}), 1),
                           (1, "", 1), (0, "garbage", 1)):
            with self.assertRaises(mb.JobError) as c: mb.map_upload_outcome(rc, out, "err", n)
            self.assertEqual(c.exception.code, "MUSE_UPLOAD_FAILED")
        with self.assertRaises(mb.JobError) as c:
            mb.map_upload_outcome(1, json.dumps({"ok": False, "retryable": True, "error_code": "x"}), "", 1)
        self.assertTrue(c.exception.retryable)
    def test_upload_failure_stops_before_generation(self):
        log = tempfile.mktemp(); os.environ["FAKE_ARGV_LOG"] = log; os.environ["FAKE_UPLOAD_FAIL"] = "1"
        try:
            job = mb.validate_job({"id": "u", "kind": "video", "prompt": "x", "source_images": [{"base64": b64(PNG)}]}, self.L)
            with self.assertRaises(mb.JobError) as c:
                mb.CliRunner(FAKE).run(job, tempfile.mkdtemp(), threading.Event())
            self.assertEqual((c.exception.code, c.exception.retryable), ("MUSE_UPLOAD_FAILED", True))
            self.assertEqual(len(argv_lines(log)), 1)
        finally:
            del os.environ["FAKE_UPLOAD_FAIL"]; del os.environ["FAKE_ARGV_LOG"]
    def test_invalid(self):
        for j in ({"id": "a b", "kind": "image", "prompt": "x"}, {"id": "a", "kind": "audio", "prompt": "x"},
                  {"id": "a", "kind": "image", "prompt": " "}, {"id": "a", "kind": "image", "prompt": "x" * 4001},
                  {"id": "a", "kind": "image", "prompt": "x", "orientation": "diagonal"}):
            with self.assertRaises(mb.JobError) as c: mb.validate_job(j, self.L)
            self.assertEqual(c.exception.code, "MUSE_INVALID_INPUT")
    def test_mapping(self):
        def code(rc, out, err=""):
            try: mb.map_cli_outcome(rc, out, err); return "OK"
            except mb.JobError as e: return (e.code, e.retryable)
        self.assertEqual(code(1, json.dumps({"ok": False, "error_code": "video_not_available"})), ("MUSE_VIDEO_REGION_BLOCKED", False))
        self.assertEqual(code(1, json.dumps({"ok": False, "error_code": "x", "retryable": True})), ("MUSE_UPSTREAM_ERROR", True))
        self.assertEqual(code(1, json.dumps({"ok": False, "error_code": "x"})), ("MUSE_UPSTREAM_REJECTED", False))
        self.assertEqual(code(2, ""), ("MUSE_BAD_ARGS", False))
        self.assertEqual(code(0, "not json"), ("MUSE_BAD_OUTPUT", False))
        self.assertEqual(code(0, json.dumps({"ok": True, "media_paths": []})), ("MUSE_BAD_OUTPUT", False))
        self.assertEqual(code(0, "log line\n" + json.dumps({"ok": True, "media_paths": ["/a"]})), "OK")
    def test_server_limits_clamped(self):
        l = mb.effective_limits({"video_max_bytes": 10 ** 12, "chunk_bytes": "x", "max_files": 2})
        self.assertEqual(l["video_max_bytes"], mb.HARD_LIMITS["video_max_bytes"]); self.assertEqual(l["chunk_bytes"], 4 * mb.MIB)
        self.assertEqual(l["max_files"], 2)
    def test_normalize_server(self):
        self.assertEqual(mb.normalize_server("https://a.trycloudflare.com/x/"), "https://a.trycloudflare.com")
        for bad in ("http://evil.com", "ftp://a", "https://"):
            with self.assertRaises(ValueError): mb.normalize_server(bad)
    def test_timeout_kills_process_group(self):
        mb.KILL_GRACE_SEC = 1
        d = tempfile.mkdtemp()
        t0 = time.time()
        with self.assertRaises(mb.JobError) as c:
            mb.CliRunner(FAKE).run({"id": "t", "kind": "image", "prompt": "sleep", "timeout_secs": 1}, d, threading.Event())
        self.assertEqual(c.exception.code, "MUSE_TIMEOUT"); self.assertLess(time.time() - t0, 6)
    def test_cli_missing(self):
        with self.assertRaises(mb.JobError) as c:
            mb.CliRunner("/nonexistent/cli").run({"id": "t", "kind": "image", "prompt": "x", "timeout_secs": 30}, tempfile.mkdtemp(), threading.Event())
        self.assertEqual(c.exception.code, "MUSE_CLI_MISSING")

class E2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = mm.start(); cls.url = "http://127.0.0.1:%d" % cls.srv.server_port
        cls.home = tempfile.mkdtemp(); os.chmod(cls.home, 0o700)
        with open(os.path.join(cls.home, "token"), "w") as f: f.write(mm.TOKEN)
        cls.argvlog = os.path.join(cls.home, "argv.log")
        env = dict(os.environ, FAKE_ARGV_LOG=cls.argvlog)
        open(cls.argvlog, "w").close()
        cls.proc = subprocess.Popen([sys.executable, "-I", BRIDGE, "--state-dir", cls.home, "--cli", FAKE, "run", "--server", cls.url],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        for _ in range(50):
            if mm.S.session: break
            time.sleep(0.2)
    def job(self, jid, kind="image", prompt="ok", **kw):
        j = {"id": jid, "nonce": "n-" + jid, "kind": kind, "prompt": prompt}; j.update(kw); mm.S.jobs.put(j); return jid
    def res(self, jid, timeout=30):
        r = mm.wait_result(jid, timeout); self.assertIsNotNone(r, "no result for " + jid); return r
    def test_01_hello(self):
        self.assertEqual(mm.S.last_hello["bridge_version"], mb.BRIDGE_VERSION)
        self.assertTrue(mm.S.last_hello["cli_ok"]); self.assertIn("fake", mm.S.last_hello["cli_version"])
    def test_02_image_ok(self):
        r = self.res(self.job("img1", prompt="红狐 雪原"))
        self.assertTrue(r["ok"]); f = r["files"][0]
        data = b"".join(mm.S.chunks[("img1", 0)][i] for i in range(f["chunks"]))
        self.assertEqual(hashlib.sha256(data).hexdigest(), f["sha256"]); self.assertEqual(len(data), f["bytes"])
        self.assertEqual(f["mime"], "image/webp"); self.assertEqual(r["meta"]["artifact_ids"], ["media-artifact:abc"])
        self.assertNotIn("fbcdn", json.dumps(r)); self.assertEqual(r["job_nonce"], "n-img1")
    def test_03_multi_chunk(self):
        r = self.res(self.job("img2", prompt="multi"))
        self.assertEqual(r["files"][0]["chunks"], 3)
    def test_04_video_ok_timeout(self):
        r = self.res(self.job("vid1", kind="video", prompt="ok-video", orientation="landscape"))
        self.assertTrue(r["ok"]); f = r["files"][0]
        self.assertEqual((f["mime"], f["bytes"], f["chunks"]), ("video/mp4", 10_700_000, 3))
        data = b"".join(mm.S.chunks[("vid1", 0)][i] for i in range(f["chunks"]))
        self.assertEqual(hashlib.sha256(data).hexdigest(), f["sha256"])
        last = argv_lines(self.argvlog)[-1]
        self.assertEqual(last[last.index("--timeout-secs") + 1], "300"); self.assertNotIn("--image-output-format", last)
        self.assertTrue(r["meta"]["snapshot_id"])
    def test_05_errors(self):
        cases = {"region": ("video", "MUSE_VIDEO_REGION_BLOCKED", False), "retry": ("image", "MUSE_UPSTREAM_ERROR", True),
                 "policy": ("image", "MUSE_UPSTREAM_REJECTED", False), "badargs": ("image", "MUSE_BAD_ARGS", False),
                 "garbage": ("image", "MUSE_BAD_OUTPUT", False), "escape": ("image", "MUSE_BAD_OUTPUT", False),
                 "big": ("image", "MUSE_FILE_TOO_LARGE", False), "big-video": ("video", "MUSE_FILE_TOO_LARGE", False)}
        for p, (k, code, retry) in cases.items():
            r = self.res(self.job("e-" + p, kind=k, prompt=p))
            self.assertEqual((r["ok"], r["error_code"], r["retryable"]), (False, code, retry), p)
            self.assertNotIn("fbcdn", json.dumps(r))
        self.assertEqual(self.res("e-region")["upstream_error_code"], "video_not_available")
        self.assertNotIn(("e-escape", 0), mm.S.chunks); self.assertNotIn(("e-big", 0), mm.S.chunks)
    def test_06_invalid_job(self):
        r = self.res(self.job("bad1", kind="audio")); self.assertEqual(r["error_code"], "MUSE_INVALID_INPUT")
    def test_07_image_edit_two_step(self):
        n0 = len(argv_lines(self.argvlog))
        r = self.res(self.job("edit1", prompt="make the fox blue", image_format="png",
                              source_images=[{"base64": b64(PNG)}, {"base64": b64(WEBP)}]))
        self.assertTrue(r["ok"], r)
        calls = argv_lines(self.argvlog)[n0:]
        self.assertEqual(len(calls), 2)
        self.assertIn("--upload-only", calls[0]); self.assertEqual(calls[0].count("--image-file"), 2)
        self.assertFalse(any(x in calls[0] for x in SUBAGENT))
        conv = json.loads(calls[1][calls[1].index("--conversation-json") + 1])
        self.assertEqual(conv, [{"image": "1518875720082600"}, {"image": "1518875720082601"}, {"text": "make the fox blue"}])
        self.assertEqual(calls[1][calls[1].index("--image-output-format") + 1], "png")
    def test_07b_image_to_video(self):
        r = self.res(self.job("i2v", kind="video", prompt="the fox starts running", source_images=[{"base64": b64(WEBP)}]))
        self.assertTrue(r["ok"], r); self.assertEqual((r["files"][0]["mime"], r["files"][0]["bytes"]), ("video/mp4", 6_700_000))
        conv = json.loads((lambda c: c[c.index("--conversation-json") + 1])(argv_lines(self.argvlog)[-1]))
        self.assertEqual(list(conv[0]), ["image"]); self.assertEqual(conv[-1], {"text": "the fox starts running"})
    def test_07c_resume_chain(self):
        first = self.res(self.job("rs1", kind="video", prompt="fox runs"))["meta"]["snapshot_id"]
        r = self.res(self.job("rs2", kind="video", prompt="fox leaps a log", resume_snapshot_id=first))
        self.assertTrue(r["ok"], r)
        last = argv_lines(self.argvlog)[-1]
        self.assertEqual(last[last.index("--resume-from-snapshot-id") + 1], first)
        new = r["meta"]["snapshot_id"]
        self.assertNotEqual(new, first); self.assertEqual(new.split(":")[0], first.split(":")[0])
    def test_07c2_resume_with_new_source_image(self):
        # confirmed on a real Muse VM 03:38: works, output follows the new source image's size
        n0 = len(argv_lines(self.argvlog))
        r = self.res(self.job("rs3", kind="video", prompt="same fox, new scene", resume_snapshot_id="5421fa39-fc25:v6485l",
                              source_images=[{"base64": b64(WEBP)}]))
        self.assertTrue(r["ok"], r)
        calls = argv_lines(self.argvlog)[n0:]
        self.assertEqual(len(calls), 2); self.assertIn("--upload-only", calls[0])
        gen = calls[1]
        self.assertEqual(gen[gen.index("--resume-from-snapshot-id") + 1], "5421fa39-fc25:v6485l")
        conv = json.loads(gen[gen.index("--conversation-json") + 1])
        self.assertEqual(conv, [{"image": "1518875720082600"}, {"text": "same fox, new scene"}])
    def test_07d_never_mixes_legacy_and_subagent(self):
        for call in argv_lines(self.argvlog):
            self.assertFalse(any(x in call for x in LEGACY) and any(x in call for x in SUBAGENT), call)
    def refs_job(self, jid, data=PNG, **kw):
        mm.S.sources[(jid, 0)] = data
        ref = {"n": 0, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mime": "image/png"}
        return self.job(jid, source_refs=[ref], **kw)
    def test_07e_large_refs_ack_then_download_with_retry(self):
        jid = "large-refs"
        mm.S.source_flaky[jid] = 1
        n0 = len(argv_lines(self.argvlog))
        payload = PNG + b"x" * (3 * mb.MIB)
        r = self.res(self.refs_job(jid, payload), 30)
        self.assertTrue(r["ok"], r)
        self.assertLess(mm.S.claim_bytes[jid], 512)
        gets = [r for r in mm.S.source_requests if r[0] == jid]
        # 1MiB chunks over ~3MiB → ≥3 ranges; +1 flaky retry on first range.
        expect_min = (len(payload) + mb.SOURCE_CHUNK_BYTES - 1) // mb.SOURCE_CHUNK_BYTES
        self.assertGreaterEqual(len(gets), expect_min + 1)
        self.assertTrue(all(r[3] for r in gets), "all downloads must follow ack")
        self.assertEqual(gets[0][2], gets[1][2], "retry the failed range only")
        self.assertTrue(gets[0][2].startswith("bytes="), gets[0][2])
        calls = argv_lines(self.argvlog)[n0:]
        self.assertEqual(len(calls), 2)
        self.assertIn("--upload-only", calls[0])
    def test_07f_download_failures_report_result_without_cli(self):
        for failure in ("network", "sha", "short", "ignored-range"):
            jid = "refs-fail-" + failure
            if failure == "network":
                # Exhaust SOURCE_CHUNK_ATTEMPTS (was 3; harden raised to 8).
                mm.S.source_flaky[jid] = mb.SOURCE_CHUNK_ATTEMPTS
            else:
                mm.S.source_bad[jid] = failure
            n0 = len(argv_lines(self.argvlog))
            # 8 chunk attempts with capped backoff can take ~40s+ of sleep alone.
            r = self.res(self.refs_job(jid), 120)
            self.assertEqual(r["error_code"], "MUSE_INVALID_INPUT", failure)
            self.assertEqual(r["retryable"], failure != "sha", failure)
            self.assertEqual(len(argv_lines(self.argvlog)), n0, "failed source must not reach CLI")
    def test_07f2_short_read_retried_then_ok(self):
        # CDN/CF short body with matching Content-Range: bridge must retry, not fail once.
        jid = "refs-short-ok"
        mm.S.source_short[jid] = 2
        n0 = len(argv_lines(self.argvlog))
        r = self.res(self.refs_job(jid), 60)
        self.assertTrue(r["ok"], r)
        self.assertGreater(len(argv_lines(self.argvlog)), n0)
    def test_07i_content_range_mismatch_is_fetch_failed(self):
        jid = "refs-bad-cr"
        mm.S.source_bad_cr.add(jid)
        n0 = len(argv_lines(self.argvlog))
        r = self.res(self.refs_job(jid), 120)
        self.assertEqual(r["error_code"], "MUSE_INVALID_INPUT")
        self.assertTrue(r["retryable"])
        self.assertEqual(len(argv_lines(self.argvlog)), n0, "CLI must not run without its source")
    def test_07g_no_download_without_ack(self):
        jid = "refs-no-ack"
        mm.S.ack_gone.add(jid)
        self.refs_job(jid)
        self.assertTrue(self.res(self.job("after-refs-no-ack"))["ok"])
        self.assertFalse(any(r[0] == jid for r in mm.S.source_requests))
    def test_08_cancel_via_heartbeat(self):
        mm.S.cancel.add("c1"); t0 = time.time()
        r = self.res(self.job("c1", prompt="sleep"), 30)
        self.assertEqual(r["error_code"], "MUSE_CANCELLED"); self.assertLess(time.time() - t0, 15)
    def test_09_job_gone_bridge_continues(self):
        mm.S.gone.add("g1"); self.job("g1", prompt="ok"); time.sleep(3)
        r = self.res(self.job("after-gone", prompt="ok")); self.assertTrue(r["ok"])
    def test_09b_ack_gone_job_not_executed(self):
        n0 = len(argv_lines(self.argvlog))
        mm.S.ack_gone.add("ag1"); self.job("ag1", prompt="ok"); time.sleep(4)
        self.assertNotIn("ag1", mm.S.results)
        self.assertEqual(len(argv_lines(self.argvlog)), n0, "CLI must not run without an ack")
        self.assertTrue(self.res(self.job("after-ag", prompt="ok"))["ok"])
    def test_09c_flaky_ack_retried(self):
        mm.S.ack_flaky["af1"] = 1
        r = self.res(self.job("af1", prompt="ok"))
        self.assertTrue(r["ok"], r)
    def test_09d_stale_heartbeat_cannot_kill_next_job(self):
        # Codex r1 P1: job A's heartbeat is still in flight when A ends and B starts; its late
        # 410 must not kill B's CLI.
        mm.S.hb_delay["slowA"] = 4
        self.job("slowA", prompt="slow A"); self.job("slowB", prompt="slow B")
        self.assertTrue(self.res("slowA", 30)["ok"])
        r = self.res("slowB", 40)
        self.assertTrue(r["ok"], r)
    def test_10_tempdirs_cleaned(self):
        import glob
        # the result is posted before the job dir is removed, so give cleanup a moment
        for _ in range(30):
            left = glob.glob(os.path.join(tempfile.gettempdir(), "muse-job-*"))
            if not left: break
            time.sleep(0.1)
        self.assertEqual(left, [])
    def test_11_second_instance_refused(self):
        r = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", self.home, "--cli", FAKE, "run"], stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        self.assertIn("已在运行".encode(), r.stdout)
    def test_12_status(self):
        r = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", self.home, "status"], stdout=subprocess.PIPE, timeout=10)
        self.assertEqual(r.returncode, 0); self.assertIn("运行中".encode(), r.stdout)
    def test_13_stop_during_job_reports_lost(self):
        self.job("s1", prompt="sleep"); time.sleep(3)
        self.proc.send_signal(signal.SIGTERM)
        r = self.res("s1", 20); self.assertEqual(r["error_code"], "MUSE_BRIDGE_LOST")
        self.assertEqual(self.proc.wait(20), 0)
    def test_14_log_hygiene(self):
        log = open(os.path.join(self.home, "bridge.log")).read()
        for s in (mm.TOKEN, "红狐", "fbcdn", "sleep", "multi"):
            self.assertNotIn(s, log, s)
        st = os.stat(os.path.join(self.home, "bridge.log")); self.assertEqual(st.st_mode & 0o077, 0)

class FreshStateDir(unittest.TestCase):
    """status/stop on a machine where the bridge never ran (no state dir yet)."""
    def test_status_and_stop_without_state_dir(self):
        base = tempfile.mkdtemp()
        for cmd, rc, text in (("status", 1, "未运行"), ("stop", 0, "没有在运行")):
            home = os.path.join(base, "fresh-" + cmd, ".muse-bridge")
            r = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", home, cmd],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
            self.assertEqual(r.returncode, rc, r.stdout); self.assertIn(text.encode(), r.stdout)
            self.assertNotIn(b"Traceback", r.stdout)
            self.assertEqual(os.stat(home).st_mode & 0o777, 0o700)

class Auth(unittest.TestCase):
    def test_bad_token_exits(self):
        srv = mm.start(); home = tempfile.mkdtemp()
        with open(os.path.join(home, "token"), "w") as f: f.write("mbr_wrong")
        r = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", home, "--cli", FAKE, "run", "--server",
                            "http://127.0.0.1:%d" % srv.server_port], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        self.assertEqual(r.returncode, 2); self.assertIn("token".encode(), r.stdout); self.assertNotIn(b"mbr_wrong", r.stdout)
    def test_superseded_exits_and_daemon_start_stop(self):
        srv = mm.start(); home = tempfile.mkdtemp()
        with open(os.path.join(home, "token"), "w") as f: f.write(mm.TOKEN)
        r = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", home, "--cli", FAKE, "start", "--server",
                            "http://127.0.0.1:%d" % srv.server_port], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, timeout=30)
        self.assertEqual(r.returncode, 0, r.stdout); self.assertIn("后台启动".encode(), r.stdout)
        self.assertEqual(r.stdout.count("自检".encode()), 1)
        time.sleep(1); mm.S.session = "someone-else"; time.sleep(5)
        s = subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", home, "status"], stdout=subprocess.PIPE, timeout=10)
        self.assertIn("未运行".encode(), s.stdout); self.assertIn("接管".encode(), s.stdout)

class Foreign403(BaseHTTPRequestHandler):
    """Stands in for a VM egress proxy / CDN: 403 with an HTML page, never the master's JSON."""
    def log_message(self, *a): pass
    def version_string(self): return "egress-proxy"
    def _deny(self):
        n = int(self.headers.get("Content-Length") or 0); self.rfile.read(n)
        body = b"<html><head><style>p{}</style></head><body><h1>403 Forbidden</h1><p>Request denied by egress policy mbr_leak</p></body></html>"
        self.send_response(403); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers(); self.wfile.write(b"ok")
        else: self._deny()
    do_POST = do_PUT = _deny

class Blocking(unittest.TestCase):
    """A 403 written by something in front of the master must not be reported as a bad token."""
    def setUp(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Foreign403)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.srv.server_port
    def tearDown(self): self.srv.shutdown()
    def run_bridge(self, *cmd):
        home = tempfile.mkdtemp()
        with open(os.path.join(home, "token"), "w") as f: f.write(mm.TOKEN)
        return subprocess.run([sys.executable, "-I", BRIDGE, "--state-dir", home, "--cli", FAKE] + list(cmd),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
    def test_foreign_403_is_not_a_token_error(self):
        r = self.run_bridge("run", "--force", "--server", self.url)
        self.assertEqual(r.returncode, 3, r.stdout)
        out = r.stdout.decode()
        self.assertIn("不是个人版服务端返回的", out); self.assertIn("egress-proxy", out); self.assertIn("Request denied", out)
        self.assertNotIn("重新签发", out); self.assertNotIn(mm.TOKEN, out); self.assertNotIn("mbr_leak", out)
        self.assertNotIn("<h1>", out)
    def test_start_refuses_when_post_is_blocked(self):
        r = self.run_bridge("start", "--server", self.url)
        self.assertEqual(r.returncode, 1, r.stdout); self.assertIn("自检未通过".encode(), r.stdout)
    def test_check_flags_blocked_post(self):
        r = self.run_bridge("check", "--server", self.url)
        out = r.stdout.decode()
        self.assertNotEqual(r.returncode, 0, out)
        self.assertIn("✓ 能连到 server", out); self.assertIn("✗ bridge 接口可用", out); self.assertIn("HTTP 403 不是个人版服务端", out)
    def test_check_passes_against_master_without_real_token(self):
        srv = mm.start(); before = (mm.S.hellos, mm.S.session, mm.S.auth_fails)
        r = self.run_bridge("check", "--server", "http://127.0.0.1:%d" % srv.server_port)
        out = r.stdout.decode()
        self.assertIn("✓ bridge 接口可用", out, out)
        # never logged in, never took over a session, never counted as a failed login
        self.assertEqual((mm.S.hellos, mm.S.session, mm.S.auth_fails), before)

class MasterErrors(unittest.TestCase):
    def test_master_401_vs_others(self):
        self.assertEqual(mb.master_error_code(b'{"error":{"code":"UNAUTHORIZED"}}'), "UNAUTHORIZED")
        for body in (b"", b"<html>403</html>", b'{"error":"bad"}', b"[1]", b"\xff"):
            self.assertIsNone(mb.master_error_code(body))
    def test_foreign_diagnosis_scrubs_secrets(self):
        # One input per rule, each followed by a marker that must survive, so no rule hides another.
        cases = [
            (b"<pre>Proxy-Authorization: Basic dXNlcjpzZWNyZXQ=</pre> KEEP", ("dXNlcjpzZWNyZXQ", "user:secret")),
            (b"Authorization: Bearer abc.def\nKEEP", ("abc.def",)),
            (b"Cookie: sid=s3cr3t; x=1\nKEEP", ("s3cr3t",)),
            (b'{"Cookie":"sid=s3cr3t","KEEP":1}', ("s3cr3t",)),
            (b'Cookie: sid="s3cr3t"\nKEEP', ("s3cr3t",)),
            (json.dumps({"Cookie": 'sid="s3cr3t"', "KEEP": 1}).encode(), ("s3cr3t",)),
            (json.dumps({"password": 'a"b\\"s3cr3t', "KEEP": 1}).encode(), ("s3cr3t",)),
            (b"password=p\"s3cr3t\" KEEP", ("s3cr3t",)),
            (b'{"password":"p4ssword","KEEP":1}', ("p4ssword",)),
            (b"{'api_key': 'k3y'} KEEP", ("k3y",)),
            (b"token=tok123&KEEP", ("tok123",)),
            (b'{"access_token":"at999"} KEEP', ("at999",)),
            (b"see http://u:p@proxy:8080/x KEEP", ("u:p@", "proxy:8080")),
            (b"proxy u:p@10.0.0.1 KEEP", ("u:p@",)),
            (b'{"u":"https:\\/\\/scontent.xx.fbcdn.net\\/v\\/t1.png?oh=abc"} KEEP', ("fbcdn", "scontent")),
            (b"https://meta.example/p?sig=1 KEEP", ("meta.example", "sig=1")),
            (b"mbr_bodytoken KEEP", ("mbr_bodytoken",)),
            (b"opaque ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 KEEP", ("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",)),
        ]
        for body, leaks in cases:
            out = mb.describe_foreign(403, {}, body, "https://h.example/api/muse-bridge/v1/hello")
            for leak in leaks:
                self.assertNotIn(leak, out, body)
            self.assertIn("KEEP", out, body)
        out = mb.describe_foreign(403, {"Server": "squid mbr_servertoken", "cf-ray": "Basic Zm9vOmJhcg=="}, b"",
                                  "https://h.example/x")
        self.assertNotIn("mbr_servertoken", out); self.assertNotIn("Zm9vOmJhcg", out)
        self.assertIn("HTTP 403", out); self.assertIn("squid", out)
    def test_proxy_for_drops_credentials(self):
        old = dict(os.environ)
        try:
            for k in list(os.environ):
                if k.lower().endswith("_proxy"): del os.environ[k]
            self.assertEqual(mb.proxy_for("https://x.example"), "无")
            os.environ["https_proxy"] = "http://user:secret@proxy.internal:3128"
            self.assertEqual(mb.proxy_for("https://x.example"), "proxy.internal:3128")
        finally:
            os.environ.clear(); os.environ.update(old)

if __name__ == "__main__":
    unittest.main(verbosity=2)
