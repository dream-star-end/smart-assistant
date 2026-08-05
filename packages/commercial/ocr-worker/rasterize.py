#!/usr/bin/env python3
"""Resource-bounded metadata probe and one-page rasterizer."""
from __future__ import annotations

import argparse
import json
import math
import os
import resource
import warnings
from pathlib import Path


def limits() -> None:
    mem = int(os.environ.get("OC_OCR_RASTER_MEMORY_BYTES", str(8 * 1024**3)))
    cpu = int(os.environ.get("OC_OCR_RASTER_CPU_SECONDS", "120"))
    fsize = int(os.environ.get("OC_OCR_RASTER_FILE_BYTES", str(512 * 1024**2)))
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def image_manifest(path: Path) -> dict:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = int(os.environ.get("OC_OCR_MAX_PAGE_PIXELS", "24000000"))
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        return {"kind": "image", "pages": 1, "sizes": [[int(image.width), int(image.height)]]}


def pdf_manifest(path: Path) -> dict:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(str(path))
    sizes = []
    for index in range(len(document)):
        width, height = document[index].get_size()
        sizes.append([float(width), float(height)])
    return {"kind": "pdf", "pages": len(document), "sizes": sizes}


def manifest(path: Path) -> dict:
    with path.open("rb") as source:
        signature = source.read(5)
    if signature == b"%PDF-":
        return pdf_manifest(path)
    return image_manifest(path)


def target_size(width: float, height: float) -> tuple[int, int]:
    max_pixels = int(os.environ.get("OC_OCR_MAX_PAGE_PIXELS", "24000000"))
    max_dimension = int(os.environ.get("OC_OCR_MAX_PAGE_DIMENSION", "10000"))
    dpi = float(os.environ.get("OC_OCR_RENDER_DPI", "180"))
    scale = dpi / 72.0
    out_w, out_h = max(1, int(math.ceil(width * scale))), max(1, int(math.ceil(height * scale)))
    shrink = min(1.0, max_dimension / max(out_w, out_h), math.sqrt(max_pixels / (out_w * out_h)))
    return max(1, int(out_w * shrink)), max(1, int(out_h * shrink))


def raster(path: Path, page_number: int, output: Path) -> dict:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = int(os.environ.get("OC_OCR_MAX_PAGE_PIXELS", "24000000"))
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    with path.open("rb") as source:
        is_pdf = source.read(5) == b"%PDF-"
    if is_pdf:
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(str(path))
        if page_number < 1 or page_number > len(document):
            raise ValueError("page out of range")
        page = document[page_number - 1]
        width, height = page.get_size()
        out_w, out_h = target_size(width, height)
    else:
        if page_number != 1:
            raise ValueError("page out of range")
        with Image.open(path) as source:
            width, height = source.size
        out_w, out_h = int(width), int(height)
    if out_w * out_h > Image.MAX_IMAGE_PIXELS or max(out_w, out_h) > int(os.environ.get("OC_OCR_MAX_PAGE_DIMENSION", "10000")):
        raise ValueError("page exceeds configured physical pixel boundary")
    if is_pdf:
        scale = min(out_w / float(width), out_h / float(height))
        image = page.render(scale=scale).to_pil().convert("RGB")
    else:
        with Image.open(path) as source:
            image = source.convert("RGB")
        if image.size != (out_w, out_h):
            image.thumbnail((out_w, out_h), Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "JPEG", quality=95)
    return {"page": page_number, "width": image.width, "height": image.height, "path": str(output)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["manifest", "raster"])
    parser.add_argument("source", type=Path)
    parser.add_argument("--page", type=int)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    limits()
    if args.operation == "manifest":
        value = manifest(args.source)
    else:
        if args.page is None or args.out is None:
            parser.error("raster needs --page and --out")
        value = raster(args.source, args.page, args.out)
    print(json.dumps(value, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
