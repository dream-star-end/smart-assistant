"""Submit one canonical H3 prompt to both sequence-parallel ranks."""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import os
import signal
import time
import urllib.error
import urllib.request
from pathlib import Path


def request_json(url: str, payload=None, timeout=10):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def canonical_prompt(path: Path, job_id="local", attempt_id="local", input_manifest=None):
    document = json.loads(path.read_text())
    prompt = copy.deepcopy(document.get("prompt", document))
    t2va_nodes = [node for node in prompt.values() if node.get("class_type") == "MiniMaxH3ImageToVideo"]
    reference_nodes = [node for node in prompt.values() if node.get("class_type") == "MiniMaxH3ReferenceToVideo"]
    conditioning_nodes = t2va_nodes + reference_nodes
    if len(conditioning_nodes) != 1:
        raise ValueError("sequence-parallel worker requires exactly one MiniMax H3 conditioning node")
    if reference_nodes:
        ref_inputs = reference_nodes[0].get("inputs", {})
        if ref_inputs.get("ref_videos") or ref_inputs.get("ref_video_audios") or ref_inputs.get("ref_audios"):
            raise ValueError("sequence-parallel worker supports reference images, not reference video/audio")
        ref_images = ref_inputs.get("ref_images") or {}
        if not isinstance(ref_images, dict):
            raise ValueError("MiniMax H3 reference images must use the autogrow object form")
        if len(ref_images) > 9:
            raise ValueError("MiniMax H3 accepts at most 9 reference images")

    noise_nodes = [(node_id, node) for node_id, node in prompt.items() if node.get("class_type") == "RandomNoise"]
    if len(noise_nodes) != 1:
        raise ValueError(f"expected one RandomNoise node, got {len(noise_nodes)}")
    seed = noise_nodes[0][1]["inputs"]["noise_seed"]

    model_consumers = [
        (node_id, node) for node_id, node in prompt.items()
        if node.get("class_type") in {"BasicScheduler", "BasicGuider"}
    ]
    if len(model_consumers) != 2:
        raise ValueError("expected one BasicScheduler and one BasicGuider")
    model_refs = [node["inputs"]["model"] for _, node in model_consumers]
    if model_refs[0] != model_refs[1]:
        raise ValueError("BasicScheduler and BasicGuider must consume the same model")
    scheduler = next(node for _, node in model_consumers if node.get("class_type") == "BasicScheduler")
    total_steps = int(scheduler.get("inputs", {}).get("steps", 0))
    if total_steps <= 0:
        raise ValueError("BasicScheduler steps must be positive")

    canonical = json.dumps(prompt, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    manifest_bytes = b""
    if input_manifest is not None:
        manifest = json.loads(input_manifest.read_text())
        manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(
        canonical + b"\0" + manifest_bytes + b"\0" + job_id.encode() + b"\0" + attempt_id.encode()
    ).hexdigest()
    numeric_ids = [int(node_id) for node_id in prompt if str(node_id).isdigit()]
    sp_id = str(max(numeric_ids, default=0) + 1)
    prompt[sp_id] = {
        "class_type": "MiniMaxH3SequenceParallel",
        "inputs": {
            "model": model_refs[0],
            "job_digest": digest,
            "job_id": job_id,
            "attempt_id": attempt_id,
            "seed": seed,
            "total_steps": total_steps,
        },
    }
    for _, node in model_consumers:
        node["inputs"]["model"] = [sp_id, 0]
    rank1_prompt = copy.deepcopy(prompt)
    for node in rank1_prompt.values():
        if node.get("class_type") not in {"MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo"}:
            continue
        inputs = node.get("inputs", {})
        for name in list(inputs):
            if name in (
                "first_frame", "last_frame", "ref_images", "ref_videos",
                "ref_video_audios", "ref_audios",
            ):
                inputs.pop(name, None)
    return [prompt, rank1_prompt], digest, seed


def interrupt(ports):
    for port in ports:
        try:
            request_json(f"http://127.0.0.1:{port}/interrupt", {}, timeout=2)
        except Exception:
            pass


def terminate_group(pid_file: Path):
    try:
        pid = int(pid_file.read_text().strip())
        os.killpg(pid, signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, ValueError):
        pass


def history_status(history, prompt_id):
    entry = history.get(prompt_id)
    if entry is None:
        return None, None
    status = entry.get("status", {})
    return status.get("status_str"), entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", type=Path)
    parser.add_argument("--base-port", type=int, default=8290)
    parser.add_argument("--pid-file", type=Path, default=Path("/root/minimax-h3-sp-runtime/torchrun.pid"))
    parser.add_argument("--lock-file", type=Path, default=Path("/root/minimax-h3-sp-runtime/coordinator.lock"))
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--job-id", default="local")
    parser.add_argument("--attempt-id", default="local")
    parser.add_argument("--input-manifest", type=Path)
    args = parser.parse_args()

    args.lock_file.parent.mkdir(parents=True, exist_ok=True)
    lock_handle = args.lock_file.open("w")
    fcntl.flock(lock_handle, fcntl.LOCK_EX)

    def terminate_on_signal(_signum, _frame):
        raise SystemExit("sequence-parallel coordinator terminated")

    signal.signal(signal.SIGTERM, terminate_on_signal)

    ports = [args.base_port, args.base_port + 1]
    prompts, digest, seed = canonical_prompt(
        args.prompt,
        job_id=args.job_id,
        attempt_id=args.attempt_id,
        input_manifest=args.input_manifest,
    )
    submissions = []
    try:
        for port, prompt in zip(ports, prompts):
            submissions.append(request_json(f"http://127.0.0.1:{port}/prompt", {"prompt": prompt}, timeout=30))
        if any(item.get("node_errors") for item in submissions):
            raise RuntimeError(f"prompt validation failed: {submissions}")
        prompt_ids = [item["prompt_id"] for item in submissions]

        deadline = time.monotonic() + args.timeout
        entries = [None, None]
        while time.monotonic() < deadline:
            for rank, (port, prompt_id) in enumerate(zip(ports, prompt_ids)):
                if entries[rank] is not None:
                    continue
                history = request_json(f"http://127.0.0.1:{port}/history/{prompt_id}", timeout=10)
                status, entry = history_status(history, prompt_id)
                if status == "error":
                    raise RuntimeError(f"rank {rank} failed: {entry}")
                if status == "success":
                    entries[rank] = entry
            if all(entry is not None for entry in entries):
                result = {
                    "job_digest": digest,
                    "job_id": args.job_id,
                    "attempt_id": args.attempt_id,
                    "seed": seed,
                    "prompt_ids": prompt_ids,
                    "rank0": entries[0],
                    "rank1": entries[1],
                }
                args.result.parent.mkdir(parents=True, exist_ok=True)
                args.result.write_text(json.dumps(result, ensure_ascii=False, indent=2))
                print(json.dumps({"job_digest": digest, "seed": seed, "prompt_ids": prompt_ids}))
                return
            time.sleep(2)
        raise TimeoutError(f"sequence-parallel job timed out after {args.timeout}s")
    except BaseException:
        interrupt(ports)
        terminate_group(args.pid_file)
        raise


if __name__ == "__main__":
    main()
