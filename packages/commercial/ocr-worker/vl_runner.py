#!/usr/bin/env python3
"""One persistent PaddleOCR-VL process per configured accelerator card."""
from __future__ import annotations

import argparse
import json
import os
import socket
import traceback
from pathlib import Path

import torch

try:
    torch.ops.torchvision.nms
    _TV_LIB = None
except AttributeError:
    _TV_LIB = torch.library.Library("torchvision", "DEF")
    _TV_LIB.define("nms(Tensor dets, Tensor scores, float iou_threshold) -> Tensor")

from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor


def first_eos(tokens: torch.Tensor, eos_ids: set[int]) -> int | None:
    for index, token in enumerate(tokens.tolist()):
        if int(token) in eos_ids:
            return index
    return None


def generate(model, processor, paths: list[str], prompt: str, max_new_tokens: int) -> list[dict]:
    images = []
    for path in paths:
        with Image.open(path) as source:
            images.append(source.convert("RGB"))
    conversations = [
        [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": prompt}]}]
        for image in images
    ]
    inputs = processor.apply_chat_template(
        conversations,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
        padding=True,
        images_kwargs={"size": {"shortest_edge": processor.image_processor.min_pixels, "longest_edge": 1280 * 28 * 28}},
    ).to(model.device)
    prompt_width = int(inputs["input_ids"].shape[1])
    with torch.inference_mode():
        outputs = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False, use_cache=True)
    eos = model.generation_config.eos_token_id or model.config.eos_token_id or processor.tokenizer.eos_token_id
    eos_ids = {int(value) for value in eos} if isinstance(eos, (list, tuple)) else {int(eos)}
    results = []
    for row in outputs:
        generated = row[prompt_width:]
        eos_index = first_eos(generated, eos_ids)
        finished = eos_index is not None
        content = generated[:eos_index] if finished else generated
        text = processor.decode(content, skip_special_tokens=True).replace("<nl>", "\n")
        results.append({
            "text": "\n".join(line.strip() for line in text.replace("</s>", "").splitlines() if line.strip()),
            "finished_eos": finished,
            "hit_cap": not finished and len(generated) >= max_new_tokens,
            "output_tokens": int((eos_index + 1) if finished else len(generated)),
        })
    return results


def serve(socket_path: Path, ready_path: Path, model_path: Path) -> None:
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=torch.bfloat16,
        local_files_only=True,
        trust_remote_code=True,
        attn_implementation="eager",
    ).to("cuda").eval()
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=True)
    # Prove the actual KV-cache path before advertising the card as ready.
    probe = os.environ.get("OC_OCR_VL_PROBE_IMAGE", "")
    if not probe:
        raise RuntimeError("OC_OCR_VL_PROBE_IMAGE is required for readiness self-test")
    whole = generate(model, processor, [probe], "OCR:", 8)
    if len(whole) != 1:
        raise RuntimeError("VL whole-page batch-1 warmup returned an incomplete batch")
    # Hybrid batch=4 receives narrow detected text regions, not four full pages.
    # Warm that exact memory shape as a second readiness gate.
    crop_probe = socket_path.parent / f"vl-probe-{os.getpid()}.jpg"
    with Image.open(probe) as source:
        image = source.convert("RGB")
    image.crop((0, 0, image.width, max(32, image.height // 8))).save(crop_probe, "JPEG", quality=95)
    result = generate(model, processor, [str(crop_probe)] * 4, "OCR:", 8)
    crop_probe.unlink(missing_ok=True)
    if len(result) != 4:
        raise RuntimeError("VL batch-4 warmup returned an incomplete batch")
    socket_path.unlink(missing_ok=True)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(socket_path))
    os.chmod(socket_path, 0o600)
    server.listen(8)
    ready_path.write_text(json.dumps({"pid": os.getpid(), "model": str(model_path)}) + "\n")
    while True:
        connection, _ = server.accept()
        with connection:
            stream = connection.makefile("rwb")
            try:
                request = json.loads(stream.readline())
                paths = [str(value) for value in request["paths"]]
                batch = int(request.get("batch", 1))
                values = []
                for offset in range(0, len(paths), batch):
                    values.extend(generate(model, processor, paths[offset:offset + batch], str(request.get("prompt", "OCR:")), int(request.get("max_new_tokens", 4096))))
                response = {"ok": True, "results": values}
            except Exception as exc:
                response = {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=3)}
            stream.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
            stream.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--ready", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    args = parser.parse_args()
    serve(args.socket, args.ready, args.model)


if __name__ == "__main__":
    main()
