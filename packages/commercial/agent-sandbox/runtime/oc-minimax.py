#!/usr/bin/env python3
"""OpenClaude-safe MiniMax CLI wrapper.

This intentionally does NOT read or store a MiniMax API key. It authenticates to
OpenClaude master with the per-container oc-v3 bearer and lets master hold the
Token Plan key + billing ledger.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib import request, error

MASTER_ENV = "OPENCLAUDE_V3_MASTER_BASE_URL"
TOKEN_ENV = "OPENCLAUDE_V3_CONTAINER_TOKEN"
# codex 引擎路径 ambient env 会被双重清洗剥掉(gateway buildCodexEnv 剥 OPENCLAUDE_* 前缀 +
# codex shell 策略剥 *TOKEN* 名),supervisor 每次 boot 把同一对值写进这个文件(entrypoint.ts);
# env 优先(CCB 路径零变化),文件是 codex 路径的回退通道。
AUTH_FILE_CANDIDATES = (
    Path("/home/agent/.openclaude/container-auth.json"),
    Path.home() / ".openclaude" / "container-auth.json",
)
DEFAULT_OUT_DIR = Path("minimax-output")


def _auth() -> tuple[str, str]:
    base = os.environ.get(MASTER_ENV, "").strip().rstrip("/")
    token = os.environ.get(TOKEN_ENV, "").strip()
    if base and token:
        return base, token
    for p in AUTH_FILE_CANDIDATES:
        try:
            data = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        base = str(data.get("masterBaseUrl", "")).strip().rstrip("/")
        token = str(data.get("containerToken", "")).strip()
        if base and token:
            return base, token
    raise SystemExit(
        f"MiniMax wrapper requires {MASTER_ENV}/{TOKEN_ENV} env or "
        f"{AUTH_FILE_CANDIDATES[0]}; this command only works inside "
        "OpenClaude commercial containers."
    )


def _endpoint() -> str:
    base, _ = _auth()
    return f"{base}/internal/v3/minimax"


def _token() -> str:
    _, token = _auth()
    return token


def compact_none(value):
    """Drop None fields before zod validation on the master-side proxy."""
    if isinstance(value, dict):
        return {k: compact_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [compact_none(v) for v in value]
    return value


def call_master(kind: str, payload: dict) -> dict:
    data = json.dumps({"kind": kind, "payload": compact_none(payload)}, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        _endpoint(),
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {_token()}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
            "X-Request-Id": uuid.uuid4().hex,
        },
    )
    try:
        with request.urlopen(req, timeout=650) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:2000]
        try:
            parsed = json.loads(body)
            msg = parsed.get("error", {}).get("message") or body
            code = parsed.get("error", {}).get("code") or f"HTTP_{e.code}"
        except Exception:
            code, msg = f"HTTP_{e.code}", body
        raise SystemExit(f"MiniMax request failed: {code}: {msg}") from None
    except error.URLError as e:
        raise SystemExit(f"MiniMax request failed: {e.reason}") from None


def write_files(resp: dict, out: str | None, default_dir: Path = DEFAULT_OUT_DIR) -> list[Path]:
    files = resp.get("files") or ([] if "file" not in resp else [resp["file"]])
    if not isinstance(files, list):
        raise SystemExit("MiniMax response did not contain files")
    paths: list[Path] = []
    if out:
        out_path = Path(out)
        if len(files) == 1 and (out_path.suffix or not out_path.exists()):
            targets = [out_path]
        else:
            out_path.mkdir(parents=True, exist_ok=True)
            targets = [out_path / str(f.get("filename") or f"minimax-{i+1}.bin") for i, f in enumerate(files)]
    else:
        default_dir.mkdir(parents=True, exist_ok=True)
        targets = [default_dir / str(f.get("filename") or f"minimax-{i+1}.bin") for i, f in enumerate(files)]
    for f, path in zip(files, targets):
        b64 = f.get("base64")
        if not isinstance(b64, str):
            raise SystemExit("MiniMax response file missing base64")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(base64.b64decode(b64))
        paths.append(path)
    return paths


def print_billing(resp: dict) -> None:
    billing = resp.get("billing")
    if isinstance(billing, dict):
        cost = billing.get("debited_credits") or billing.get("cost_credits")
        if cost is not None:
            print(f"billing: {cost} credits-cents")


def cmd_image(argv: list[str]) -> None:
    if argv and argv[0] == "generate":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="mmx image generate")
    p.add_argument("prompt_pos", nargs="?")
    p.add_argument("--prompt", "-p")
    p.add_argument("--model", default="image-01")
    p.add_argument("--aspect-ratio", default="16:9")
    p.add_argument("--n", type=int, default=1)
    p.add_argument("--out", "-o")
    ns = p.parse_args(argv)
    prompt = ns.prompt or ns.prompt_pos
    if not prompt:
        p.error("prompt required")
    resp = call_master("image", {"model": ns.model, "prompt": prompt, "aspect_ratio": ns.aspect_ratio, "n": ns.n})
    for path in write_files(resp, ns.out):
        print(path)
    print_billing(resp)


def cmd_speech(argv: list[str]) -> None:
    if argv and argv[0] == "synthesize":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="mmx speech synthesize")
    p.add_argument("--text", required=True)
    p.add_argument("--model", default="speech-2.8-turbo")
    p.add_argument("--voice-id", default="male-qn-qingse")
    p.add_argument("--format", default="mp3")
    p.add_argument("--out", "-o", default="minimax-output/voiceover.mp3")
    ns = p.parse_args(argv)
    resp = call_master("speech", {"model": ns.model, "text": ns.text, "voice_id": ns.voice_id, "format": ns.format})
    for path in write_files(resp, ns.out):
        print(path)
    print_billing(resp)


def cmd_music(argv: list[str]) -> None:
    sub = argv[0] if argv else "generate"
    if sub in {"lyrics", "lyric"}:
        return cmd_lyrics(argv[1:])
    if sub == "generate":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="mmx music generate")
    p.add_argument("--prompt", default="")
    p.add_argument("--lyrics", default="")
    p.add_argument("--model", default="music-2.6")
    p.add_argument("--instrumental", action="store_true")
    p.add_argument("--lyrics-optimizer", action="store_true")
    p.add_argument("--format", default="mp3")
    p.add_argument("--out", "-o", default="minimax-output/music.mp3")
    ns = p.parse_args(argv)
    resp = call_master("music", {
        "model": ns.model,
        "prompt": ns.prompt or None,
        "lyrics": ns.lyrics or None,
        "is_instrumental": ns.instrumental or None,
        "lyrics_optimizer": ns.lyrics_optimizer or None,
        "format": ns.format,
    })
    for path in write_files(resp, ns.out):
        print(path)
    print_billing(resp)


def cmd_lyrics(argv: list[str]) -> None:
    if argv and argv[0] == "generate":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="mmx lyrics generate")
    p.add_argument("--prompt", "-p", required=True)
    p.add_argument("--mode", default="write_full_song")
    p.add_argument("--out", "-o")
    ns = p.parse_args(argv)
    resp = call_master("lyrics", {"prompt": ns.prompt, "mode": ns.mode})
    if ns.out:
        for path in write_files(resp, ns.out):
            print(path)
    else:
        print(resp.get("text", ""))
    print_billing(resp)


def cmd_video(argv: list[str]) -> None:
    sub = argv[0] if argv else "generate"
    if sub == "query":
        p = argparse.ArgumentParser(prog="mmx video query")
        p.add_argument("--task-id", required=True)
        ns = p.parse_args(argv[1:])
        print(json.dumps(call_master("video_query", {"task_id": ns.task_id}).get("raw", {}), ensure_ascii=False, indent=2))
        return
    if sub == "download":
        p = argparse.ArgumentParser(prog="mmx video download")
        p.add_argument("--file-id", required=True)
        p.add_argument("--out", "-o", default="minimax-output/video.mp4")
        ns = p.parse_args(argv[1:])
        resp = call_master("video_download", {"file_id": ns.file_id})
        for path in write_files(resp, ns.out):
            print(path)
        return
    if sub == "generate":
        argv = argv[1:]
    p = argparse.ArgumentParser(prog="mmx video generate")
    p.add_argument("--prompt", "-p", required=True)
    p.add_argument("--model", default="MiniMax-Hailuo-2.3")
    p.add_argument("--duration", type=int, default=6)
    p.add_argument("--resolution", default="768P")
    p.add_argument("--first-frame-image")
    p.add_argument("--last-frame-image")
    p.add_argument("--wait", action="store_true")
    p.add_argument("--timeout", type=int, default=900)
    p.add_argument("--out", "-o")
    ns = p.parse_args(argv)
    resp = call_master("video_generate", {
        "model": ns.model,
        "prompt": ns.prompt,
        "duration": ns.duration,
        "resolution": ns.resolution,
        "first_frame_image": ns.first_frame_image,
        "last_frame_image": ns.last_frame_image,
    })
    task_id = resp.get("task_id")
    print(f"task_id: {task_id}")
    print_billing(resp)
    if not (ns.wait or ns.out):
        return
    deadline = time.time() + ns.timeout
    while time.time() < deadline:
        time.sleep(10)
        q = call_master("video_query", {"task_id": str(task_id)}).get("raw", {})
        status = q.get("status")
        print(f"status: {status}", file=sys.stderr)
        if status == "Success":
            file_id = q.get("file_id")
            if not file_id:
                raise SystemExit("video succeeded but no file_id returned")
            d = call_master("video_download", {"file_id": str(file_id)})
            for path in write_files(d, ns.out or "minimax-output/video.mp4"):
                print(path)
            return
        if status == "Fail":
            raise SystemExit("MiniMax video generation failed")
    raise SystemExit("Timed out waiting for MiniMax video")


def main(argv: list[str]) -> None:
    if not argv or argv[0] in {"-h", "--help"}:
        print("OpenClaude safe MiniMax wrapper (mmx-compatible subset)")
        print("commands: image, speech, music, lyrics, video")
        return
    cmd, rest = argv[0], argv[1:]
    if cmd == "image":
        cmd_image(rest)
    elif cmd == "speech":
        cmd_speech(rest)
    elif cmd == "music":
        cmd_music(rest)
    elif cmd in {"lyrics", "lyric"}:
        cmd_lyrics(rest)
    elif cmd == "video":
        cmd_video(rest)
    elif cmd in {"auth", "quota", "config", "update"}:
        raise SystemExit("This OpenClaude mmx wrapper does not expose MiniMax account/admin commands.")
    else:
        raise SystemExit(f"Unknown mmx command: {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
