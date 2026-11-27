#!/usr/bin/env python3
"""Unit & subprocess security tests for remote Antigravity multimodal vision support."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
from typing import Any, Dict, List

AGENT_REMOTE_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_REMOTE_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_REMOTE_DIR))

from core.canonical import remote_canonical_sha256  # noqa: E402
from core.contract import (  # noqa: E402
    file_sha256,
    load_driver,
    validate_decode_batch,
    validate_encode_batch,
    validate_launch_spec,
)

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2S0AAAAASUVORK5CYII="
)
JPEG_MIN = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
WEBP_MIN = b"RIFF\x14\x00\x00\x00WEBPVP8 \x08\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
GIF_MIN = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"

PNG_B64 = base64.b64encode(PNG_1X1).decode("ascii")
JPEG_B64 = base64.b64encode(JPEG_MIN).decode("ascii")
WEBP_B64 = base64.b64encode(WEBP_MIN).decode("ascii")
GIF_B64 = base64.b64encode(GIF_MIN).decode("ascii")

SAMPLE_TOOLS = {
    "tools": [
        {
            "name": "Write",
            "description": "Write file",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["file_path", "content"],
            },
        }
    ]
}


def _sample_snapshot(cli_sha: str = "a" * 64) -> Dict[str, Any]:
    return {
        "schemaVersion": 4,
        "engineId": "antigravity",
        "driverId": "antigravity",
        "driverVersion": "1.0.0",
        "source": "antigravity-cli:models",
        "freshness": "cli-observed",
        "authPresent": True,
        "accountObserved": True,
        "cliVersion": "1.5.5",
        "cliSha256": cli_sha,
        "models": [
            {
                "upstreamModelId": "gemini-4-carbon-medium",
                "displayName": "Gemini 4 Carbon Medium",
                "supportedEfforts": ["low", "medium", "high"],
                "defaultEffort": "medium",
                "supportsAdaptiveThinking": True,
                "supportsVision": True,
            }
        ],
        "rawResponseSha256": "b" * 64,
        "observedAt": "2026-11-25T00:00:00Z",
    }


def _materialize_spec(root: Path, spec: Dict[str, Any]) -> None:
    (root / "cwd").mkdir(parents=True, exist_ok=True)
    for d in spec["dirs"]:
        dpath = root / d
        dpath.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(dpath, 0o700)
    for rel, meta in spec["files"].items():
        p = root / rel
        p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        p.write_text(meta["content"], encoding="utf-8")
        os.chmod(p, meta["mode"])


def _run_deny_hook(deny_py: Path, payload: Any) -> Dict[str, Any]:
    raw_in = payload if isinstance(payload, str) else json.dumps(payload)
    res = subprocess.run(
        ["/usr/bin/python3", "-I", "-B", str(deny_py)],
        input=raw_in,
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    return json.loads(res.stdout)


class AntigravityVisionEncodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mod, _, _ = load_driver("antigravity")
        self.base_state: Dict[str, Any] = {"initialized": True, "sessionId": str(uuid.uuid4())}

    def test_legacy_text_only_and_pure_text_content_compat(self) -> None:
        cmd_plain = {"kind": "newTurn", "commandId": "cmd_vis_plain", "prompt": "hello world"}
        enc_plain = validate_encode_batch(self.mod.encode(cmd_plain, self.base_state), cmd_plain)
        wire_plain = json.loads(enc_plain["lines"][0])
        self.assertEqual(wire_plain["prompt"], "hello world")
        self.assertNotIn("images", wire_plain)
        self.assertNotIn("stagedMediaFiles", enc_plain["nextNativeState"])
        self.assertNotIn("hasMedia", enc_plain["nextNativeState"])

        cmd_text_blocks = {
            "kind": "newTurn",
            "commandId": "cmd_vis_txt",
            "prompt": "",
            "content": [{"type": "text", "text": "line1"}, {"type": "text", "text": "line2"}],
        }
        enc_txt = validate_encode_batch(self.mod.encode(cmd_text_blocks, self.base_state), cmd_text_blocks)
        wire_txt = json.loads(enc_txt["lines"][0])
        self.assertEqual(wire_txt["prompt"], "line1\nline2")
        self.assertNotIn("images", wire_txt)

        with self.assertRaisesRegex(ValueError, "AGY_EMPTY_PROMPT"):
            self.mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_vis_empty",
                    "prompt": "   ",
                    "content": [{"type": "text", "text": "   "}],
                },
                self.base_state,
            )

    def test_mixed_text_and_all_whitelisted_image_formats(self) -> None:
        cmd = {
            "kind": "newTurn",
            "commandId": "cmd_vis_mix",
            "prompt": "inspect these four images",
            "content": [
                {"type": "text", "text": "inspect these four images"},
                {"type": "image", "mimeType": "IMAGE/PNG", "data": PNG_B64},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": JPEG_B64}},
                {"type": "image", "source": {"type": "base64", "mimeType": "image/webp", "data": WEBP_B64}},
                {"type": "image", "url": f"data:image/gif;base64,{GIF_B64}"},
            ],
        }
        enc = validate_encode_batch(self.mod.encode(cmd, self.base_state), cmd)
        wire = json.loads(enc["lines"][0])
        self.assertEqual(wire["prompt"], "inspect these four images")
        self.assertEqual(len(wire["images"]), 4)
        self.assertEqual(
            [img["mimeType"] for img in wire["images"]],
            ["image/png", "image/jpeg", "image/webp", "image/gif"],
        )
        self.assertEqual(wire["images"][0]["sha256"], hashlib.sha256(PNG_1X1).hexdigest())
        self.assertEqual(wire["images"][1]["sha256"], hashlib.sha256(JPEG_MIN).hexdigest())
        self.assertEqual(wire["images"][2]["sha256"], hashlib.sha256(WEBP_MIN).hexdigest())
        self.assertEqual(wire["images"][3]["sha256"], hashlib.sha256(GIF_MIN).hexdigest())
        self.assertEqual(
            enc["nextNativeState"].get("stagedMediaFiles"),
            {"1": ["turn-1-img-0.png", "turn-1-img-1.jpg", "turn-1-img-2.webp", "turn-1-img-3.gif"]},
        )
        # Image payloads MUST NOT bloat native_state.
        self.assertLess(len(json.dumps(enc["nextNativeState"])), 2048)

    def test_image_only_turn_uses_default_prompt(self) -> None:
        cmd = {
            "kind": "newTurn",
            "commandId": "cmd_vis_imgonly",
            "prompt": "",
            "content": [{"type": "image", "mimeType": "image/png", "data": PNG_B64}],
        }
        enc = validate_encode_batch(self.mod.encode(cmd, self.base_state), cmd)
        wire = json.loads(enc["lines"][0])
        self.assertTrue(len(wire["prompt"].strip()) > 0)
        self.assertEqual(wire["prompt"], self.mod.DEFAULT_IMAGE_ONLY_PROMPT)
        self.assertEqual(len(wire["images"]), 1)

    def test_fail_closed_on_invalid_mime_base64_path_and_unknown_blocks(self) -> None:
        bad_image_cases = [
            # Unmaterialized path (alone or alongside data)
            {"type": "image", "mimeType": "image/png", "path": "/tmp/a.png"},
            {"type": "image", "mimeType": "image/png", "data": PNG_B64, "path": "/tmp/a.png"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG_B64, "path": "/tmp/a.png"}},
            # Unresolved blobId
            {"type": "image", "mimeType": "image/png", "blobId": "blob_123"},
            # Remote URL forbidden
            {"type": "image", "url": "https://example.com/a.png"},
            {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}},
            # Disallowed MIME types
            {"type": "image", "mimeType": "image/svg+xml", "data": PNG_B64},
            {"type": "image", "mimeType": "application/octet-stream", "data": PNG_B64},
            {"type": "image", "mimeType": "image/bmp", "data": PNG_B64},
            {"type": "image", "mimeType": "", "data": PNG_B64},
            # Malformed / corrupted / non-ASCII / empty base64
            {"type": "image", "mimeType": "image/png", "data": "not-valid-b64!!!"},
            {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo"},
            {"type": "image", "mimeType": "image/png", "data": "iVBORw0K\nGgo="},
            {"type": "image", "mimeType": "image/png", "data": ""},
            {"type": "image", "mimeType": "image/png", "data": "你好世界"},
        ]
        for idx, bad_blk in enumerate(bad_image_cases):
            with self.subTest(case=idx, blk=bad_blk):
                with self.assertRaisesRegex(ValueError, "AGY_IMAGE_INVALID"):
                    self.mod.encode(
                        {
                            "kind": "newTurn",
                            "commandId": f"cmd_bad_img_{idx}",
                            "prompt": "check",
                            "content": [bad_blk],
                        },
                        self.base_state,
                    )

        # Unknown block types & NUL in text fail with AGY_CONTENT_INVALID
        for idx, bad_content in enumerate(
            [
                [],
                [{"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": PNG_B64}}],
                [{"type": "localImage", "path": "/tmp/x.png"}],
                [{"type": "text", "text": "hello\x00world"}],
                "not-a-list",
            ]
        ):
            with self.subTest(content_case=idx):
                with self.assertRaisesRegex(ValueError, "AGY_CONTENT_INVALID"):
                    self.mod.encode(
                        {
                            "kind": "newTurn",
                            "commandId": f"cmd_bad_cnt_{idx}",
                            "prompt": "check",
                            "content": bad_content,
                        },
                        self.base_state,
                    )

    def test_fail_closed_on_count_single_size_and_total_size_limits(self) -> None:
        # Exactly 8 images succeeds; 9 images fails with AGY_IMAGE_LIMIT_EXCEEDED.
        eight_imgs = [{"type": "image", "mimeType": "image/png", "data": PNG_B64} for _ in range(8)]
        enc_eight = validate_encode_batch(
            self.mod.encode({"kind": "newTurn", "commandId": "cmd_lim_8", "prompt": "ok", "content": eight_imgs}, self.base_state),
            {"kind": "newTurn", "commandId": "cmd_lim_8"},
        )
        self.assertEqual(len(json.loads(enc_eight["lines"][0])["images"]), 8)

        nine_imgs = [*eight_imgs, {"type": "image", "mimeType": "image/png", "data": PNG_B64}]
        with self.assertRaisesRegex(ValueError, "AGY_IMAGE_LIMIT_EXCEEDED"):
            self.mod.encode(
                {"kind": "newTurn", "commandId": "cmd_lim_9", "prompt": "too many", "content": nine_imgs},
                self.base_state,
            )

        # Single image <= 9 MiB decoded succeeds (aligned with 12 MiB base64 upstream cap); > 9 MiB fails.
        four_mib_b64 = base64.b64encode(b"\x01" * (4 * 1024 * 1024)).decode("ascii")
        enc_two_four = validate_encode_batch(
            self.mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_lim_8m_ok",
                    "prompt": "within 9 MiB total",
                    "content": [
                        {"type": "image", "mimeType": "image/png", "data": four_mib_b64},
                        {"type": "image", "mimeType": "image/png", "data": four_mib_b64},
                    ],
                },
                self.base_state,
            ),
            {"kind": "newTurn", "commandId": "cmd_lim_8m_ok"},
        )
        self.assertEqual(len(json.loads(enc_two_four["lines"][0])["images"]), 2)

        over_single_b64 = base64.b64encode(b"\x01" * (9 * 1024 * 1024 + 1)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "AGY_IMAGE_LIMIT_EXCEEDED"):
            self.mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_lim_single",
                    "prompt": "too big",
                    "content": [{"type": "image", "mimeType": "image/png", "data": over_single_b64}],
                },
                self.base_state,
            )

        # Total decoded > 9 MiB across multiple <=9 MiB images (2 x 5 MiB = 10 MiB) fails with AGY_IMAGE_LIMIT_EXCEEDED.
        five_mib_b64 = base64.b64encode(b"\x02" * (5 * 1024 * 1024)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "AGY_IMAGE_LIMIT_EXCEEDED"):
            self.mod.encode(
                {
                    "kind": "newTurn",
                    "commandId": "cmd_lim_total",
                    "prompt": "too large total",
                    "content": [
                        {"type": "image", "mimeType": "image/png", "data": five_mib_b64},
                        {"type": "image", "mimeType": "image/png", "data": five_mib_b64},
                    ],
                },
                self.base_state,
            )


class AntigravityDenyNativeHookTests(unittest.TestCase):
    def test_real_subprocess_media_read_whitelist_and_red_controls(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-denyhook-") as td:
            root = Path(td) / "lane"
            spec = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    _sample_snapshot(),
                ),
                root,
            )
            _materialize_spec(root, spec)
            deny_py = root / "deny_native.py"
            media_dir = root / "media"

            # Create valid media images in all allowed extensions.
            valid_files = {
                "turn-1-img-0.png": PNG_1X1,
                "turn-1-img-1.jpg": JPEG_MIN,
                "turn-1-img-2.jpeg": JPEG_MIN,
                "turn-1-img-3.webp": WEBP_MIN,
                "turn-1-img-4.gif": GIF_MIN,
            }
            for fname, data in valid_files.items():
                fp = media_dir / fname
                fp.write_bytes(data)
                os.chmod(fp, 0o600)

            # 1) Allowed: Path / path / file_path and uppercase/mixed extensions inside media/.
            for key, fname in (
                ("Path", "turn-1-img-0.png"),
                ("path", "turn-1-img-1.jpg"),
                ("file_path", "turn-1-img-2.jpeg"),
                ("Path", "turn-1-img-3.webp"),
                ("path", "turn-1-img-4.gif"),
            ):
                res = _run_deny_hook(
                    deny_py,
                    {
                        "toolCall": {"name": "read_file", "args": {key: str((media_dir / fname).resolve())}},
                        "stepIdx": 3,
                        "conversationId": "conv-hook-1",
                    },
                )
                self.assertEqual(res, {"decision": "allow"}, f"expected allow for {key}={fname}")

            # Pretool media audit recorded (including step proof) without writing step_*.json / seq_*.json that belong to mcp_ocbridge_*.
            pretool_dir = root / "run" / "pretool"
            self.assertTrue(list(pretool_dir.glob("media_read_step_3.json")))
            self.assertTrue([p for p in pretool_dir.glob("media_read_*.json") if not p.name.startswith("media_read_step_")])
            self.assertEqual(list(pretool_dir.glob("step_*.json")), [])
            self.assertEqual(list(pretool_dir.glob("seq_*.json")), [])

            # 2) Denied: path traversal, /etc/passwd, sibling host_config.json, relative path.
            outside_secret = Path(td) / "secret.png"
            outside_secret.write_bytes(PNG_1X1)
            symlink_to_etc = media_dir / "sym-etc.png"
            os.symlink("/etc/passwd", str(symlink_to_etc))
            symlink_to_outside_png = media_dir / "sym-outside.png"
            os.symlink(str(outside_secret), str(symlink_to_outside_png))
            symlink_to_inside = media_dir / "sym-inside.png"
            os.symlink(str(media_dir / "turn-1-img-0.png"), str(symlink_to_inside))
            symlink_dir = media_dir / "symdir"
            os.symlink(str(Path(td)), str(symlink_dir))
            disallowed_ext = media_dir / "turn-1-img-0.txt"
            disallowed_ext.write_text("secret", encoding="utf-8")
            empty_png = media_dir / "empty.png"
            empty_png.write_bytes(b"")
            dir_as_png = media_dir / "dir.png"
            dir_as_png.mkdir(mode=0o700)

            denied_read_args: List[Dict[str, Any]] = [
                {"Path": str(media_dir) + "/../host_config.json"},
                {"Path": "../host_config.json"},
                {"Path": str((root / "host_config.json").resolve())},
                {"path": "/etc/passwd"},
                {"file_path": "media/turn-1-img-0.png"},
                {"Path": str(symlink_to_etc)},
                {"Path": str(symlink_to_outside_png)},
                {"Path": str(symlink_to_inside)},
                {"Path": str(symlink_dir / "secret.png")},
                {"Path": str(disallowed_ext)},
                {"Path": str(empty_png)},
                {"Path": str(dir_as_png)},
                {"Path": str(media_dir / "missing.png")},
                {"Path": str(media_dir)},
                {"Path": str((media_dir / "turn-1-img-0.png").resolve()), "path": "/etc/passwd"},
                {"Path": str((media_dir / "turn-1-img-0.png").resolve()) + "\x00.png"},
                {},
            ]
            for idx, args in enumerate(denied_read_args):
                with self.subTest(denied_read_idx=idx, args=args):
                    res = _run_deny_hook(deny_py, {"toolCall": {"name": "read_file", "args": args}})
                    self.assertEqual(res.get("decision"), "deny", f"MUST deny read_file with {args}")
                    self.assertEqual(res.get("reason"), "native_tool_forbidden:read_file")

            # 3) Other native tools targeting valid media files MUST STILL be denied!
            for native_tool in ("write_file", "edit_file", "run_command", "delete_file", "view_file"):
                res = _run_deny_hook(
                    deny_py,
                    {"toolCall": {"name": native_tool, "args": {"Path": str((media_dir / "turn-1-img-0.png").resolve())}}},
                )
                self.assertEqual(res, {"decision": "deny", "reason": f"native_tool_forbidden:{native_tool}"})

            # 4) Existing allow rules remain intact & malformed JSON denied.
            self.assertEqual(
                _run_deny_hook(deny_py, {"toolCall": {"name": "exit_plan_mode", "args": {}}}),
                {"decision": "allow"},
            )
            self.assertEqual(
                _run_deny_hook(deny_py, {"toolCall": {"name": "mcp_ocbridge_Write", "args": {"file_path": "/a", "content": "b"}}}),
                {"decision": "allow"},
            )
            self.assertEqual(_run_deny_hook(deny_py, "{broken-json").get("decision"), "deny")

            # 5) Replacing media/ itself with a symlink MUST deny.
            for child in list(media_dir.iterdir()):
                if child.is_symlink() or child.is_file():
                    child.unlink()
                elif child.is_dir():
                    child.rmdir()
            media_dir.rmdir()
            os.symlink(str(Path(td)), str(media_dir))
            res_sym_dir = _run_deny_hook(
                deny_py,
                {"toolCall": {"name": "read_file", "args": {"Path": str(media_dir / "secret.png")}}},
            )
            self.assertEqual(res_sym_dir, {"decision": "deny", "reason": "native_tool_forbidden:read_file"})


class AntigravityHostMediaStagingAndObservationTests(unittest.TestCase):
    def test_host_stages_atomic_media_allows_controlled_read_prunes_and_cleans_on_exit(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-agymedia-") as td:
            base = Path(td)
            root = base / "lane"
            fake_cli = base / "fake-agy-vision"
            fake_cli.write_text(
                r"""#!/usr/bin/env python3
import json, os, pathlib, re, stat, subprocess, sys, uuid

conv_id = str(uuid.uuid4())
sys.stdout.write(json.dumps({"event": "init", "conversation_id": conv_id, "init": {"model": "gemini-4-carbon-medium", "tools": []}}) + "\n")
sys.stdout.flush()

turn_num = 0
step_idx = 0
deny_py = pathlib.Path.cwd().parent / "deny_native.py"
media_dir = pathlib.Path.cwd().parent / "media"

for raw_ln in sys.stdin:
    raw_ln = raw_ln.strip()
    if not raw_ln:
        continue
    turn_num += 1
    msg = json.loads(raw_ln)
    content = str((msg.get("message") or {}).get("content") or "")
    step_idx += 1
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {"conversation_id": conv_id, "step_index": step_idx, "step_type": "user_input", "state": "DONE"},
    }) + "\n")

    paths = re.findall(r"- image\[\d+\] \([^)]+\): (/\S+)", content)
    assert "<openclaude_attached_images>" in content, f"missing image block in turn {turn_num}"
    assert len(paths) >= 1, f"missing staged paths in turn {turn_num}"
    for p_str in paths:
        p = pathlib.Path(p_str)
        st = os.lstat(p_str)
        assert not stat.S_ISLNK(st.st_mode) and stat.S_ISREG(st.st_mode)
        assert stat.S_IMODE(st.st_mode) == 0o600
        # Verify real PreToolUse hook allows staged media read_file and denies traversal!
        allow_res = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(deny_py)],
            input=json.dumps({"toolCall": {"name": "read_file", "args": {"Path": p_str}}, "stepIdx": step_idx + 1, "conversationId": conv_id}),
            text=True, capture_output=True, check=True,
        )
        assert json.loads(allow_res.stdout)["decision"] == "allow"
        deny_res = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(deny_py)],
            input=json.dumps({"toolCall": {"name": "read_file", "args": {"Path": str(media_dir) + "/../host_config.json"}}}),
            text=True, capture_output=True, check=True,
        )
        assert json.loads(deny_res.stdout)["decision"] == "deny"

    # Emit controlled read_file tool step_update on turn 1 alongside an ocbridge MCP tool call,
    # and re-read turn 1's still-retained image on turn 2 to verify sliding-window pretool proof.
    if turn_num == 1:
        step_idx += 1
        allow_t1 = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(deny_py)],
            input=json.dumps({"toolCall": {"name": "read_file", "args": {"Path": paths[0]}}, "stepIdx": step_idx, "conversationId": conv_id}),
            text=True, capture_output=True, check=True,
        )
        assert json.loads(allow_t1.stdout)["decision"] == "allow"
        sys.stdout.write(json.dumps({
            "event": "step_update",
            "step_update": {
                "conversation_id": conv_id,
                "step_index": step_idx,
                "step_type": "tool",
                "state": "DONE",
                "tool_info": {"name": "read_file", "parameters": {"Path": paths[0]}},
            },
        }) + "\n")
        step_idx += 1
        sys.stdout.write(json.dumps({
            "event": "step_update",
            "step_update": {
                "conversation_id": conv_id,
                "step_index": step_idx,
                "step_type": "tool",
                "state": "DONE",
                "tool_info": {"name": "mcp_ocbridge_Write", "parameters": {"file_path": "/workspace/note.txt", "content": "saw-img"}},
            },
        }) + "\n")
    elif turn_num == 2:
        prev_img = str((media_dir / "turn-1-img-0.png").resolve())
        step_idx += 1
        allow_prev = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(deny_py)],
            input=json.dumps({"toolCall": {"name": "read_file", "args": {"Path": prev_img}}, "stepIdx": step_idx, "conversationId": conv_id}),
            text=True, capture_output=True, check=True,
        )
        assert json.loads(allow_prev.stdout)["decision"] == "allow"
        sys.stdout.write(json.dumps({
            "event": "step_update",
            "step_update": {
                "conversation_id": conv_id,
                "step_index": step_idx,
                "step_type": "tool",
                "state": "DONE",
                "tool_info": {"name": "read_file", "parameters": {"Path": prev_img}},
            },
        }) + "\n")

    present_media = sorted(p.name for p in media_dir.iterdir() if p.is_file())
    step_idx += 1
    sys.stdout.write(json.dumps({
        "event": "step_update",
        "step_update": {
            "conversation_id": conv_id,
            "step_index": step_idx,
            "step_type": "agent_response",
            "state": "DONE",
            "text_delta": json.dumps({"turn": turn_num, "paths": paths, "present": present_media}),
            "usage": {"input_tokens": 20, "output_tokens": 10, "thinking_tokens": 0, "cache_read_tokens": 0},
        },
    }) + "\n")
    sys.stdout.write(json.dumps({"event": "result", "result": {"conversation_id": conv_id, "status": "SUCCESS"}}) + "\n")
    sys.stdout.flush()
""",
                encoding="utf-8",
            )
            fake_cli.chmod(0o755)
            spec = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": str(fake_cli),
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    _sample_snapshot(file_sha256(fake_cli)),
                ),
                root,
            )
            self.assertIn("media", spec["dirs"])
            _materialize_spec(root, spec)

            proc = subprocess.Popen(
                spec["argv"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=spec["cwd"],
                env=spec["environment"],
            )
            fseq = 0
            try:
                st: Dict[str, Any] = {}
                e_init = mod.encode({"kind": "initialize", "commandId": "cmd_m_init", "model": "gemini-4-carbon-medium"}, st)
                st = e_init["nextNativeState"]
                for ln in e_init["lines"]:
                    proc.stdin.write(ln + "\n")
                proc.stdin.flush()
                fseq += 1
                init_ln = proc.stdout.readline()
                st = validate_decode_batch(
                    mod.decode("native", init_ln.encode(), st),
                    channel="native",
                    raw_frame_bytes=init_ln.encode(),
                    frame_seq=fseq,
                )["nextNativeState"]

                turn_reports: List[Dict[str, Any]] = []
                for t in range(1, 6):
                    blocks = (
                        [
                            {"type": "text", "text": f"turn {t}"},
                            {"type": "image", "mimeType": "image/png", "data": PNG_B64},
                            {"type": "image", "mimeType": "image/webp", "data": WEBP_B64},
                        ]
                        if t == 1
                        else [{"type": "image", "mimeType": "image/jpeg", "data": JPEG_B64}]
                    )
                    cmd_t = {"kind": "newTurn", "commandId": f"cmd_m_t{t}", "prompt": f"turn {t}" if t == 1 else "", "content": blocks}
                    enc_t = validate_encode_batch(mod.encode(cmd_t, st), cmd_t)
                    st = enc_t["nextNativeState"]
                    for ln in enc_t["lines"]:
                        proc.stdin.write(ln + "\n")
                    proc.stdin.flush()

                    deltas: List[str] = []
                    tool_obs: List[Dict[str, Any]] = []
                    disallowed: List[Dict[str, Any]] = []
                    while st.get("activeTurn"):
                        out_ln = proc.stdout.readline()
                        self.assertTrue(out_ln, f"unexpected EOF on turn {t}")
                        fseq += 1
                        dec = validate_decode_batch(
                            mod.decode("native", out_ln.encode(), st),
                            channel="native",
                            raw_frame_bytes=out_ln.encode(),
                            frame_seq=fseq,
                        )
                        st = dec["nextNativeState"]
                        for ev in dec["securityEvents"]:
                            if ev["kind"] == "textDelta":
                                deltas.append(ev["delta"])
                            elif ev["kind"] == "toolCallObserved":
                                tool_obs.append(ev)
                            elif ev["kind"] == "disallowedItem":
                                disallowed.append(ev)
                    self.assertEqual(disallowed, [], f"controlled read_file must NOT trigger disallowedItem on turn {t}")
                    if t == 1:
                        # Only mcp_ocbridge_Write should be in toolCallObserved; read_file must NOT cause tool drift!
                        self.assertEqual([ev["name"] for ev in tool_obs], ["Write"])
                        self.assertEqual(len(st["observedToolCalls"]), 1)
                        # Verify exact bytes staged on disk for turn 1 while still inside retention window.
                        self.assertEqual((root / "media" / "turn-1-img-0.png").read_bytes(), PNG_1X1)
                        self.assertEqual((root / "media" / "turn-1-img-1.webp").read_bytes(), WEBP_MIN)
                    turn_reports.append(json.loads("".join(deltas)))

                # By turn 5 (retention window = 3 turns), turns 1 & 2 MUST be pruned while turns 3..5 remain!
                self.assertFalse((root / "media" / "turn-1-img-0.png").exists())
                self.assertFalse((root / "media" / "turn-2-img-0.jpg").exists())
                self.assertIn("turn-5-img-0.jpg", turn_reports[-1]["present"])
                self.assertNotIn("turn-1-img-0.png", turn_reports[-1]["present"])
                self.assertNotIn("turn-2-img-0.jpg", turn_reports[-1]["present"])
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream:
                        stream.close()
                proc.wait(timeout=10)

            # After agy_host.py exits, root/media MUST be completely cleaned!
            self.assertEqual(list((root / "media").iterdir()), [])

    def test_decode_sliding_window_eviction_and_out_of_scope_read_file(self) -> None:
        mod, _, _ = load_driver("antigravity")
        conv_id = str(uuid.uuid4())
        # 1) Pure text session (stagedMediaFiles absent): even a media-shaped read_file MUST emit disallowedItem.
        st_text: Dict[str, Any] = {"initialized": True, "sessionId": conv_id}
        st_text = mod.encode({"kind": "newTurn", "commandId": "cmd_txt_rf", "prompt": "hi"}, st_text)["nextNativeState"]
        rf_frame = json.dumps(
            {
                "ev": "cli",
                "turnSeq": 1,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 2,
                        "step_type": "tool",
                        "state": "DONE",
                        "tool_info": {"name": "read_file", "parameters": {"Path": "/tmp/lane/media/turn-1-img-0.png"}},
                    },
                },
            }
        ).encode()
        dec_txt = mod.decode("native", rf_frame, st_text)
        self.assertEqual(
            [e for e in dec_txt["securityEvents"] if e["kind"] == "disallowedItem"],
            [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
        )

        # 2) Turn 1 stages turn-1-img-0.png (verified via host_media_staged).
        st_w: Dict[str, Any] = {"initialized": True, "sessionId": conv_id}
        st_w = mod.encode(
            {
                "kind": "newTurn",
                "commandId": "cmd_win_t1",
                "prompt": "check",
                "content": [{"type": "image", "mimeType": "image/png", "data": PNG_B64}],
            },
            st_w,
        )["nextNativeState"]
        staged_abs = "/tmp/lane/media/turn-1-img-0.png"
        st_w = validate_decode_batch(
            mod.decode(
                "native",
                json.dumps({"ev": "host_media_staged", "turnSeq": 1, "mediaDir": "/tmp/lane/media", "paths": [staged_abs]}).encode(),
                st_w,
            ),
            channel="native",
            raw_frame_bytes=b"{}",
            frame_seq=1,
        )["nextNativeState"]

        def _rf_check(st_cur: Dict[str, Any], tseq: int, params: Dict[str, Any], proof: Any = None) -> List[Dict[str, Any]]:
            frm: Dict[str, Any] = {
                "ev": "cli",
                "turnSeq": tseq,
                "raw": {
                    "event": "step_update",
                    "step_update": {
                        "conversation_id": conv_id,
                        "step_index": 10 + tseq,
                        "step_type": "tool",
                        "state": "DONE",
                        "tool_info": {"name": "read_file", "parameters": params},
                    },
                },
            }
            if proof is not None:
                frm["mediaReadProof"] = proof
            return [e for e in mod.decode("native", json.dumps(frm).encode(), st_cur)["securityEvents"] if e["kind"] == "disallowedItem"]

        # Current turn valid staged image + pretoolObserved=True -> ALLOWED.
        self.assertEqual(_rf_check(st_w, 1, {"Path": staged_abs}, {"path": staged_abs, "pretoolObserved": True}), [])

        # Missing hook proof (explicit False OR omitted mediaReadProof field) -> REJECTED!
        self.assertEqual(
            _rf_check(st_w, 1, {"Path": staged_abs}, {"path": staged_abs, "pretoolObserved": False}),
            [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
        )
        self.assertEqual(
            _rf_check(st_w, 1, {"Path": staged_abs}, None),
            [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
        )

        # Missing verifiedStagedMediaPaths (no host_media_staged ack yet) -> REJECTED!
        st_unverified = {k: v for k, v in st_w.items() if k != "verifiedStagedMediaPaths"}
        self.assertEqual(
            _rf_check(st_unverified, 1, {"Path": staged_abs}, {"path": staged_abs, "pretoolObserved": True}),
            [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
        )

        # Out-of-scope, fabricated filename, wrong root, or conflicting path keys -> REJECTED!
        for bad_params in (
            {"Path": "/etc/passwd"},
            {"Path": "/tmp/lane/media/../host_config.json"},
            {"Path": "/tmp/lane/media/turn-1-img-0.txt"},
            {"Path": "/tmp/lane/media/turn-1-img-1.png"},
            {"Path": "/tmp/other-lane/media/turn-1-img-0.png"},
            {"Path": staged_abs, "path": "/etc/passwd"},
        ):
            self.assertEqual(
                _rf_check(st_w, 1, bad_params),
                [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
                f"expected disallowedItem for {bad_params}",
            )

        # Finish turn 1; advance turns 2 & 3 (text-only) -> turn 1 still inside 3-turn retention window -> ALLOWED.
        for t in (2, 3):
            st_w["activeTurn"] = False
            st_w = mod.encode({"kind": "newTurn", "commandId": f"cmd_win_t{t}", "prompt": f"follow-up {t}"}, st_w)["nextNativeState"]
            self.assertIn("1", st_w.get("stagedMediaFiles", {}))
            self.assertEqual(_rf_check(st_w, t, {"Path": staged_abs}, {"path": staged_abs, "pretoolObserved": True}), [])

        # Advance turn 4 (text-only): turn 1 is evicted (1 <= 4 - 3) and retention window is now EMPTY -> REJECTED!
        st_w["activeTurn"] = False
        st_w = mod.encode({"kind": "newTurn", "commandId": "cmd_win_t4", "prompt": "evicted now"}, st_w)["nextNativeState"]
        self.assertNotIn("stagedMediaFiles", st_w)
        self.assertNotIn("verifiedStagedMediaPaths", st_w)
        self.assertEqual(
            _rf_check(st_w, 4, {"Path": staged_abs}, {"path": staged_abs, "pretoolObserved": True}),
            [{"kind": "disallowedItem", "reason": "non_ocbridge_tool_call", "itemType": "read_file"}],
        )

    def test_host_rejects_symlink_media_dir_fail_closed(self) -> None:
        mod, _, _ = load_driver("antigravity")
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-agysym-") as td:
            base = Path(td)
            root = base / "lane"
            escape_dir = base / "escape"
            escape_dir.mkdir(mode=0o700)
            fake_cli = base / "fake-agy-noop"
            fake_cli.write_text("#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n", encoding="utf-8")
            fake_cli.chmod(0o755)
            spec = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": str(fake_cli),
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    _sample_snapshot(file_sha256(fake_cli)),
                ),
                root,
            )
            _materialize_spec(root, spec)
            # Replace root/media with a symlink pointing outside root.
            (root / "media").rmdir()
            os.symlink(str(escape_dir), str(root / "media"))

            proc = subprocess.Popen(
                spec["argv"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=spec["cwd"],
                env=spec["environment"],
            )
            try:
                enc = mod.encode(
                    {
                        "kind": "newTurn",
                        "commandId": "cmd_sym_1",
                        "prompt": "attack",
                        "content": [{"type": "image", "mimeType": "image/png", "data": PNG_B64}],
                    },
                    {"initialized": True, "sessionId": str(uuid.uuid4())},
                )
                proc.stdin.write(enc["lines"][0] + "\n")
                proc.stdin.flush()
                err_frame = json.loads(proc.stdout.readline())
                self.assertEqual(err_frame["ev"], "host_turn_error")
                self.assertIn("AGY_MEDIA_DIR_SYMLINK_FORBIDDEN", err_frame["stderr"])
                self.assertEqual(list(escape_dir.iterdir()), [])
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream:
                        stream.close()
                proc.wait(timeout=5)


class AntigravityVisionPolicyHashTests(unittest.TestCase):
    def test_policy_sha256_and_deny_hook_sha256_consistency(self) -> None:
        mod, _, _ = load_driver("antigravity")
        expected_policy = remote_canonical_sha256(
            {
                "driverId": "antigravity",
                "driverVersion": mod.DRIVER_VERSION,
                "agentName": "ocremote",
                "nativeTools": "",
                "allowedNativeTools": ["read_file"],
                "ocbridgeOnly": True,
                "excludeDefaultComponents": True,
                "hostSha256": remote_canonical_sha256(mod._AGY_HOST_PY),
                "denyHookSha256": remote_canonical_sha256(mod._DENY_NATIVE_PY),
            }
        )
        self.assertEqual(mod._policy_hash(""), expected_policy)

        with tempfile.TemporaryDirectory(dir="/tmp", prefix="oc-drvtest-pol-") as td:
            root = Path(td) / "lane"
            spec = validate_launch_spec(
                mod.launch_spec(
                    {
                        "root": str(root),
                        "model": "gemini-4-carbon-medium",
                        "cliPath": "/usr/local/bin/agy",
                        "mcpClientPath": str(AGENT_REMOTE_DIR / "core" / "mcp_client.py"),
                        "tools": SAMPLE_TOOLS,
                    },
                    _sample_snapshot(),
                ),
                root,
            )
            self.assertEqual(spec["policySha256"], expected_policy)
            agent_md = spec["files"]["home/.gemini/antigravity-cli/agents/ocremote.md"]["content"]
            self.assertIn('tools: ["read_file"]', agent_md)
            self.assertIn("excludeDefaultComponents: true", agent_md)
            self.assertIn("<openclaude_attached_images>", agent_md)
            self.assertIn("mcp_ocbridge_*", agent_md)
            if Path("/usr/local/bin/antigravity").is_file():
                _materialize_spec(root, spec)
                cli_chk = subprocess.run(
                    ["/usr/local/bin/antigravity", "agent"],
                    capture_output=True,
                    text=True,
                    env=spec["environment"],
                    timeout=10,
                    check=True,
                )
                self.assertIn("ocremote", cli_chk.stdout)
            self.assertEqual(
                remote_canonical_sha256(spec["files"]["deny_native.py"]["content"]),
                remote_canonical_sha256(mod._DENY_NATIVE_PY),
            )
            self.assertEqual(
                remote_canonical_sha256(spec["files"]["agy_host.py"]["content"]),
                remote_canonical_sha256(mod._AGY_HOST_PY),
            )

            # Probe snapshot returns the exact same policySha256.
            probe_out = mod.probe(
                {"cliPath": "/usr/local/bin/agy"},
                {
                    "returncode": 0,
                    "stdoutLines": [
                        json.dumps(
                            {
                                "version": "1.5.5",
                                "authPresent": True,
                                "accountObserved": True,
                                "email": "alice@example.com",
                                "planType": "ultra",
                                "models": [{"id": "gemini-4-carbon"}],
                            }
                        )
                    ],
                    "stdoutSha256": "c" * 64,
                    "artifactHashes": {"cli": "a" * 64},
                },
            )
            self.assertEqual(probe_out["policySha256"], spec["policySha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
