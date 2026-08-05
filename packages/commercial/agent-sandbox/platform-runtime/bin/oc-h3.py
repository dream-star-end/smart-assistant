#!/usr/bin/env python3
"""Durable OpenClaude H3 video jobs and minute-scale video projects."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import mimetypes
import os
import sys
import time
import uuid
from pathlib import Path
from urllib import error, parse, request

# Resolve through the current-bundle symlink once so the running CLI remains
# pinned to one finalized platform revision for its whole invocation.
SELF_ROOT = Path(__file__).resolve().parent.parent

MASTER_ENV = "OPENCLAUDE_V3_MASTER_BASE_URL"
TOKEN_ENV = "OPENCLAUDE_V3_CONTAINER_TOKEN"
AUTH_FILES = (
    Path("/home/agent/.openclaude/container-auth.json"),
    Path.home() / ".openclaude" / "container-auth.json",
)
TERMINAL = {"completed", "failed", "canceled"}


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
    raise SystemExit("oc-h3 only works inside an OpenClaude commercial Agent container")


def endpoint(path: str) -> str:
    base, _ = auth()
    return f"{base}/internal/v3/media-generation{path}"


def fail_http(exc: error.HTTPError) -> None:
    body = exc.read().decode("utf-8", "replace")[:4000]
    try:
        value = json.loads(body)
        detail = value.get("error", value)
        if isinstance(detail, dict):
            body = str(detail.get("message") or detail.get("code") or body)
    except ValueError:
        pass
    raise SystemExit(f"media generation request failed: HTTP {exc.code}: {body}") from None


def json_call(method: str, path: str, payload: dict | None = None) -> dict:
    _, token = auth()
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        endpoint(path),
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "X-Request-Id": uuid.uuid4().hex,
            **({"Content-Type": "application/json; charset=utf-8"} if data is not None else {}),
        },
    )
    try:
        with request.urlopen(req, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        fail_http(exc)
    except error.URLError as exc:
        raise SystemExit(f"media generation request failed: {exc.reason}") from None


def upload(path_value: str, kind: str) -> str:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"input file not found: {path}")
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
    size = path.stat().st_size
    url = parse.urlsplit(endpoint("/inputs"))
    _, token = auth()
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=1800)
    connection.putrequest("PUT", url.path)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "Content-Length": str(size),
        "X-Content-Size": str(size),
        "X-Content-SHA256": sha.hexdigest(),
        "X-Input-Kind": kind,
        "X-Input-Filename": path.name,
        "X-Request-Id": uuid.uuid4().hex,
    }
    for name, value in headers.items():
        connection.putheader(name, value)
    connection.endheaders()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            connection.send(chunk)
    response = connection.getresponse()
    body = response.read()
    connection.close()
    if response.status >= 400:
        raise SystemExit(f"input upload failed: HTTP {response.status}: {body.decode('utf-8', 'replace')[:2000]}")
    return str(json.loads(body).get("inputId"))


def download(job_id: str, out: str) -> Path:
    _, token = auth()
    req = request.Request(endpoint(f"/jobs/{job_id}/result"), headers={"Authorization": f"Bearer {token}"})
    target = Path(out).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    digest = hashlib.sha256()
    try:
        with request.urlopen(req, timeout=1800) as response, temporary.open("wb") as handle:
            expected = response.headers.get("X-Content-SHA256")
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(chunk)
                handle.write(chunk)
    except error.HTTPError as exc:
        fail_http(exc)
    if expected and digest.hexdigest() != expected:
        temporary.unlink(missing_ok=True)
        raise SystemExit("downloaded result failed SHA-256 verification")
    temporary.replace(target)
    return target


def print_job(job: dict) -> None:
    progress = ""
    if job.get("totalSteps"):
        progress = f" {job.get('currentStep') or 0}/{job['totalSteps']}"
    queue = f" queue={job['queuePosition']}" if job.get("queuePosition") else ""
    print(f"{job['id']} {job['status']} phase={job['phase']}{progress}{queue}")


def wait_job(job_id: str, out: str | None = None) -> dict:
    previous = None
    while True:
        job = json_call("GET", f"/jobs/{job_id}")["job"]
        marker = (job.get("status"), job.get("phase"), job.get("currentStep"), job.get("queuePosition"))
        if marker != previous:
            print_job(job)
            previous = marker
        if job["status"] in TERMINAL:
            if job["status"] != "completed":
                raise SystemExit(f"job {job_id} {job['status']}: {job.get('errorMessage') or job.get('errorCode') or ''}")
            if out:
                print(download(job_id, out))
            return job
        time.sleep(3)


def common_generation(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--prompt", "-p", required=True)
    parser.add_argument("--duration", type=int, choices=(5, 10, 15), default=5)
    parser.add_argument("--aspect", choices=("16:9", "9:16", "1:1"), default="16:9")
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--seed", type=int)
    parser.add_argument("--first-frame")
    parser.add_argument("--last-frame")
    parser.add_argument("--reference", action="append", default=[])
    parser.add_argument("--session-id")


def cmd_generate(args: argparse.Namespace) -> None:
    input_ids = []
    if args.first_frame:
        input_ids.append(upload(args.first_frame, "first_frame"))
    if args.last_frame:
        input_ids.append(upload(args.last_frame, "last_frame"))
    input_ids.extend(upload(value, "reference_image") for value in args.reference)
    options = {"durationSeconds": args.duration, "aspect": args.aspect, "steps": args.steps}
    if args.seed is not None:
        options["seed"] = args.seed
    job = json_call("POST", "/jobs", {
        "requestId": args.request_id or uuid.uuid4().hex,
        "prompt": args.prompt,
        "sessionId": args.session_id,
        "inputIds": input_ids,
        "options": options,
    })["job"]
    print_job(job)
    if args.wait or args.out:
        wait_job(job["id"], args.out)


def load_storyboard(value: str) -> list[dict]:
    path = Path(value)
    text = path.read_text() if path.is_file() else value
    parsed = json.loads(text)
    shots = parsed.get("shots") if isinstance(parsed, dict) else parsed
    if not isinstance(shots, list) or not shots:
        raise SystemExit("storyboard must be a non-empty JSON array or an object with shots")
    return shots


def cmd_project_create(args: argparse.Namespace) -> None:
    input_ids = []
    if args.first_frame:
        input_ids.append(upload(args.first_frame, "first_frame"))
    input_ids.extend(upload(value, "reference_image") for value in args.reference)
    if args.last_frame:
        input_ids.append(upload(args.last_frame, "last_frame"))
    project = json_call("POST", "/projects", {
        "requestId": args.request_id or uuid.uuid4().hex,
        "title": args.title,
        "sessionId": args.session_id,
        "inputIds": input_ids,
        "options": {"aspect": args.aspect, "steps": args.steps},
        "shots": load_storyboard(args.storyboard),
    })["project"]
    print(json.dumps(project, ensure_ascii=False, indent=2))


def cmd_project_edit(args: argparse.Namespace) -> None:
    if args.clear_inputs and (args.first_frame or args.last_frame or args.reference):
        raise SystemExit("--clear-inputs cannot be combined with frame/reference inputs")
    input_ids = []
    if args.first_frame:
        input_ids.append(upload(args.first_frame, "first_frame"))
    input_ids.extend(upload(value, "reference_image") for value in args.reference)
    if args.last_frame:
        input_ids.append(upload(args.last_frame, "last_frame"))
    payload = {
        "expectedRev": args.expected_rev,
        "title": args.title,
        "options": {"aspect": args.aspect, "steps": args.steps},
        "shots": load_storyboard(args.storyboard),
    }
    if input_ids or args.clear_inputs:
        payload["inputIds"] = input_ids
    project = json_call("POST", f"/projects/{args.project_id}/edit", payload)["project"]
    print(json.dumps(project, ensure_ascii=False, indent=2))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="oc-h3", description="durable local MiniMax H3 video generation")
    sub = root.add_subparsers(dest="command", required=True)
    generate = sub.add_parser("generate", help="queue one 5/10/15-second shot")
    common_generation(generate)
    generate.add_argument("--request-id")
    generate.add_argument("--wait", action="store_true")
    generate.add_argument("--out", "-o")
    generate.set_defaults(func=cmd_generate)
    status = sub.add_parser("status")
    status.add_argument("job_id")
    status.set_defaults(func=lambda ns: print(json.dumps(json_call("GET", f"/jobs/{ns.job_id}")["job"], ensure_ascii=False, indent=2)))
    cancel = sub.add_parser("cancel")
    cancel.add_argument("job_id")
    cancel.set_defaults(func=lambda ns: print_job(json_call("POST", f"/jobs/{ns.job_id}/cancel", {})["job"]))
    get = sub.add_parser("download")
    get.add_argument("job_id")
    get.add_argument("--out", "-o", required=True)
    get.set_defaults(func=lambda ns: print(download(ns.job_id, ns.out)))

    project = sub.add_parser("project", help="create and manage minute-scale storyboard projects")
    project_sub = project.add_subparsers(dest="project_command", required=True)
    create = project_sub.add_parser("create")
    create.add_argument("--storyboard", required=True, help="JSON file or inline JSON")
    create.add_argument("--title", default="未命名视频项目")
    create.add_argument("--aspect", choices=("16:9", "9:16", "1:1"), default="16:9")
    create.add_argument("--steps", type=int, default=20)
    create.add_argument("--first-frame")
    create.add_argument("--last-frame")
    create.add_argument("--reference", action="append", default=[])
    create.add_argument("--session-id")
    create.add_argument("--request-id")
    create.set_defaults(func=cmd_project_create)
    edit = project_sub.add_parser("edit")
    edit.add_argument("project_id")
    edit.add_argument("--expected-rev", type=int, required=True)
    edit.add_argument("--storyboard", required=True, help="replacement JSON storyboard")
    edit.add_argument("--title")
    edit.add_argument("--aspect", choices=("16:9", "9:16", "1:1"), default="16:9")
    edit.add_argument("--steps", type=int, default=20)
    edit.add_argument("--first-frame")
    edit.add_argument("--last-frame")
    edit.add_argument("--reference", action="append", default=[])
    edit.add_argument("--clear-inputs", action="store_true")
    edit.set_defaults(func=cmd_project_edit)
    project_status = project_sub.add_parser("status")
    project_status.add_argument("project_id")
    project_status.set_defaults(func=lambda ns: print(json.dumps(json_call("GET", f"/projects/{ns.project_id}")["project"], ensure_ascii=False, indent=2)))
    start = project_sub.add_parser("start")
    start.add_argument("project_id")
    start.add_argument("--expected-rev", type=int, required=True)
    start.set_defaults(func=lambda ns: print(json.dumps(json_call("POST", f"/projects/{ns.project_id}/start", {"expectedRev": ns.expected_rev})["project"], ensure_ascii=False, indent=2)))
    render = project_sub.add_parser("render")
    render.add_argument("project_id")
    render.add_argument("--expected-rev", type=int, required=True)
    render.add_argument("--request-id")
    render.add_argument("--wait", action="store_true")
    render.add_argument("--out", "-o")
    def render_project(ns):
        job = json_call("POST", f"/projects/{ns.project_id}/render", {
            "expectedRev": ns.expected_rev, "requestId": ns.request_id or uuid.uuid4().hex,
        })["job"]
        print_job(job)
        if ns.wait or ns.out:
            wait_job(job["id"], ns.out)
    render.set_defaults(func=render_project)
    regenerate = project_sub.add_parser("regenerate-shot")
    regenerate.add_argument("project_id")
    regenerate.add_argument("shot_id")
    regenerate.add_argument("--expected-rev", type=int, required=True)
    regenerate.set_defaults(func=lambda ns: print_job(json_call("POST", f"/projects/{ns.project_id}/shots/{ns.shot_id}/regenerate", {"expectedRev": ns.expected_rev, "requestId": uuid.uuid4().hex})["job"]))
    accept = project_sub.add_parser("accept-shot")
    accept.add_argument("project_id")
    accept.add_argument("shot_id")
    accept.add_argument("--expected-rev", type=int, required=True)
    accept.set_defaults(func=lambda ns: print(json.dumps(json_call("POST", f"/projects/{ns.project_id}/shots/{ns.shot_id}/accept", {"expectedRev": ns.expected_rev}))))
    return root


def main() -> None:
    args = sys.argv[1:]
    if Path(sys.argv[0]).name.startswith("oc-video"):
        args = ["project", *args]
    ns = parser().parse_args(args)
    ns.func(ns)


if __name__ == "__main__":
    main()
