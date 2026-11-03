#!/usr/bin/env python3
"""Point SciencePlots styles at the CJK fonts already installed in the image.

science/nature/no-latex replaces font.family after the site matplotlibrc loads.
A generic family name resolves to one face, so the CJK face has to be listed
first on font.family or Chinese labels stay boxes.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import scienceplots

# Desired value must already be the full assignment tail (no key).
TARGETS: dict[str, dict[str, str]] = {
    "misc/no-latex.mplstyle": {
        "font.family": "Noto Serif CJK SC, STIXGeneral",
        "font.serif": "Noto Serif CJK SC, WenQuanYi Zen Hei, STIXGeneral",
    },
    "journals/nature.mplstyle": {
        "font.family": "Noto Sans CJK SC, DejaVu Sans",
        "font.sans-serif": (
            "Noto Sans CJK SC, WenQuanYi Zen Hei, DejaVu Sans, Arial, "
            "Helvetica, Lucida Grande, Verdana, Geneva, Lucid, Avant Garde, "
            "sans-serif"
        ),
    },
    "journals/ieee.mplstyle": {
        "font.family": "Noto Serif CJK SC, DejaVu Serif",
        "font.serif": "Noto Serif CJK SC, WenQuanYi Zen Hei, DejaVu Serif, Times",
    },
}


def set_key(text: str, path: Path, key: str, value: str) -> str:
    pattern = re.compile(rf"^({re.escape(key)}\s*:\s*)(.*)$", re.M)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise SystemExit(f"{path}: expected one {key} line, found {len(matches)}")
    current = matches[0].group(2).strip()
    if current == value:
        return text
    match = matches[0]
    return text[: match.start(2)] + value + text[match.end(2) :]


def patch_seaborn() -> None:
    import seaborn

    path = Path(seaborn.__file__).resolve().parent / "rcmod.py"
    text = path.read_text(encoding="utf-8")
    done = (
        '"font.sans-serif": ["Noto Sans CJK SC", "WenQuanYi Zen Hei", '
        '"DejaVu Sans", "Arial", "Liberation Sans", "Bitstream Vera Sans", '
        '"sans-serif"]'
    )
    if done in text:
        print(f"unchanged {path}")
        return
    pattern = re.compile(
        r'"font\.sans-serif": \["Arial", "DejaVu Sans", "Liberation Sans",\s*'
        r'"Bitstream Vera Sans", "sans-serif"\]'
    )
    updated, count = pattern.subn(done, text, count=1)
    if count != 1:
        raise SystemExit(f"{path}: seaborn font.sans-serif list not found")
    path.write_text(updated, encoding="utf-8")
    print(f"patched {path}")
    if done not in path.read_text(encoding="utf-8"):
        raise SystemExit(f"{path}: seaborn font list did not stick")


def main() -> None:
    root = Path(scienceplots.__file__).resolve().parent / "styles"
    for rel, keys in TARGETS.items():
        path = root / rel
        text = path.read_text(encoding="utf-8")
        updated = text
        for key, value in keys.items():
            updated = set_key(updated, path, key, value)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            print(f"patched {path}")
        else:
            print(f"unchanged {path}")
        # Read back so a partial write cannot pass the image build.
        written = path.read_text(encoding="utf-8")
        for key, value in keys.items():
            pattern = re.compile(rf"^{re.escape(key)}\s*:\s*(.*)$", re.M)
            found = pattern.search(written)
            if found is None or found.group(1).strip() != value:
                raise SystemExit(f"{path}: {key} did not stick")
    patch_seaborn()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"enable-cjk-matplotlib failed: {exc}", file=sys.stderr)
        raise
