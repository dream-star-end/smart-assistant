#!/usr/bin/env python3
"""Muse media bridge: runs inside the Muse VM, dials out to OpenClaude V5 selfhost.

The bridge long-polls the selfhost master over HTTPS for media jobs, runs
/opt/hatch/bin/media-generation for each job (one at a time), uploads the
produced files in checksummed chunks and reports the result.

Standard library only (Python 3.6+). Contains no credentials: the bridge token
is read from <state-dir>/token (mode 0600), which `start` / `set-token` create
by prompting without echo.

Commands:
  start  [--server URL]   save server URL, ask for token if missing, self-check, run in background
  run    [--server URL]   same, in the foreground (for tmux)
  stop | status | check | set-token
  try    image|video "prompt" [--image PATH ..] [--resume SNAPSHOT]   run one job locally, no server

Source images (image editing, image-to-video) take two CLI calls, because
--image-file/--reference-image-* are legacy flags that media_subagent rejects:
--upload-only --image-file .. returns image_ids, which then go into
--conversation-json as {"image": id} items ahead of the text.

Protocol: POST /api/muse-bridge/v1/{hello,poll}, POST /jobs/<id>/heartbeat,
GET /jobs/<id>/sources/<n> (0.5: source images by reference, fetched after the ack),
PUT /jobs/<id>/files/<idx>/chunks/<n>, POST /jobs/<id>/result.
See DESIGN-20261022-muse-media.md §3.
"""

import argparse
import base64
import errno
import fcntl
import getpass
import hashlib
import http.client
import json
import logging
import logging.handlers
import os
import random
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BRIDGE_VERSION = "0.5.2"
API_PREFIX = "/api/muse-bridge/v1"
DEFAULT_CLI = "/opt/hatch/bin/media-generation"
DEFAULT_STATE_DIR = os.path.join(os.path.expanduser("~"), ".muse-bridge")

MIB = 1024 * 1024
# Server may lower these in /hello; it can never raise them above HARD_LIMITS.
DEFAULT_LIMITS = {
    "image_max_bytes": 25 * MIB,
    "video_max_bytes": 64 * MIB,
    "max_files": 4,
    "job_max_bytes": 80 * MIB,
    "chunk_bytes": 4 * MIB,
    "source_max_bytes": 10 * MIB,
    "max_source_images": 4,
    "source_chunk_bytes": 1 * MIB,
}
HARD_LIMITS = {
    "image_max_bytes": 50 * MIB,
    "video_max_bytes": 95 * MIB,
    "max_files": 8,
    "job_max_bytes": 190 * MIB,
    "chunk_bytes": 8 * MIB,
    "source_max_bytes": 20 * MIB,
    "max_source_images": 8,
    "source_chunk_bytes": 4 * MIB,
}

DEFAULT_TIMEOUT = {"image": 120, "video": 300}
MIN_TIMEOUT, MAX_TIMEOUT = 30, 600
KILL_GRACE_SEC = 15
UPLOAD_TIMEOUT_SEC = 120
PROMPT_MAX = 4000
ORIENTATIONS = ("square", "vertical", "landscape")
ASPECT_RATIOS = ("4:5", "7:12", "9:16")
IMAGE_FORMATS = ("png", "jpg", "jpeg", "webp")
POLL_HOLD_DEFAULT = 25
HEARTBEAT_DEFAULT = 15
# The master requeues an un-acked job after 20 s; 3 tries 2 s apart finish well inside that.
ACK_ATTEMPTS = 3
ACK_RETRY_SEC = 2
# Per Range chunk against Hub/CDN short reads (prod 2026-10-26: 3 tries exhausted).
SOURCE_CHUNK_ATTEMPTS = 8
SOURCE_CHUNK_SLEEP_CAP = 8
# 0.5.2: a Range body cut short in transit keeps what arrived and the next request resumes after
# it, so a relay that drops ~11% of every response still converges (prod 2026-10-26 uid 1931:
# 1 MiB ranges came through as 930222 bytes on 8 tries in a row). Such reads are not failed
# attempts; this caps them per source image so a path that trickles bytes still ends.
SOURCE_SHORT_READS_MAX = 64
BACKOFF_MAX = 60
# Jobs this bridge runs at once: the smaller of --max-concurrency and the master's hello
# `max_concurrency` (a master that does not send it gets one, as before 0.4.0).
MAX_CONCURRENCY_HARD = 16
LOG_MAX_BYTES = 5 * MIB

URL_RE = re.compile(r"https?://\S+")
IMAGE_ID_RE = re.compile(r"^[A-Za-z0-9:_.-]{1,128}$")
SNAPSHOT_RE = re.compile(r"^[A-Za-z0-9:_.-]{1,200}$")

log = logging.getLogger("muse-bridge")


class FatalAuth(Exception):
    """Token rejected or session superseded: stop instead of retrying."""


class Blocked(FatalAuth):
    """A 401/403 that the selfhost master did not write (VM egress proxy, Cloudflare, ...)."""


class JobGone(Exception):
    """Master no longer knows this job (410): drop it."""


class SessionLost(Exception):
    """The master no longer knows this session (it restarted): say hello again."""


class StopRequested(Exception):
    pass


# --------------------------------------------------------------------------
# files under the state dir


def state_paths(state_dir):
    return {
        "dir": state_dir,
        "token": os.path.join(state_dir, "token"),
        "server": os.path.join(state_dir, "server"),
        "pid": os.path.join(state_dir, "bridge.pid"),
        "lock": os.path.join(state_dir, "bridge.lock"),
        "log": os.path.join(state_dir, "bridge.log"),
    }


def ensure_state_dir(paths):
    os.makedirs(paths["dir"], mode=0o700, exist_ok=True)
    os.chmod(paths["dir"], 0o700)


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path, 0o600)


def read_token(paths):
    path = paths["token"]
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    if st.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        os.chmod(path, 0o600)
    with open(path) as f:
        token = f.read().strip()
    return token or None


def prompt_token(paths):
    if not sys.stdin.isatty():
        raise SystemExit("没有 token 文件 %s，且当前不是交互终端。请先运行 set-token。" % paths["token"])
    token = getpass.getpass("粘贴 bridge token（不回显）: ").strip()
    if not token:
        raise SystemExit("token 为空，已取消。")
    if not token.startswith("mbr_"):
        print("提示：token 通常以 mbr_ 开头，请确认粘贴的是 bridge token。", file=sys.stderr)
    write_private(paths["token"], token)
    print("token 已保存到 %s（0600）。" % paths["token"])
    return token


def normalize_server(url):
    url = (url or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    local = parsed.hostname in ("127.0.0.1", "localhost", "::1")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise ValueError("server 必须是 https:// 地址（本机测试可用 http://127.0.0.1）")
    if not parsed.hostname:
        raise ValueError("server 地址缺少主机名")
    return "%s://%s" % (parsed.scheme, parsed.netloc)


def read_server(paths):
    try:
        with open(paths["server"]) as f:
            return normalize_server(f.read())
    except FileNotFoundError:
        return None


def server_host(url):
    return urllib.parse.urlparse(url).netloc if url else "(未设置)"


# --------------------------------------------------------------------------
# job validation and CLI invocation (pure, unit-tested)


def _clamp_limit(server_limits, key):
    value = DEFAULT_LIMITS[key]
    if isinstance(server_limits, dict):
        v = server_limits.get(key)
        if isinstance(v, int) and not isinstance(v, bool) and v > 0:
            value = v
    return min(value, HARD_LIMITS[key])


def effective_limits(server_limits=None):
    return {k: _clamp_limit(server_limits, k) for k in DEFAULT_LIMITS}


def effective_slots(server_value, local_max):
    """Jobs to run at once: the master's offer (1 when absent or invalid), never above local_max."""
    offered = server_value if isinstance(server_value, int) and not isinstance(server_value, bool) else 1
    return max(1, min(offered, local_max, MAX_CONCURRENCY_HARD))


def sniff_mime(head):
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[4:8] == b"ftyp":
        return "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    return None


MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
}


class JobError(Exception):
    def __init__(self, code, message, retryable=False, **extra):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.extra = extra

    def result(self):
        body = {"ok": False, "error_code": self.code, "error_message": self.message, "retryable": self.retryable}
        body.update({k: v for k, v in self.extra.items() if v is not None})
        return body


def _check_source_ref(item, limits, n):
    if not isinstance(item, dict) or item.get("n") != n:
        raise JobError("MUSE_INVALID_INPUT", "source_refs[%d] 格式错误" % n)
    size = item.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise JobError("MUSE_INVALID_INPUT", "source_refs[%d] 大小非法" % n)
    if size > limits["source_max_bytes"]:
        raise JobError("MUSE_INVALID_INPUT", "源图 %d 超过 %d MiB" % (n + 1, limits["source_max_bytes"] // MIB))
    sha = item.get("sha256")
    if not isinstance(sha, str) or not re.match(r"^[0-9a-f]{64}$", sha):
        raise JobError("MUSE_INVALID_INPUT", "source_refs[%d] sha256 非法" % n)
    if item.get("mime") not in ("image/png", "image/jpeg", "image/webp"):
        raise JobError("MUSE_INVALID_INPUT", "源图只支持 png/jpg/webp")
    return {"n": n, "bytes": size, "sha256": sha, "mime": item["mime"]}


def _decode_source_image(item, limits, n):
    if not isinstance(item, dict) or not isinstance(item.get("base64"), str):
        raise JobError("MUSE_INVALID_INPUT", "source_images[%d] 格式错误" % n)
    cap = limits["source_max_bytes"]
    if len(item["base64"]) > cap * 4 // 3 + 8:
        raise JobError("MUSE_INVALID_INPUT", "源图 %d 超过 %d MiB" % (n + 1, cap // MIB))
    try:
        data = base64.b64decode(item["base64"], validate=True)
    except Exception:
        raise JobError("MUSE_INVALID_INPUT", "源图 %d base64 无法解码" % (n + 1))
    if len(data) > cap:
        raise JobError("MUSE_INVALID_INPUT", "源图 %d 超过 %d MiB" % (n + 1, cap // MIB))
    mime = sniff_mime(data[:16])
    if mime not in ("image/png", "image/jpeg", "image/webp"):
        raise JobError("MUSE_INVALID_INPUT", "源图只支持 png/jpg/webp")
    return data, MIME_EXT[mime]


def validate_job(job, limits):
    """Return a normalized job dict or raise JobError(MUSE_INVALID_INPUT)."""
    if not isinstance(job, dict):
        raise JobError("MUSE_INVALID_INPUT", "job 不是对象")
    jid = job.get("id")
    if not isinstance(jid, str) or not re.match(r"^[A-Za-z0-9_-]{1,80}$", jid):
        raise JobError("MUSE_INVALID_INPUT", "job id 非法")
    kind = job.get("kind")
    if kind not in ("image", "video"):
        raise JobError("MUSE_INVALID_INPUT", "kind 只能是 image 或 video")
    prompt = job.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > PROMPT_MAX:
        raise JobError("MUSE_INVALID_INPUT", "prompt 为空或超过 %d 字" % PROMPT_MAX)
    out = {"id": jid, "nonce": str(job.get("nonce") or ""), "kind": kind, "prompt": prompt}
    for key, allowed in (("orientation", ORIENTATIONS), ("aspect_ratio", ASPECT_RATIOS), ("image_format", IMAGE_FORMATS)):
        v = job.get(key)
        if v is None:
            continue
        if v not in allowed:
            raise JobError("MUSE_INVALID_INPUT", "%s 只能是 %s" % (key, "/".join(allowed)))
        # --image-output-format only means something for images; video has no
        # format/duration/resolution knobs (fixed ~10 s, backend or source decides).
        if key == "image_format" and kind != "image":
            raise JobError("MUSE_INVALID_INPUT", "image_format 只适用于图片")
        out[key] = v
    timeout = job.get("timeout_secs", DEFAULT_TIMEOUT[kind])
    if not isinstance(timeout, int) or isinstance(timeout, bool):
        timeout = DEFAULT_TIMEOUT[kind]
    if kind == "video":
        timeout = max(timeout, DEFAULT_TIMEOUT["video"])
    out["timeout_secs"] = max(MIN_TIMEOUT, min(MAX_TIMEOUT, timeout))
    sources = job.get("source_images")
    if sources is not None:
        if not isinstance(sources, list):
            raise JobError("MUSE_INVALID_INPUT", "source_images 必须是数组")
        if len(sources) > limits["max_source_images"]:
            raise JobError("MUSE_INVALID_INPUT", "源图最多 %d 张" % limits["max_source_images"])
        out["source_images"] = [_decode_source_image(item, limits, n) for n, item in enumerate(sources)]
    refs = job.get("source_refs")
    if refs == []:
        # 0.5.2: the personal master sends an empty list for a job without sources; same as absent.
        refs = None
    if refs is not None:
        # 0.5: the master sends references instead of inline data; fetched after the ack.
        if sources:
            raise JobError("MUSE_INVALID_INPUT", "source_images 与 source_refs 不能同时出现")
        if not isinstance(refs, list) or not refs:
            raise JobError("MUSE_INVALID_INPUT", "source_refs 必须是非空数组")
        if len(refs) > limits["max_source_images"]:
            raise JobError("MUSE_INVALID_INPUT", "源图最多 %d 张" % limits["max_source_images"])
        out["source_refs"] = [_check_source_ref(item, limits, n) for n, item in enumerate(refs)]
    snap = job.get("resume_snapshot_id")
    if snap is not None:
        if not isinstance(snap, str) or not SNAPSHOT_RE.match(snap):
            raise JobError("MUSE_INVALID_INPUT", "resume_snapshot_id 格式非法")
        out["resume_snapshot_id"] = snap
    return out


def build_upload_argv(cli, image_paths, out_dir):
    """Step 1 for source images: --upload-only must not carry any media_subagent flag."""
    argv = [cli, "--upload-only"]
    for path in image_paths:
        argv += ["--image-file", path]
    return argv + ["--output-dir", out_dir]


def build_argv(cli, job, out_dir, image_ids=()):
    """Step 2: media_subagent call. Source images enter only as {"image": id} items, before the text."""
    conversation = [{"image": i} for i in image_ids] + [{"text": job["prompt"]}]
    argv = [
        cli,
        "--media-subagent-output-type", job["kind"],
        "--conversation-json", json.dumps(conversation, ensure_ascii=False),
        "--output-dir", out_dir,
        "--timeout-secs", str(job["timeout_secs"]),
    ]
    if job.get("orientation"):
        argv += ["--orientation", job["orientation"]]
    if job.get("aspect_ratio"):
        argv += ["--aspect-ratio", job["aspect_ratio"]]
    if job["kind"] == "image" and job.get("image_format"):
        argv += ["--image-output-format", job["image_format"]]
    if job.get("resume_snapshot_id"):
        argv += ["--resume-from-snapshot-id", job["resume_snapshot_id"]]
    return argv


def redact(text, limit=500):
    text = URL_RE.sub("<url>", text or "")
    return text[-limit:]


TAG_RE = re.compile(r"<(script|style)\b.*?</\1>|<[^>]+>", re.S | re.I)
# Text from a proxy or CDN error page is untrusted: before it is printed or logged, drop anything
# that could be a credential (tokens, auth headers, cookies, user:pass@, long opaque strings) or a
# link, including JSON-escaped ones.
SECRET_RES = (
    (re.compile(r"https?:(?:\\?/){2}\S*", re.I), "<url>"),
    # Header-style and JSON-style fields alike: `Cookie: a=b`, `"password":"x"`, `token='x'`.
    # A value that opens with a quote ends at the matching unescaped quote; any other
    # auth/cookie value runs to the end of its line, so quotes inside it cannot end it early.
    (re.compile(r"""["']?\b((?:proxy-)?authorization|(?:set-)?cookie)\b["']?\s*[:=]\s*"""
                r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n]*)""", re.I), r"\1: <redacted>"),
    (re.compile(r"""["']?\b(password|passwd|pwd|secret|token|access[_-]?token|api[_-]?key|session[_-]?id)\b"""
                r"""["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&<>]+)""", re.I),
     r"\1=<redacted>"),
    (re.compile(r"\b(?:basic|bearer|digest|negotiate)\s+\S+", re.I), "<redacted>"),
    (re.compile(r"\S+:\S*@"), "<redacted>@"),
    (re.compile(r"mbr_[A-Za-z0-9_-]*"), "mbr_<redacted>"),
    (re.compile(r"[A-Za-z0-9+/_=-]{24,}"), "<redacted>"),
)


def scrub(text):
    for pattern, repl in SECRET_RES:
        text = pattern.sub(repl, text)
    return text


def master_error_code(payload):
    """error.code of a JSON error body the selfhost master wrote, else None."""
    try:
        err = json.loads(payload.decode("utf-8")).get("error")
    except (ValueError, AttributeError, UnicodeDecodeError):
        return None
    code = err.get("code") if isinstance(err, dict) else None
    return code if isinstance(code, str) else None


def proxy_for(url):
    """host:port of the proxy urllib will use for url (credentials dropped), or 无."""
    proxy = urllib.request.getproxies().get(urllib.parse.urlsplit(url).scheme)
    if not proxy or urllib.request.proxy_bypass(urllib.parse.urlsplit(url).hostname or ""):
        return "无"
    return urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy).netloc.rpartition("@")[2]


def describe_foreign(status, headers, payload, url):
    """One line saying who most likely answered status instead of the master."""
    server = (headers.get("Server") if headers else None) or "-"
    ray = (headers.get("cf-ray") if headers else None) or "-"
    # Scrub before collapsing whitespace: a header-style value ends at its line break.
    text = " ".join(scrub(TAG_RE.sub("\n", payload[:4096].decode("utf-8", "replace"))).split())
    return ("HTTP %d 不是个人版服务端返回的（Server: %s，cf-ray: %s，本机代理: %s）。"
            "多半是 Muse VM 的出口代理或 Cloudflare 拦截了请求，换 token 没有用。响应摘要：%s"
            % (status, scrub(server)[:80], scrub(ray)[:40], proxy_for(url), text[:160] or "（空）"))


def parse_contract(stdout):
    """The CLI prints one JSON line; take the last line that parses as an object."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def map_upload_outcome(exit_code, stdout, stderr, expected):
    """Return the image ids printed by --upload-only, or raise MUSE_UPLOAD_FAILED."""
    contract = parse_contract(stdout)
    if exit_code == 0 and contract and contract.get("ok") is not False:
        ids = contract.get("image_ids")
        if (isinstance(ids, list) and len(ids) == expected
                and all(isinstance(i, (str, int)) and IMAGE_ID_RE.match(str(i)) for i in ids)):
            return [str(i) for i in ids]
        raise JobError("MUSE_UPLOAD_FAILED", "上传成功但 image_ids 数量或格式不对", exit_code=0)
    retryable = bool(contract and contract.get("retryable") is True)
    message = contract.get("error_message") if contract else None
    raise JobError(
        "MUSE_UPLOAD_FAILED",
        "源图上传失败（退出码 %s）：%s" % (exit_code, redact(str(message or stderr or stdout), 300)),
        retryable,
        exit_code=exit_code,
        upstream_error_code=contract.get("error_code") if contract else None,
    )


def map_cli_outcome(exit_code, stdout, stderr):
    """Return the parsed success contract or raise JobError per DESIGN §9."""
    contract = parse_contract(stdout)
    if exit_code == 2:
        raise JobError("MUSE_BAD_ARGS", "media-generation 参数错误：" + redact(stderr, 300), exit_code=2)
    if exit_code == 0 and contract and contract.get("ok") is True:
        paths = contract.get("media_paths")
        if not isinstance(paths, list) or not paths:
            raise JobError("MUSE_BAD_OUTPUT", "成功返回但没有 media_paths", exit_code=0)
        return contract
    if contract and contract.get("ok") is False:
        upstream = contract.get("error_code")
        message = redact(str(contract.get("error_message") or ""), 500)
        extra = {
            "exit_code": exit_code,
            "upstream_error_code": upstream,
            "downstream_status": contract.get("downstream_status"),
        }
        if upstream == "video_not_available":
            raise JobError("MUSE_VIDEO_REGION_BLOCKED", message or "当前 Muse 账号所在地区不支持视频生成", False, **extra)
        if contract.get("retryable") is True:
            raise JobError("MUSE_UPSTREAM_ERROR", message or "Muse 后端暂时出错", True, **extra)
        raise JobError("MUSE_UPSTREAM_REJECTED", message or "Muse 后端拒绝了请求", False, **extra)
    raise JobError(
        "MUSE_BAD_OUTPUT",
        "media-generation 退出码 %s，输出无法识别：%s" % (exit_code, redact(stderr or stdout, 300)),
        exit_code=exit_code,
    )


def collect_outputs(contract, out_dir, kind, limits):
    """Validate media_paths: inside out_dir, regular files, known type, within limits."""
    root = os.path.realpath(out_dir)
    per_file = limits["video_max_bytes" if kind == "video" else "image_max_bytes"]
    files, total = [], 0
    paths = contract["media_paths"]
    if len(paths) > limits["max_files"]:
        raise JobError("MUSE_FILE_TOO_LARGE", "文件数 %d 超过上限 %d" % (len(paths), limits["max_files"]))
    for idx, raw in enumerate(paths):
        if not isinstance(raw, str):
            raise JobError("MUSE_BAD_OUTPUT", "media_paths 含非字符串")
        real = os.path.realpath(raw)
        if not real.startswith(root + os.sep):
            raise JobError("MUSE_BAD_OUTPUT", "成品文件不在本任务输出目录内，拒绝上传")
        st = os.lstat(raw)
        if not stat.S_ISREG(st.st_mode):
            raise JobError("MUSE_BAD_OUTPUT", "成品不是普通文件")
        if st.st_size > per_file:
            raise JobError("MUSE_FILE_TOO_LARGE", "单个文件 %.1f MiB 超过上限 %d MiB" % (st.st_size / MIB, per_file // MIB))
        total += st.st_size
        if total > limits["job_max_bytes"]:
            raise JobError("MUSE_FILE_TOO_LARGE", "本任务文件总量超过 %d MiB" % (limits["job_max_bytes"] // MIB))
        with open(real, "rb") as f:
            mime = sniff_mime(f.read(16))
        allowed = ("video/mp4", "video/webm") if kind == "video" else ("image/png", "image/jpeg", "image/webp")
        if mime not in allowed:
            raise JobError("MUSE_BAD_OUTPUT", "成品文件类型不符（%s）" % (mime or "未知"))
        files.append({"idx": idx, "path": real, "mime": mime, "bytes": st.st_size,
                      "filename": "muse-%s-%d.%s" % (kind, idx + 1, MIME_EXT[mime])})
    return files


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(MIB), b""):
            h.update(block)
    return h.hexdigest()


# --------------------------------------------------------------------------
# running one job locally


class CliRunner:
    def __init__(self, cli):
        self.cli = cli
        self._proc = None
        self._lock = threading.Lock()

    def kill(self):
        with self._lock:
            proc = self._proc
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _exec(self, argv, cwd, limit_sec, cancel_event, what):
        """Run one CLI process in its own group; returns (exit_code, stdout, stderr)."""
        hard_deadline = time.monotonic() + limit_sec
        proc = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, cwd=cwd,
        )
        with self._lock:
            self._proc = proc
        killed_for = None
        try:
            while True:
                try:
                    out, err = proc.communicate(timeout=1)
                    break
                except subprocess.TimeoutExpired:
                    if killed_for:
                        continue
                    if cancel_event.is_set():
                        killed_for = "cancel"
                        self.kill()
                    elif time.monotonic() > hard_deadline:
                        killed_for = "timeout"
                        self.kill()
        finally:
            with self._lock:
                self._proc = None
        # The heartbeat thread may kill the process itself before this loop notices.
        if killed_for is None and cancel_event.is_set():
            killed_for = "cancel"
        if killed_for == "cancel":
            raise JobError("MUSE_CANCELLED", "任务已被取消")
        if killed_for == "timeout":
            raise JobError("MUSE_TIMEOUT", "%s超过 %d 秒未完成" % (what, limit_sec), True)
        return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    def run(self, job, out_dir, cancel_event):
        """Upload source images (if any), then generate. Returns the success contract or raises JobError."""
        if not os.access(self.cli, os.X_OK):
            raise JobError("MUSE_CLI_MISSING", "找不到可执行的 %s" % self.cli)
        image_ids = []
        sources = job.get("source_images") or []
        if sources:
            upload_dir = os.path.join(out_dir, "upload")
            os.mkdir(upload_dir, 0o700)
            paths = []
            for n, (data, ext) in enumerate(sources):
                path = os.path.join(upload_dir, "source-%d.%s" % (n + 1, ext))
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                paths.append(path)
            code, out, err = self._exec(build_upload_argv(self.cli, paths, upload_dir), upload_dir,
                                        UPLOAD_TIMEOUT_SEC, cancel_event, "源图上传")
            image_ids = map_upload_outcome(code, out, err, len(paths))
        media_dir = os.path.join(out_dir, "media")
        os.mkdir(media_dir, 0o700)
        argv = build_argv(self.cli, job, media_dir, image_ids)
        code, out, err = self._exec(argv, out_dir, job["timeout_secs"] + KILL_GRACE_SEC, cancel_event, "生成")
        return map_cli_outcome(code, out, err)



def _check_binary_body(payload, resp_headers, range_hdr, expect_bytes, allow_short=False):
    """Raise IOError on short read or Content-Range that does not match the request Range.

    allow_short: a body shorter than the range is a prefix the caller resumes after (0.5.2).

    Retried by with_retries around get_source. A persistent mismatch still surfaces as
    MUSE_SOURCE_FETCH_FAILED (retryable) after attempts are exhausted.
    """
    want = expect_bytes
    if range_hdr:
        m_req = re.match(r"bytes=(\d+)-(\d+)$", range_hdr.strip())
        if not m_req:
            raise IOError("invalid request Range %r" % range_hdr)
        req_a, req_b = int(m_req.group(1)), int(m_req.group(2))
        cr = (resp_headers.get("Content-Range") if resp_headers is not None else None) or ""
        m_cr = re.match(r"bytes (\d+)-(\d+)/(\d+|\*)$", cr.strip())
        if not m_cr:
            raise IOError("missing/invalid Content-Range: %r" % cr)
        got_a, got_b = int(m_cr.group(1)), int(m_cr.group(2))
        if got_a != req_a or got_b != req_b:
            raise IOError("Content-Range mismatch: want bytes=%d-%d got %s" % (req_a, req_b, cr))
        want = got_b - got_a + 1
    if len(payload) > want or (len(payload) < want and not allow_short):
        raise IOError("short read: got %d want %d" % (len(payload), want))


class ShortRead(IOError):
    """A binary body cut short in transit; .partial holds the bytes that did arrive (0.5.2)."""

    def __init__(self, partial, status, headers):
        super().__init__("incomplete read (%d bytes)" % len(partial))
        self.partial, self.status, self.headers = partial, status, headers


# --------------------------------------------------------------------------
# HTTP client


class Client:
    def __init__(self, server, token):
        self.server = server
        self._token = token
        self.session_id = None
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler())

    def _request(self, method, path, body=None, raw=None, headers=None, timeout=30, binary=False,
                 expect_bytes=None):
        url = self.server + API_PREFIX + path
        hdrs = {
            "Authorization": "Bearer " + self._token,
            "User-Agent": "muse-bridge/" + BRIDGE_VERSION,
        }
        if self.session_id:
            hdrs["X-Muse-Bridge-Session"] = self.session_id
        data = None
        if raw is not None:
            data = raw
            hdrs["Content-Type"] = "application/octet-stream"
        elif body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        if binary:
            # Avoid CDN/gzip transforming Range bodies (Content-Length vs decoded length mismatch).
            hdrs["Accept-Encoding"] = "identity"
        if headers:
            hdrs.update(headers)
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                status = resp.status
                resp_headers = resp.headers
                try:
                    payload = resp.read()
                except http.client.IncompleteRead as e:
                    if binary:
                        raise ShortRead(e.partial or b"", status, resp_headers) from e
                    raise IOError("incomplete read (%d bytes)" % len(e.partial or b"")) from e
        except urllib.error.HTTPError as e:
            status = e.code
            payload = e.read() if e.fp else b""
            resp_headers = e.headers
        except urllib.error.URLError as e:
            reason = getattr(e, "reason", None)
            if isinstance(reason, http.client.IncompleteRead):
                raise IOError("incomplete read (%d bytes)" % len(reason.partial or b"")) from e
            raise
        except http.client.IncompleteRead as e:
            raise IOError("incomplete read (%d bytes)" % len(e.partial or b"")) from e
        # Only the master's own JSON errors mean "token rejected" / "superseded"; the same status
        # from a proxy or the CDN in front of it must not send the user off to rotate the token.
        if status in (401, 403, 409):
            code = master_error_code(payload)
            if status == 401 and code == "UNAUTHORIZED":
                raise FatalAuth("token 被个人版服务端拒绝（HTTP 401），请检查或重新签发 token")
            if status == 409 and code == "SUPERSEDED":
                raise FatalAuth("已有新的 bridge 接管连接（HTTP 409），本实例退出")
            if status != 409:
                raise Blocked(describe_foreign(status, resp_headers, payload, url))
        if status == 410:
            raise JobGone()
        if status == 400 and master_error_code(payload) == "SESSION_UNKNOWN":
            raise SessionLost("master 不再认识本会话（可能已重启），重新连接")
        if status == 204:
            return None
        if status >= 400:
            raise IOError("HTTP %d %s" % (status, path.split("/")[1] if "/" in path else path))
        if binary:
            if expect_bytes is not None:
                _check_binary_body(payload, resp_headers, hdrs.get("Range"), expect_bytes)
            return payload
        if not payload:
            return None
        return json.loads(payload.decode("utf-8"))

    def hello(self, cli, cli_version):
        self.session_id = None
        resp = self._request("POST", "/hello", {
            "bridge_version": BRIDGE_VERSION,
            "hostname_hash": hashlib.sha256(socket.gethostname().encode()).hexdigest()[:16],
            "cli_path": cli,
            "cli_version": cli_version,
            "cli_ok": os.access(cli, os.X_OK),
        })
        if not isinstance(resp, dict) or not isinstance(resp.get("session_id"), str):
            raise IOError("hello 响应缺少 session_id")
        self.session_id = resp["session_id"]
        return resp

    def poll(self, hold):
        return self._request("POST", "/poll", {}, timeout=hold + 15)

    def heartbeat(self, job):
        return self._request("POST", "/jobs/%s/heartbeat" % job["id"], {"job_nonce": job["nonce"]}, timeout=20)

    def get_source(self, job, n, start, end):
        """Bytes start..end (inclusive) of source image n of an acked job (0.5).

        Sends Accept-Encoding: identity and checks Content-Range + body length so a CDN
        short read / IncompleteRead raises and is retried by fetch_sources.
        """
        want = end - start + 1
        range_hdr = "bytes=%d-%d" % (start, end)
        try:
            return self._request(
                "GET", "/jobs/%s/sources/%d" % (job["id"], n),
                headers={
                    "X-Job-Nonce": job["nonce"],
                    "Range": range_hdr,
                    "Accept-Encoding": "identity",
                },
                timeout=60, binary=True, expect_bytes=want,
            )
        except ShortRead as e:
            # 0.5.2: same checks as a whole body; the prefix that arrived is returned for resuming.
            if e.status != 206 or not e.partial:
                raise IOError(str(e)) from e
            _check_binary_body(e.partial, e.headers, range_hdr, want, allow_short=True)
            return e.partial

    def put_chunk(self, job, idx, n, chunk):
        self._request(
            "PUT", "/jobs/%s/files/%d/chunks/%d" % (job["id"], idx, n), raw=chunk,
            headers={"X-Chunk-Sha256": hashlib.sha256(chunk).hexdigest(), "X-Job-Nonce": job["nonce"]},
            timeout=120,
        )

    def result(self, job, body):
        body = dict(body)
        body["job_nonce"] = job["nonce"]
        return self._request("POST", "/jobs/%s/result" % job["id"], body, timeout=60)


def with_retries(fn, attempts=3, sleep_cap=None):
    for i in range(attempts):
        try:
            return fn()
        except (FatalAuth, JobGone):
            raise
        except Exception:
            if i == attempts - 1:
                raise
            delay = 2 ** i
            if sleep_cap is not None:
                delay = min(delay, sleep_cap)
            time.sleep(delay)


# --------------------------------------------------------------------------
# bridge main loop


class Bridge:
    def __init__(self, paths, cli, max_concurrency=1):
        self.paths = paths
        self.cli = cli
        self.max_concurrency = max(1, min(int(max_concurrency), MAX_CONCURRENCY_HARD))
        self.stop = threading.Event()
        self.cli_version = cli_version(cli)
        # Held while a worker polls or runs a job. Workers of an ended session keep their job
        # (and slot) until it finishes, so a reconnect never pushes the total above the local cap.
        self.slots = threading.BoundedSemaphore(self.max_concurrency)
        self._runners = set()
        self._runners_lock = threading.Lock()

    def _track(self, runner, add):
        with self._runners_lock:
            (self._runners.add if add else self._runners.discard)(runner)

    def request_stop(self, *_):
        self.stop.set()
        with self._runners_lock:
            runners = list(self._runners)
        for runner in runners:
            runner.kill()
        if not runners:
            raise StopRequested()

    def serve(self):
        backoff = 1
        while not self.stop.is_set():
            server = read_server(self.paths)
            token = read_token(self.paths)
            if not server or not token:
                log.error("缺少 server 或 token 文件，退出")
                return 1
            client = Client(server, token)
            try:
                hello = client.hello(self.cli, self.cli_version)
                log.info("已连接 %s（session %s…）", server_host(server), client.session_id[:8])
                backoff = 1
                self.loop(client, hello)
            except Blocked as e:
                log.error("%s", e)
                return 3
            except FatalAuth as e:
                log.error("%s", e)
                return 2
            except StopRequested:
                break
            except Exception as e:
                delay = min(BACKOFF_MAX, backoff) * random.uniform(0.8, 1.2)
                log.warning("连接中断：%s；%.0f 秒后重连", redact(str(e), 200), delay)
                backoff = min(BACKOFF_MAX, backoff * 2)
                if self.stop.wait(delay):
                    break
        log.info("bridge 已停止")
        return 0

    def loop(self, client, hello):
        hold = int(hello.get("poll_hold_sec") or POLL_HOLD_DEFAULT)
        heartbeat = max(5, min(30, int(hello.get("heartbeat_sec") or HEARTBEAT_DEFAULT)))
        limits = effective_limits(hello.get("limits"))
        workers = effective_slots(hello.get("max_concurrency"), self.max_concurrency)
        if workers > 1:
            log.info("并发 %d 路", workers)
        ended = threading.Event()
        reasons = []

        def end(reason):
            if not reasons:
                reasons.append(reason)
            ended.set()

        def worker():
            backoff = 1
            while not self.stop.is_set() and not ended.is_set():
                if not self.slots.acquire(timeout=1):
                    continue
                delay = 0
                try:
                    if self.stop.is_set() or ended.is_set():
                        return
                    resp = client.poll(hold)
                    backoff = 1
                    if resp and resp.get("job"):
                        self.handle_job(client, resp["job"], limits, heartbeat)
                except (FatalAuth, SessionLost) as e:
                    # Session-wide: a reconnect (or exit) is the only way forward.
                    end(e)
                    return
                except Exception as e:
                    # One slot's network trouble must not drop the session: a new hello would make
                    # the master fail every job the other slots are running.
                    delay = min(BACKOFF_MAX, backoff) * random.uniform(0.8, 1.2)
                    log.warning("轮询失败：%s；%.0f 秒后重试", redact(str(e), 200), delay)
                    backoff = min(BACKOFF_MAX, backoff * 2)
                finally:
                    self.slots.release()
                if delay and self.stop.wait(delay):
                    return

        threads = [threading.Thread(target=worker, daemon=True) for _ in range(workers)]
        for t in threads:
            t.start()
        try:
            while not ended.wait(1):
                if self.stop.is_set():
                    break
        except StopRequested:
            self.stop.set()
        ended.set()
        if self.stop.is_set():
            # Let slots that were running a job report it (MUSE_BRIDGE_LOST) before the process
            # exits; idle long-polls are simply abandoned.
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and any(t.is_alive() for t in threads):
                with self._runners_lock:
                    busy = bool(self._runners)
                if not busy:
                    break
                time.sleep(0.2)
            raise StopRequested()
        raise reasons[0] if reasons else IOError("会话结束")

    def handle_job(self, client, raw_job, limits, heartbeat_sec):
        started = time.monotonic()
        jid = raw_job.get("id") if isinstance(raw_job, dict) else None
        cancel = threading.Event()
        job_ref = {"id": jid, "nonce": str(raw_job.get("nonce") or "") if isinstance(raw_job, dict) else ""}
        hb_stop = threading.Event()
        # One runner per job: a heartbeat still in flight when this job ends can only ever kill
        # this job's process, never the next job's.
        runner = CliRunner(self.cli)

        def stop_job():
            if hb_stop.is_set():
                return
            cancel.set()
            runner.kill()

        def beat():
            while not hb_stop.wait(heartbeat_sec):
                try:
                    r = client.heartbeat(job_ref)
                    if isinstance(r, dict) and r.get("cancel"):
                        stop_job()
                except (JobGone, FatalAuth):
                    stop_job()
                except Exception as e:
                    log.warning("heartbeat 失败：%s", redact(str(e), 120))

        # Ack barrier: start nothing until the master confirmed this exact job/nonce. Without
        # the confirmation the master may requeue the job with a new nonce, so running it
        # here could produce a second, duplicate generation.
        # Stopping: leave the job un-acked; the master requeues it.
        if self.stop.is_set():
            return
        if not jid or not self.ack(client, job_ref):
            log.info("任务 %s 未获确认，放弃（不执行）", jid)
            return

        out_dir = tempfile.mkdtemp(prefix="muse-job-")
        os.chmod(out_dir, 0o700)
        hb = None
        kind = raw_job.get("kind") if isinstance(raw_job, dict) else None
        self._track(runner, True)
        try:
            if jid:
                hb = threading.Thread(target=beat, daemon=True)
                hb.start()
            try:
                job = validate_job(raw_job, limits)
                if job.get("source_refs"):
                    job["source_images"] = self.fetch_sources(client, job_ref, job["source_refs"], limits, cancel)
                log.info("任务 %s 开始：%s", job["id"], job["kind"])
                contract = runner.run(job, out_dir, cancel)
                files = collect_outputs(contract, os.path.join(out_dir, "media"), job["kind"], limits)
                self.upload(client, job, files, limits, cancel)
                body = {
                    "ok": True,
                    "files": [{k: f[k] for k in ("idx", "filename", "mime", "bytes", "sha256", "chunks")} for f in files],
                    "meta": {
                        "media_type": contract.get("media_type") or job["kind"],
                        "artifact_ids": contract.get("artifact_ids") or [],
                        "snapshot_id": contract.get("snapshot_id"),
                    },
                }
                total = sum(f["bytes"] for f in files)
                log.info("任务 %s 成功：%d 个文件，%.1f KiB，%.0f 秒", job["id"], len(files), total / 1024,
                         time.monotonic() - started)
            except JobError as e:
                if self.stop.is_set():
                    e = JobError("MUSE_BRIDGE_LOST", "bridge 正在停止")
                body = e.result()
                log.info("任务 %s 失败：%s（%s）%.0f 秒", jid, e.code, kind, time.monotonic() - started)
            if jid:
                # The runner stays tracked until the result is posted, so a stop waits for it.
                try:
                    with_retries(lambda: client.result(job_ref, body))
                except JobGone:
                    log.info("任务 %s 在 master 侧已失效，结果丢弃", jid)
        finally:
            self._track(runner, False)
            hb_stop.set()
            shutil.rmtree(out_dir, ignore_errors=True)

    def fetch_sources(self, client, job_ref, refs, limits, cancel):
        """Download every referenced source image in Range chunks; [(data, ext)] like inline ones.

        A download that keeps failing ends the job with a normal (retryable) result instead of
        leaving it to the master's timeouts. JobGone (the master reassigned the job) propagates.
        """
        step = limits["source_chunk_bytes"]
        out = []
        for ref in refs:
            buf = bytearray()
            failures = 0
            short_reads = 0
            while len(buf) < ref["bytes"]:
                if cancel.is_set():
                    raise JobError("MUSE_CANCELLED", "任务已被取消")
                start = len(buf)
                end = min(ref["bytes"], start + step) - 1
                try:
                    data = client.get_source(job_ref, ref["n"], start, end)
                except (FatalAuth, JobGone):
                    raise
                except Exception as e:
                    failures += 1
                    if failures >= SOURCE_CHUNK_ATTEMPTS:
                        raise JobError("MUSE_SOURCE_FETCH_FAILED",
                                       "源图 %d 下载失败：%s" % (ref["n"] + 1, redact(str(e), 120)), retryable=True)
                    cancel.wait(min(2 ** (failures - 1), SOURCE_CHUNK_SLEEP_CAP))
                    continue
                if not data or len(data) > end - start + 1:
                    raise JobError("MUSE_SOURCE_FETCH_FAILED", "源图 %d 下载长度不符" % (ref["n"] + 1), retryable=True)
                # Progress (a whole range, or the prefix of one cut short): never a failed attempt.
                failures = 0
                if len(data) < end - start + 1:
                    short_reads += 1
                    if short_reads > SOURCE_SHORT_READS_MAX:
                        raise JobError("MUSE_SOURCE_FETCH_FAILED",
                                       "源图 %d 下载失败：传输反复被截断" % (ref["n"] + 1), retryable=True)
                buf += data
            data = bytes(buf)
            if hashlib.sha256(data).hexdigest() != ref["sha256"]:
                raise JobError("MUSE_SOURCE_FETCH_FAILED", "源图 %d 校验失败" % (ref["n"] + 1), retryable=True)
            mime = sniff_mime(data[:16])
            if mime != ref["mime"]:
                raise JobError("MUSE_INVALID_INPUT", "源图 %d 类型与声明不符" % (ref["n"] + 1))
            out.append((data, MIME_EXT[mime]))
        return out

    def ack(self, client, job_ref):
        """First heartbeat for a new job. True only on a 200 from the master."""
        for attempt in range(ACK_ATTEMPTS):
            try:
                client.heartbeat(job_ref)
                return True
            except JobGone:
                return False
            except FatalAuth:
                raise
            except Exception as e:
                log.warning("任务确认失败（第 %d 次）：%s", attempt + 1, redact(str(e), 120))
                if attempt < ACK_ATTEMPTS - 1 and self.stop.wait(ACK_RETRY_SEC):
                    return False
        return False

    def upload(self, client, job, files, limits, cancel):
        size = limits["chunk_bytes"]
        for f in files:
            f["sha256"] = sha256_file(f["path"])
            n = 0
            with open(f["path"], "rb") as fh:
                while True:
                    if cancel.is_set():
                        raise JobError("MUSE_CANCELLED", "任务已被取消")
                    chunk = fh.read(size)
                    if not chunk and n > 0:
                        break
                    with_retries(lambda c=chunk, i=n: client.put_chunk(job, f["idx"], i, c))
                    n += 1
                    if len(chunk) < size:
                        break
            f["chunks"] = n


def cli_version(cli):
    try:
        r = subprocess.run([cli, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=10)
        return r.stdout.decode("utf-8", "replace").strip()[:80] or None
    except Exception:
        return None


# --------------------------------------------------------------------------
# process management


def acquire_lock(paths):
    fd = os.open(paths["lock"], os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        os.close(fd)
        if e.errno in (errno.EAGAIN, errno.EACCES):
            return None
        raise
    return fd


def running_pid(paths):
    fd = acquire_lock(paths)
    if fd is not None:
        os.close(fd)
        return None
    try:
        with open(paths["pid"]) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return -1


def setup_logging(paths, foreground):
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.handlers.RotatingFileHandler(paths["log"], maxBytes=LOG_MAX_BYTES, backupCount=2)
    fh.setFormatter(fmt)
    log.addHandler(fh)
    try:
        os.chmod(paths["log"], 0o600)
    except OSError:
        pass
    if foreground:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        log.addHandler(sh)


def daemonize():
    if os.fork() > 0:
        return False
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    return True


def run_bridge(paths, cli, foreground, max_concurrency=1):
    lock_fd = acquire_lock(paths)
    if lock_fd is None:
        if foreground:
            print("已有 bridge 在运行（pid %s）。" % running_pid(paths), file=sys.stderr)
        return 3
    os.umask(0o077)
    write_private(paths["pid"], str(os.getpid()))
    setup_logging(paths, foreground)
    bridge = Bridge(paths, cli, max_concurrency)
    signal.signal(signal.SIGTERM, bridge.request_stop)
    signal.signal(signal.SIGINT, bridge.request_stop)
    log.info("bridge %s 启动，pid %d，server %s，本地并发上限 %d", BRIDGE_VERSION, os.getpid(),
             server_host(read_server(paths)), bridge.max_concurrency)
    try:
        return bridge.serve()
    except StopRequested:
        log.info("bridge 已停止")
        return 0
    finally:
        try:
            os.unlink(paths["pid"])
        except OSError:
            pass
        os.close(lock_fd)


def probe_server(server):
    """Reachability only: any HTTP response (even 404) means TLS + routing work."""
    req = urllib.request.Request(server + "/healthz", headers={"User-Agent": "muse-bridge/" + BRIDGE_VERSION})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler()).open(req, timeout=15) as r:
            return True, "HTTP %d" % r.status
    except urllib.error.HTTPError as e:
        return True, "HTTP %d" % e.code
    except Exception as e:
        return False, redact(str(e), 200)


PROBE_PATH = "/api/muse-bridge/probe"


def probe_bridge_api(server):
    """POST shaped like a real bridge call (JSON body, Bearer header) to a path outside /v1/: the
    master answers its own JSON 404 NOT_FOUND before looking at the token, so this proves the POST
    reaches it without counting as a failed login (the master locks an IP out after repeated ones)
    and without sending the real token or taking over a running bridge."""
    url = server + PROBE_PATH
    req = urllib.request.Request(url, data=b"{}", method="POST", headers={
        "Authorization": "Bearer probe", "Content-Type": "application/json",
        "User-Agent": "muse-bridge/" + BRIDGE_VERSION})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler()).open(req, timeout=15) as r:
            status, headers, payload = r.status, r.headers, r.read(4096)
    except urllib.error.HTTPError as e:
        status, headers, payload = e.code, e.headers, (e.read(4096) if e.fp else b"")
    except Exception as e:
        return False, redact(str(e), 200)
    if status == 404 and master_error_code(payload) == "NOT_FOUND":
        return True, "POST 能到达个人版服务端"
    if status in (401, 403):
        return False, describe_foreign(status, headers, payload, url)
    return False, "HTTP %d，不是个人版服务端的应答，server 地址可能不对" % status


def self_check(paths, cli, verbose=True):
    ok = True

    def say(good, label, detail=""):
        if verbose:
            print("%s %s%s" % ("✓" if good else "✗", label, ("：" + detail) if detail else ""))

    if os.access(cli, os.X_OK):
        try:
            r = subprocess.run([cli, "--help"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=20)
            good = r.returncode == 0 and b"media-subagent-output-type" in r.stdout
            say(good, "media-generation 可运行", cli if good else "退出码 %d" % r.returncode)
            ok &= good
        except Exception as e:
            say(False, "media-generation 可运行", redact(str(e), 120))
            ok = False
    else:
        say(False, "media-generation 存在", "找不到 %s" % cli)
        ok = False
    try:
        d = tempfile.mkdtemp(prefix="muse-check-")
        shutil.rmtree(d)
        say(True, "临时目录可写", tempfile.gettempdir())
    except Exception as e:
        say(False, "临时目录可写", str(e))
        ok = False
    server = read_server(paths)
    if server:
        good, detail = probe_server(server)
        say(good, "能连到 server %s" % server_host(server), detail + "，本机代理: " + proxy_for(server))
        ok &= good
        if good:
            good, detail = probe_bridge_api(server)
            say(good, "bridge 接口可用", detail)
            ok &= good
    else:
        say(False, "server 地址", "未设置（用 --server 指定）")
        ok = False
    tok = os.path.exists(paths["token"])
    say(tok, "token 文件", paths["token"] if tok else "缺失（start 时会提示输入）")
    return ok


# --------------------------------------------------------------------------
# commands


def cmd_start(args, paths, foreground):
    if not 1 <= args.max_concurrency <= MAX_CONCURRENCY_HARD:
        raise SystemExit("--max-concurrency 必须在 1 到 %d 之间" % MAX_CONCURRENCY_HARD)
    ensure_state_dir(paths)
    if args.server:
        write_private(paths["server"], normalize_server(args.server) + "\n")
    if not read_server(paths):
        raise SystemExit("还没有 server 地址：请加 --server https://<个人版域名>")
    pid = running_pid(paths)
    if pid:
        print("bridge 已在运行（pid %s）。需要重启请先 stop。" % pid)
        return 0
    if not read_token(paths):
        prompt_token(paths)
    print("自检：")
    if not self_check(paths, args.cli):
        if not args.force:
            print("自检未通过，没有启动。确认无误可加 --force 强制启动。")
            return 1
    if foreground:
        return run_bridge(paths, args.cli, True, args.max_concurrency)
    sys.stdout.flush()
    sys.stderr.flush()
    if not daemonize():
        for _ in range(30):
            time.sleep(0.2)
            pid = running_pid(paths)
            if pid:
                print("bridge 已在后台启动（pid %s），日志 %s" % (pid, paths["log"]))
                return 0
        print("bridge 没能启动，请看日志 %s" % paths["log"])
        return 1
    code = run_bridge(paths, args.cli, False, args.max_concurrency)
    os._exit(code)


def cmd_stop(args, paths):
    ensure_state_dir(paths)
    pid = running_pid(paths)
    if not pid:
        print("bridge 没有在运行。")
        return 0
    if pid < 0:
        print("bridge 锁被占用但没有 pid 文件，请检查 %s" % paths["dir"])
        return 1
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            if b"muse_bridge" not in f.read():
                print("pid %d 不是 bridge 进程，未处理。" % pid)
                return 1
    except OSError:
        pass
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        time.sleep(0.2)
        if not running_pid(paths):
            print("bridge 已停止。")
            return 0
    os.kill(pid, signal.SIGKILL)
    print("bridge 未在 20 秒内退出，已强制结束（pid %d）。" % pid)
    return 0


def cmd_status(args, paths):
    ensure_state_dir(paths)
    pid = running_pid(paths)
    print("状态：%s" % ("运行中 pid %s" % pid if pid else "未运行"))
    print("server：%s" % server_host(read_server(paths)))
    print("token：%s" % ("已配置" if os.path.exists(paths["token"]) else "缺失"))
    try:
        with open(paths["log"]) as f:
            lines = f.readlines()[-8:]
        print("最近日志：")
        sys.stdout.writelines("  " + l for l in lines)
    except OSError:
        pass
    return 0 if pid else 1


def cmd_try(args, paths):
    """Run one job against the local CLI only, keep the output, no server."""
    job = {"id": "local-%d" % int(time.time()), "kind": args.kind, "prompt": args.prompt}
    for key in ("orientation", "aspect_ratio", "image_format"):
        if getattr(args, key):
            job[key] = getattr(args, key)
    if args.timeout:
        job["timeout_secs"] = args.timeout
    limits = effective_limits()
    if args.image:
        job["source_images"] = []
        for path in args.image:
            with open(path, "rb") as f:
                job["source_images"].append({"base64": base64.b64encode(f.read()).decode()})
    if args.resume:
        job["resume_snapshot_id"] = args.resume
    out_dir = tempfile.mkdtemp(prefix="muse-try-")
    try:
        job = validate_job(job, limits)
        contract = CliRunner(args.cli).run(job, out_dir, threading.Event())
        files = collect_outputs(contract, os.path.join(out_dir, "media"), job["kind"], limits)
    except JobError as e:
        print(json.dumps(e.result(), ensure_ascii=False))
        shutil.rmtree(out_dir, ignore_errors=True)
        return 1
    for f in files:
        print(f["path"])
    print(json.dumps({"ok": True, "snapshot_id": contract.get("snapshot_id"),
                      "files": [{"mime": f["mime"], "bytes": f["bytes"]} for f in files]}), file=sys.stderr)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="muse_bridge.py", description="Muse 媒体生成中转（外连个人版）")
    p.add_argument("--state-dir", default=os.environ.get("MUSE_BRIDGE_HOME", DEFAULT_STATE_DIR))
    p.add_argument("--cli", default=DEFAULT_CLI, help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="cmd")
    for name in ("start", "run"):
        sp = sub.add_parser(name)
        sp.add_argument("--server")
        sp.add_argument("--force", action="store_true")
        sp.add_argument("--max-concurrency", dest="max_concurrency", type=int, default=1,
                        help="最多同时跑几个任务（1-%d）；实际还受服务端下发的上限约束" % MAX_CONCURRENCY_HARD)
    sub.add_parser("stop")
    sub.add_parser("status")
    sp = sub.add_parser("check")
    sp.add_argument("--server")
    sub.add_parser("set-token")
    sp = sub.add_parser("try")
    sp.add_argument("kind", choices=("image", "video"))
    sp.add_argument("prompt")
    sp.add_argument("--orientation", choices=ORIENTATIONS)
    sp.add_argument("--aspect-ratio", dest="aspect_ratio", choices=ASPECT_RATIOS)
    sp.add_argument("--format", dest="image_format", choices=IMAGE_FORMATS)
    sp.add_argument("--image", action="append", help="源图路径，可重复；图片编辑或图生视频")
    sp.add_argument("--resume", help="上一次结果的 snapshot_id，续接生成")
    sp.add_argument("--timeout", type=int)
    args = p.parse_args(argv)
    paths = state_paths(os.path.abspath(args.state_dir))
    if args.cmd in ("start", "run"):
        return cmd_start(args, paths, foreground=(args.cmd == "run"))
    if args.cmd == "stop":
        return cmd_stop(args, paths)
    if args.cmd == "status":
        return cmd_status(args, paths)
    if args.cmd == "check":
        ensure_state_dir(paths)
        if args.server:
            write_private(paths["server"], normalize_server(args.server) + "\n")
        return 0 if self_check(paths, args.cli) else 1
    if args.cmd == "set-token":
        ensure_state_dir(paths)
        prompt_token(paths)
        return 0
    if args.cmd == "try":
        return cmd_try(args, paths)
    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
