"""CLI contract with server-owned retries; no network, bridge, or account access."""
import argparse
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

CLI = Path(__file__).resolve().parents[2] / "agent-sandbox/platform-runtime/bin/oc-muse.py"
spec = importlib.util.spec_from_file_location("oc_muse", CLI)
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class RetryContract(unittest.TestCase):
    def args(self):
        return argparse.Namespace(prompt="cat", orientation=None, image=[], resume=None,
                                  timeout=10, json=False)

    def test_offline_server_retries_without_resubmission_or_premature_timeout(self):
        responses = [
            {"bridge_online": False, "retry": {"max": 3, "interval_ms": 40000}},
            {"job_id": "mj_test"},
            {"status": "running", "retry_count": 0},
            {"status": "queued", "retry_count": 1},
            {"status": "running", "retry_count": 1},
            {"status": "succeeded", "retry_count": 1},
        ]
        with patch.object(cli, "call", side_effect=responses) as call, \
                patch.object(cli.signal, "signal"), \
                patch.object(cli.time, "monotonic", side_effect=[0, 0, 8, 41, 42]), \
                patch.object(cli, "deliver", return_value=0) as deliver:
            self.assertEqual(cli.run("image", self.args()), 0)
        self.assertEqual(sum(c.args[0] == "POST" for c in call.call_args_list), 1)
        self.assertFalse(any(c.args[0] == "DELETE" for c in call.call_args_list))
        deliver.assert_called_once_with("mj_test", responses[-1], False)

    def test_legacy_server_keeps_offline_failure(self):
        with patch.object(cli, "call", return_value={"bridge_online": False}) as call:
            with self.assertRaises(cli.MuseFailure) as err:
                cli.run("image", self.args())
        self.assertEqual(err.exception.payload["code"], "MUSE_BRIDGE_OFFLINE")
        self.assertEqual(call.call_count, 1)

    def test_exhaustion_uses_existing_failure_delivery(self):
        responses = [
            {"bridge_online": False, "retry": {"max": 3}},
            {"job_id": "mj_test"},
            {"status": "queued", "retry_count": 1},
            {"status": "queued", "retry_count": 2},
            {"status": "queued", "retry_count": 3},
            {"status": "failed", "error": {"code": "MUSE_BRIDGE_OFFLINE", "retryable": True}},
        ]
        with patch.object(cli, "call", side_effect=responses) as call, \
                patch.object(cli.signal, "signal"), \
                patch.object(cli.time, "monotonic", side_effect=[0, 0, 40, 80, 120]):
            with self.assertRaises(cli.MuseFailure) as err:
                cli.run("video", self.args())
        self.assertEqual(err.exception.payload["code"], "MUSE_BRIDGE_OFFLINE")
        self.assertEqual(err.exception.payload["job_id"], "mj_test")
        self.assertEqual(sum(c.args[0] == "POST" for c in call.call_args_list), 1)

    def test_durable_video_exhaustion_returns_ack_and_does_not_download(self):
        responses = [
            {"bridge_online": False, "retry": {"max": 3}, "durable_video": True},
            {"job_id": "mj_test"},
            {"status": "queued", "retry_count": 3, "background": True, "delivery": "conversation"},
        ]
        with patch.object(cli, "call", side_effect=responses) as call, \
                patch.dict(cli.os.environ, {"OPENCLAUDE_SESSION_KEY": "agent:main:webchat:dm:origin"}), \
                patch.object(cli.signal, "signal"), patch.object(cli, "deliver") as deliver, \
                patch("builtins.print") as output:
            self.assertEqual(cli.run("video", self.args()), 0)
        self.assertEqual(call.call_args_list[1].args[2]["session_key"], "agent:main:webchat:dm:origin")
        self.assertIn('"background": true', output.call_args.args[0])
        deliver.assert_not_called()
        self.assertFalse(any(c.args[0] == "DELETE" for c in call.call_args_list))

    def test_restart_after_durable_acceptance_acknowledges_without_h3_or_resubmission(self):
        with patch.object(cli, "call", side_effect=[
                {"bridge_online": True, "durable_video": True}, {"job_id": "mj_test"},
                cli.MuseFailure("MUSE_MASTER_UNAVAILABLE", "restarting", True)]) as call, \
                patch.object(cli.signal, "signal"), patch.object(cli, "deliver") as deliver, \
                patch("builtins.print") as output:
            self.assertEqual(cli.run("video", self.args()), 0)
        self.assertIn('"delivery": "conversation"', output.call_args.args[0])
        self.assertEqual(sum(c.args[0] == "POST" for c in call.call_args_list), 1)
        deliver.assert_not_called()

    def test_durable_sync_success_is_delivered_once_by_server(self):
        with patch.object(cli, "call", side_effect=[
                {"bridge_online": True, "durable_video": True}, {"job_id": "mj_test"},
                {"status": "succeeded", "delivery": "conversation", "background": False}]), \
                patch.object(cli.signal, "signal"), patch.object(cli, "deliver") as deliver, \
                patch("builtins.print"):
            self.assertEqual(cli.run("video", self.args()), 0)
        deliver.assert_not_called()


if __name__ == "__main__":
    unittest.main()
