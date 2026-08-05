#!/usr/bin/env python3
"""Persistent PP-OCRv6 worker and per-card durable FIFO claimant."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import torch

try:
    torch.ops.torchvision.nms
    _TV_LIB = None
except AttributeError:
    _TV_LIB = torch.library.Library("torchvision", "DEF")
    _TV_LIB.define("nms(Tensor dets, Tensor scores, float iou_threshold) -> Tensor")

from PIL import Image
from transformers import AutoImageProcessor, AutoModelForObjectDetection, AutoModelForTextRecognition

from worker_common import claim_job, connect, ensure_count, mark_terminal, owner_usage


class Cancelled(Exception):
    pass


def cancelled(db_path: Path, job_id: str) -> bool:
    db = connect(db_path)
    row = db.execute("SELECT cancel_requested,status FROM jobs WHERE id=?", (job_id,)).fetchone()
    db.close()
    return row is None or bool(row["cancel_requested"]) or row["status"] != "running"


def run_limited(command: list[str], db_path: Path, job_id: str, timeout: int) -> dict:
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    deadline = time.monotonic() + timeout
    while proc.poll() is None:
        if cancelled(db_path, job_id):
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            raise Cancelled()
        if time.monotonic() >= deadline:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            raise RuntimeError("document rasterizer wall-time limit exceeded")
        time.sleep(0.1)
    stdout, stderr = proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"document rasterizer failed: {stderr[-500:]}")
    return json.loads(stdout)


def call_vl(socket_path: Path, paths: list[str], batch: int, prompt: str, max_new_tokens: int) -> list[dict]:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(3600)
    client.connect(str(socket_path))
    with client:
        stream = client.makefile("rwb")
        stream.write((json.dumps({"paths": paths, "batch": batch, "prompt": prompt, "max_new_tokens": max_new_tokens}) + "\n").encode())
        stream.flush()
        response = json.loads(stream.readline())
    if not response.get("ok"):
        raise RuntimeError(f"VL runner failed: {response.get('error')}")
    values = response["results"]
    ensure_count("VL", len(paths), len(values))
    if any(not value.get("finished_eos") or value.get("hit_cap") for value in values):
        raise RuntimeError("VL output reached its model token boundary; refusing incomplete result")
    return values


def sort_indexes(crops: list[Image.Image]) -> list[int]:
    return sorted(range(len(crops)), key=lambda index: crops[index].width / max(1, crops[index].height))


def pp_chunk(det_p, det, rec_p, rec, page_paths: list[Path]) -> list[dict]:
    pages = []
    for path in page_paths:
        with Image.open(path) as source:
            pages.append(source.convert("RGB"))
    inputs = det_p(images=pages, return_tensors="pt").to("cuda")
    with torch.inference_mode():
        outputs = det(**inputs)
    detections = det_p.post_process_object_detection(
        outputs,
        target_sizes=inputs["target_sizes"],
        threshold=0.2,
        box_threshold=0.45,
        max_candidates=3000,
        unclip_ratio=1.4,
    )
    ensure_count("PP detector", len(pages), len(detections))
    records = []
    for image, detected in zip(pages, detections):
        boxes = detected["boxes"].detach().cpu().numpy()
        scores = detected["scores"].detach().cpu().numpy()
        crops: list[Image.Image] = []
        meta = []
        for box, score in zip(boxes, scores):
            pts = np.asarray(box, dtype=float).reshape(-1, 2)
            x0, y0 = max(0, int(np.floor(pts[:, 0].min())) - 2), max(0, int(np.floor(pts[:, 1].min())) - 2)
            x1, y1 = min(image.width, int(np.ceil(pts[:, 0].max())) + 3), min(image.height, int(np.ceil(pts[:, 1].max())) + 3)
            if x1 - x0 >= 8 and y1 - y0 >= 8:
                crops.append(image.crop((x0, y0, x1, y1)))
                meta.append({"order": [y0, x0], "box": [x0, y0, x1, y1], "det_score": float(score)})
        recognized: list[dict | None] = [None] * len(crops)
        indexes = sort_indexes(crops)
        for offset in range(0, len(indexes), 64):
            batch_indexes = indexes[offset:offset + 64]
            rec_inputs = rec_p(images=[crops[index] for index in batch_indexes], return_tensors="pt").to("cuda")
            with torch.inference_mode():
                rec_outputs = rec(**rec_inputs)
            values = list(rec_p.post_process_text_recognition(rec_outputs))
            ensure_count("PP recognizer", len(batch_indexes), len(values))
            for index, value in zip(batch_indexes, values):
                text = value.get("text", value.get("rec_text", "")) if isinstance(value, dict) else getattr(value, "text", str(value))
                score = value.get("score", value.get("rec_score")) if isinstance(value, dict) else getattr(value, "score", None)
                if isinstance(score, torch.Tensor):
                    score = float(score.detach().cpu())
                recognized[index] = {**meta[index], "text": text, "rec_score": score if isinstance(score, (int, float)) and math.isfinite(score) else None, "crop": crops[index]}
        values = [value for value in recognized if value is not None]
        values.sort(key=lambda value: value["order"])
        records.append({"image": image, "recognized": values})
    return records


def raster_pages(rasterizer: Path, source: Path, job_dir: Path, numbers: list[int], db_path: Path, job_id: str, workers: int) -> list[Path]:
    def one(page: int) -> Path:
        output = job_dir / f"page-{page:08d}.jpg"
        run_limited([sys.executable, str(rasterizer), "raster", str(source), "--page", str(page), "--out", str(output)], db_path, job_id, int(os.environ.get("OC_OCR_RASTER_WALL_SECONDS", "180")))
        return output
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, page) for page in numbers]
        return [future.result() for future in futures]


def write_page(jsonl, markdown, page: int, mode: str, text: str, blocks: list[dict], replacements: int) -> None:
    payload = {"page": page, "engine": mode, "text": text, "blocks": blocks, "vl_replacements": replacements}
    jsonl.write(json.dumps(payload, ensure_ascii=False) + "\n")
    markdown.write(f"\n\n## Page {page}\n\n{text.rstrip()}\n")
    jsonl.flush(); markdown.flush()


def assert_storage_budget(db_path: Path, jobs_dir: Path, row, json_tmp: Path, md_tmp: Path) -> None:
    usage = shutil.disk_usage(jobs_dir)
    reserve = int(os.environ.get("OC_OCR_DISK_RESERVE_BYTES", str(20 * 1024**3)))
    divisor = max(1, int(os.environ.get("OC_OCR_OWNER_DISK_SHARE_DIVISOR", "8")))
    owner_budget = max(0, usage.total - reserve) // divisor
    result_bytes = (json_tmp.stat().st_size if json_tmp.exists() else 0) + (md_tmp.stat().st_size if md_tmp.exists() else 0)
    db = connect(db_path)
    _, stored = owner_usage(db, row["owner"])
    db.close()
    if usage.free < reserve or stored + result_bytes > owner_budget:
        raise RuntimeError("OCR result exceeded the transparent storage capacity boundary")


def process_job(args, row, det_p, det, rec_p, rec) -> None:
    job_id = row["id"]
    job_dir = args.jobs_dir / job_id
    source = Path(row["source_path"])
    for path in [job_dir / "result.jsonl.tmp", job_dir / "result.md.tmp"]:
        path.unlink(missing_ok=True)
    manifest = run_limited([sys.executable, str(args.rasterizer), "manifest", str(source)], args.db, job_id, int(os.environ.get("OC_OCR_RASTER_WALL_SECONDS", "180")))
    total = int(manifest["pages"])
    if total < 1:
        raise RuntimeError("document has no pages")
    db = connect(args.db)
    db.execute("UPDATE jobs SET pages_total=?,phase='rasterizing',updated_at=? WHERE id=?", (total, time.time(), job_id))
    db.close()
    json_tmp, md_tmp = job_dir / "result.jsonl.tmp", job_dir / "result.md.tmp"
    with json_tmp.open("w", encoding="utf-8") as jsonl, md_tmp.open("w", encoding="utf-8") as markdown:
        markdown.write(f"# OCR: {row['filename']}\n")
        for start in range(1, total + 1, 24):
            if cancelled(args.db, job_id):
                raise Cancelled()
            numbers = list(range(start, min(total + 1, start + 24)))
            paths = raster_pages(args.rasterizer, source, job_dir, numbers, args.db, job_id, args.raster_workers)
            if row["mode"] == "vl":
                for page, path in zip(numbers, paths):
                    if cancelled(args.db, job_id):
                        raise Cancelled()
                    values = call_vl(args.vl_socket, [str(path)], 1, "OCR:", int(os.environ.get("OC_OCR_VL_PAGE_MAX_TOKENS", "8192")))
                    write_page(jsonl, markdown, page, "vl", values[0]["text"], [], 0)
                    assert_storage_budget(args.db, args.jobs_dir, row, json_tmp, md_tmp)
                    path.unlink(missing_ok=True)
                    db = connect(args.db); db.execute("UPDATE jobs SET pages_done=?,phase='vl',updated_at=? WHERE id=?", (page, time.time(), job_id)); db.close()
                continue
            records = pp_chunk(det_p, det, rec_p, rec, paths)
            ensure_count("PP page materializer", len(paths), len(records))
            replacements: dict[tuple[int, int], str] = {}
            whole_pages: dict[int, str] = {}
            fallback_items = []
            if row["mode"] == "hybrid":
                for page_index, (page, path, record) in enumerate(zip(numbers, paths, records)):
                    candidates = list(enumerate(record["recognized"]))
                    if candidates:
                        candidates.sort(key=lambda pair: (pair[1]["rec_score"] is not None, pair[1]["rec_score"] if pair[1]["rec_score"] is not None else -1.0))
                        count = max(1, math.ceil(len(candidates) * float(row["fallback"]))) if float(row["fallback"]) > 0 else 0
                        for index, item in candidates[:count]:
                            crop = job_dir / f"crop-{page:08d}-{index:05d}.jpg"
                            item["crop"].save(crop, "JPEG", quality=95)
                            fallback_items.append({
                                "page_index": page_index,
                                "item_index": index,
                                "path": crop,
                                "aspect": item["crop"].width / max(1, item["crop"].height),
                            })
                    else:
                        if cancelled(args.db, job_id):
                            raise Cancelled()
                        whole_pages[page_index] = call_vl(args.vl_socket, [str(path)], 1, "OCR:", int(os.environ.get("OC_OCR_VL_PAGE_MAX_TOKENS", "8192")))[0]["text"]
                fallback_items.sort(key=lambda item: item["aspect"])
                # Batch across the whole det=24 chunk (rather than one RPC per
                # page), while keeping cancellation boundaries short.
                for offset in range(0, len(fallback_items), 32):
                    if cancelled(args.db, job_id):
                        raise Cancelled()
                    group = fallback_items[offset:offset + 32]
                    values = call_vl(args.vl_socket, [str(item["path"]) for item in group], 4, "OCR:", int(os.environ.get("OC_OCR_VL_CROP_MAX_TOKENS", "1024")))
                    for item, value in zip(group, values):
                        replacements[(item["page_index"], item["item_index"])] = value["text"]
                        item["path"].unlink(missing_ok=True)

            for page_index, (page, path, record) in enumerate(zip(numbers, paths, records)):
                if cancelled(args.db, job_id):
                    raise Cancelled()
                if page_index in whole_pages:
                    write_page(jsonl, markdown, page, "hybrid", whole_pages[page_index], [], 1)
                    phase = "hybrid-vl"
                    replacement_count = 1
                else:
                    page_replacements = {
                        item_index: text
                        for (candidate_page, item_index), text in replacements.items()
                        if candidate_page == page_index
                    }
                    blocks = []
                    lines = []
                    for index, item in enumerate(record["recognized"]):
                        text = page_replacements.get(index, str(item.get("text", ""))).strip()
                        if text:
                            lines.append(text)
                        blocks.append({"box": item["box"], "text": text, "pp_score": item["rec_score"], "vl": index in page_replacements})
                    replacement_count = len(page_replacements)
                    phase = "hybrid-vl" if replacement_count else "pp"
                    write_page(jsonl, markdown, page, row["mode"], "\n".join(lines), blocks, replacement_count)
                assert_storage_budget(args.db, args.jobs_dir, row, json_tmp, md_tmp)
                path.unlink(missing_ok=True)
                db = connect(args.db); db.execute("UPDATE jobs SET pages_done=?,phase=?,updated_at=? WHERE id=?", (page, phase, time.time(), job_id)); db.close()
    os.replace(json_tmp, job_dir / "result.jsonl")
    os.replace(md_tmp, job_dir / "result.md")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--jobs-dir", type=Path, required=True)
    parser.add_argument("--card", type=int, required=True)
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--vl-socket", type=Path, required=True)
    parser.add_argument("--det-model", type=Path, required=True)
    parser.add_argument("--rec-model", type=Path, required=True)
    parser.add_argument("--rasterizer", type=Path, required=True)
    parser.add_argument("--probe-image", type=Path, required=True)
    parser.add_argument("--raster-workers", type=int, default=6)
    args = parser.parse_args()
    det_p = AutoImageProcessor.from_pretrained(args.det_model, local_files_only=True)
    det = AutoModelForObjectDetection.from_pretrained(args.det_model, local_files_only=True).to("cuda").eval()
    rec_p = AutoImageProcessor.from_pretrained(args.rec_model, local_files_only=True)
    rec = AutoModelForTextRecognition.from_pretrained(args.rec_model, local_files_only=True).to("cuda").eval()
    deadline = time.monotonic() + 300
    while not args.vl_socket.exists():
        if time.monotonic() > deadline: raise RuntimeError("VL runner did not become ready")
        time.sleep(0.5)
    probe_count = int(os.environ.get("OC_OCR_PP_PROBE_BATCH", "24"))
    probe = pp_chunk(det_p, det, rec_p, rec, [args.probe_image] * probe_count)
    if len(probe) != probe_count:
        raise RuntimeError("PP det24/rec64 readiness self-test returned an incomplete batch")
    args.ready.write_text(json.dumps({"pid": os.getpid(), "card": args.card}) + "\n")
    retention = int(os.environ.get("OC_OCR_RESULT_RETENTION_SECONDS", str(7 * 86400)))
    while True:
        row = claim_job(args.db, args.card)
        if row is None:
            time.sleep(0.5)
            continue
        try:
            process_job(args, row, det_p, det, rec_p, rec)
            mark_terminal(args.db, args.jobs_dir, row["id"], "completed", None, retention)
        except Cancelled:
            mark_terminal(args.db, args.jobs_dir, row["id"], "cancelled", None, retention)
        except Exception as exc:
            print(json.dumps({"event": "job_failed", "job": row["id"], "error": str(exc), "trace": traceback.format_exc(limit=5)}), flush=True)
            mark_terminal(args.db, args.jobs_dir, row["id"], "failed", str(exc)[:1000], retention)


if __name__ == "__main__":
    main()
