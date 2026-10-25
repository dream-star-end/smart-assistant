#!/usr/bin/env python3
"""Generate images and videos with Meta Muse through the OpenClaude Muse bridge (OCV5-561).

  oc-muse image "a red fox in a snowy field, cinematic photo"
  oc-muse image "make the fox blue" --image fox.webp                 # image edit (image + text)
  oc-muse video "a red fox running across a snowy field, cinematic"
  oc-muse video "the fox starts running toward the camera" --image fox.webp   # image to video
  oc-muse video "the fox leaps over a fallen log" --resume <snapshot_id>      # continue

Finished files are saved under /home/agent/.openclaude/generated/ and printed one absolute path
per line, followed by `snapshot_id: <id>` (pass it to --resume to continue from that result).
Videos are a fixed ~10 s clip; there are no duration or resolution options. Text-to-video is
1280x720; image-to-video and resume-with-a-new-image follow the source image's size.
Failures print one JSON line on stderr ({"ok":false,"code":"MUSE_…",...}) and exit 1.
Only enabled accounts can use it (others get MUSE_NOT_ENABLED).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path
from urllib import error, request

# Resolve through the current-bundle symlink once so the running CLI remains
# pinned to one finalized platform revision for its whole invocation.
SELF_ROOT = Path(__file__).resolve().parent.parent

MASTER_ENV = "OPENCLAUDE_V3_MASTER_BASE_URL"
TOKEN_ENV = "OPENCLAUDE_V3_CONTAINER_TOKEN"
AUTH_FILES = (
    Path("/home/agent/.openclaude/container-auth.json"),
    Path.home() / ".openclaude" / "container-auth.json",
)
OUT_DIR_ENV = "OC_MUSE_OUT_DIR"
DEFAULT_OUT_DIR = Path("/home/agent/.openclaude/generated")
TERMINAL = {"succeeded", "failed", "cancelled"}
MAX_SOURCE_BYTES = 3 * 1024 * 1024
MAX_SOURCES = 4
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm"}


class MuseFailure(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, **extra):
        super().__init__(message)
        self.payload = {"ok": False, "code": code, "message": message, "retryable": retryable, **extra}


def auth() -> tuple[str, str]:
    base = os.environ.get(MASTER_ENV, "").strip().rstrip("/")
    token = os.environ.get(TOKEN_ENV, "").strip()
    if base and token:
        return base, token
    for path in AUTH_FILES:
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        base = str(value.get("masterBaseUrl", "")).strip().rstrip("/")
        token = str(value.get("containerToken", "")).strip()
        if base and token:
            return base, token
    raise MuseFailure("MUSE_NOT_IN_CONTAINER", "oc-muse only works inside an OpenClaude Agent container")


def call(method: str, path: str, payload: dict | None = None, timeout: int = 60, raw: bool = False):
    base, token = auth()
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{base}/internal/v3/muse-media{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "X-Request-Id": uuid.uuid4().hex,
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        resp = request.urlopen(req, timeout=timeout)
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:4000]
        try:
            detail = json.loads(body).get("error", {})
        except ValueError:
            detail = {}
        code = detail.get("code") if isinstance(detail, dict) else None
        message = detail.get("message") if isinstance(detail, dict) else None
        if exc.code in (502, 503) and not code:
            code, message = "MUSE_MASTER_UNAVAILABLE", "the platform is restarting; try again shortly"
        raise MuseFailure(
            code or f"HTTP_{exc.code}",
            message or body or f"HTTP {exc.code}",
            bool(detail.get("retryable")) if isinstance(detail, dict) else False,
        ) from None
    except (error.URLError, TimeoutError, ConnectionError) as exc:
        reason = getattr(exc, "reason", exc)
        raise MuseFailure("MUSE_MASTER_UNAVAILABLE", f"cannot reach the platform: {reason}", True) from None
    if raw:
        return resp
    with resp:
        return json.loads(resp.read().decode("utf-8"))


def read_sources(paths: list[str]) -> list[dict]:
    if len(paths) > MAX_SOURCES:
        raise MuseFailure("MUSE_INVALID_INPUT", f"at most {MAX_SOURCES} --image files")
    out = []
    for value in paths:
        path = Path(value).expanduser()
        if not path.is_file():
            raise MuseFailure("MUSE_INVALID_INPUT", f"image file not found: {path}")
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise MuseFailure("MUSE_INVALID_INPUT", f"image file exceeds 3 MiB: {path}")
        out.append({"base64": base64.b64encode(path.read_bytes()).decode("ascii")})
    return out


def download(job_id: str, files: list[dict], out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        idx = int(f["idx"])
        ext = EXT.get(str(f.get("mime")), "bin")
        target = out_dir / f"muse-{job_id[3:11]}-{idx + 1}.{ext}"
        tmp = target.with_suffix(target.suffix + ".part")
        sha = hashlib.sha256()
        resp = call("GET", f"/jobs/{job_id}/files/{idx}", timeout=300, raw=True)
        with resp, tmp.open("wb") as fh:
            for chunk in iter(lambda: resp.read(1024 * 1024), b""):
                sha.update(chunk)
                fh.write(chunk)
        if sha.hexdigest() != f.get("sha256"):
            tmp.unlink(missing_ok=True)
            raise MuseFailure("MUSE_DOWNLOAD_CORRUPT", f"downloaded file {idx} failed its sha256 check", True)
        tmp.replace(target)
        saved.append(target.resolve())
    return saved


def run(kind: str, ns: argparse.Namespace) -> int:
    payload: dict = {"kind": kind, "prompt": ns.prompt}
    if ns.orientation:
        payload["orientation"] = ns.orientation
    if getattr(ns, "aspect_ratio", None):
        payload["aspect_ratio"] = ns.aspect_ratio
    if getattr(ns, "format", None):
        payload["image_format"] = ns.format
    if ns.image:
        payload["source_images"] = read_sources(ns.image)
    if ns.resume:
        payload["resume_snapshot_id"] = ns.resume

    status = call("GET", "/status")
    if not status.get("bridge_online"):
        raise MuseFailure("MUSE_BRIDGE_OFFLINE", "the Muse bridge is not connected; ask the user to start it in the Muse VM")
    job_id = call("POST", "/jobs", payload, timeout=120)["job_id"]

    def cancel(signum, _frame):
        try:
            call("DELETE", f"/jobs/{job_id}", timeout=10)
        except MuseFailure:
            pass
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    deadline = time.monotonic() + ns.timeout
    view: dict = {}
    while time.monotonic() < deadline:
        view = call("GET", f"/jobs/{job_id}?wait=25", timeout=60)
        if view.get("status") in TERMINAL:
            break
    else:
        try:
            call("DELETE", f"/jobs/{job_id}", timeout=10)
        except MuseFailure:
            pass
        raise MuseFailure("MUSE_TIMEOUT", f"no result within {ns.timeout} s", True, job_id=job_id)

    if view.get("status") != "succeeded":
        err = view.get("error") or {}
        raise MuseFailure(
            str(err.get("code") or "MUSE_FAILED"),
            str(err.get("message") or view.get("status")),
            bool(err.get("retryable")),
            job_id=job_id,
            upstream_error_code=err.get("upstream_error_code"),
        )
    out_dir = Path(os.environ.get(OUT_DIR_ENV) or DEFAULT_OUT_DIR)
    paths = download(job_id, view.get("files") or [], out_dir)
    if ns.json:
        print(json.dumps({
            "ok": True,
            "job_id": job_id,
            "files": [str(p) for p in paths],
            "snapshot_id": view.get("snapshot_id"),
        }, ensure_ascii=False))
    else:
        for p in paths:
            print(p)
        if view.get("snapshot_id"):
            print(f"snapshot_id: {view['snapshot_id']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="oc-muse",
        description=__doc__.split("\n\n")[0],
        epilog="Output: absolute file paths (one per line), then `snapshot_id: <id>`.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("prompt", help="what to generate (any language)")
        p.add_argument("--orientation", choices=("square", "vertical", "landscape"))
        p.add_argument("--image", action="append", default=[], metavar="PATH",
                       help="source image (repeatable, up to 4, png/jpg/webp ≤ 3 MiB)")
        p.add_argument("--resume", metavar="SNAPSHOT_ID", help="continue from an earlier result's snapshot_id")
        p.add_argument("--json", action="store_true", help="print one JSON line instead of paths")
        p.add_argument("--timeout", type=int, default=None, help="seconds to wait for the result")

    image = subparsers.add_parser("image", help="text to image, or image edit with --image")
    common(image)
    image.add_argument("--aspect-ratio", dest="aspect_ratio", choices=("4:5", "7:12", "9:16"))
    image.add_argument("--format", choices=("png", "jpg", "webp"), help="image file format")
    video = subparsers.add_parser(
        "video",
        help="text to video, image to video with --image (~10 s clip; no duration or resolution options)",
    )
    common(video)
    video.add_argument("--aspect-ratio", dest="aspect_ratio", choices=("4:5", "7:12", "9:16"))

    ns = parser.parse_args(argv)
    if ns.timeout is None:
        ns.timeout = 600 if ns.command == "video" else 360
    try:
        return run(ns.command, ns)
    except MuseFailure as exc:
        print(json.dumps(exc.payload, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
