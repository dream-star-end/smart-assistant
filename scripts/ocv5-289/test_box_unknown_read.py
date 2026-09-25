"""Execute the actual embedded read-only Box inspection body on synthetic files."""
import json
import os
import pathlib
import secrets
import shutil
import subprocess
import unittest


SOURCE = pathlib.Path(__file__).with_name("boxUnknownInspect.ts").read_text()
READ = SOURCE.split("const READ = String.raw`", 1)[1].split("`;", 1)[0]


class UnknownReadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.nonce = secrets.token_hex(12)
        self.run = pathlib.Path("/tmp") / f"ocv5-289-run-{self.nonce}"
        self.proof = pathlib.Path("/tmp") / f"ocv5-289-proof-{self.nonce}"
        self.run.mkdir(mode=0o700)
        self.proof.mkdir(mode=0o700)

    def tearDown(self) -> None:
        shutil.rmtree(self.run, ignore_errors=True)
        shutil.rmtree(self.proof, ignore_errors=True)

    def inspect(self, records: list[object], raw_suffix: bytes = b"") -> dict:
        path = self.run / "stdout.jsonl"
        data = b"".join(json.dumps(item).encode() + b"\n" for item in records) + raw_suffix
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
        assets = [f"/tmp/ocv5-289-synthetic-missing-{i}:{'0' * 64}"
                  for i in range(4)]
        result = subprocess.run(["/usr/bin/python3", "-I", "-c", READ,
                                 self.nonce, *assets], capture_output=True,
                                timeout=10, check=True)
        return json.loads(result.stdout)["stream"]

    def test_error_result_shape_and_late_bad_frame(self) -> None:
        valid = {"type": "result", "subtype": "success", "is_error": True}
        summary = self.inspect([valid])
        self.assertEqual((summary["lastType"], summary["lastResultSubtype"],
                          summary["invalidCount"], summary["toolUseCount"]),
                         ("result", "success", 0, 0))
        summary = self.inspect([valid], b"not-json\n")
        self.assertEqual((summary["lastType"], summary["invalidCount"]),
                         ("invalid_json", 1))
        summary = self.inspect([valid, []])
        self.assertEqual((summary["lastType"], summary["invalidCount"]),
                         ("non_object", 1))
        summary = self.inspect([{"type": "result", "is_error": True}])
        self.assertIsNone(summary["lastResultSubtype"])

    def test_streamed_tool_use_without_assistant_snapshot_is_visible(self) -> None:
        summary = self.inspect([
            {"type": "stream_event", "event": {"type": "content_block_start",
             "content_block": {"type": "tool_use"}}},
            {"type": "result", "subtype": "success", "is_error": True},
        ])
        self.assertGreater(summary["toolUseCount"], 0)


if __name__ == "__main__":
    unittest.main()
