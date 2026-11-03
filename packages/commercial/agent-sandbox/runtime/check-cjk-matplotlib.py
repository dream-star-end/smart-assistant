#!/usr/bin/env python3
"""Render Chinese matplotlib text and fail if glyphs are missing.

Each case is a fresh interpreter so style.use cannot leak into the next one.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import warnings
from pathlib import Path

CASES = ("default", "science-nature", "science-ieee", "nature", "networkx", "seaborn")


def glyph_stats(path: Path) -> dict[str, float | int]:
    import numpy as np
    from PIL import Image

    image = Image.open(path).convert("L")
    pixels = np.asarray(image)
    ink = pixels < 200
    ys, xs = np.where(ink)
    if len(xs) == 0:
        return {"ink": 0, "w": 0, "h": 0, "border": 1.0, "interior": 0.0}
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
    crop = ink[y0 : y1 + 1, x0 : x1 + 1]
    height, width = crop.shape
    if height < 8 or width < 8:
        return {"ink": int(ink.sum()), "w": width, "h": height, "border": 1.0, "interior": 0.0}
    border = np.concatenate([crop[0], crop[-1], crop[:, 0], crop[:, -1]])
    interior = crop[2:-2, 2:-2]
    return {
        "ink": int(ink.sum()),
        "w": int(width),
        "h": int(height),
        "border": round(float(border.mean()), 3),
        "interior": round(float(interior.mean()) if interior.size else 0.0, 3),
    }


def assert_cjk_font(tag: str) -> str:
    from matplotlib import font_manager as fm

    path = fm.findfont(fm.FontProperties())
    print(f"{tag} findfont {path}")
    if "DejaVu" in path or "STIX" in path:
        raise SystemExit(f"{tag}: findfont fell back to {path}")
    if "Noto" not in path and "wqy" not in path:
        raise SystemExit(f"{tag}: unexpected font {path}")
    return path


def draw_case(tag: str, out: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if tag == "science-nature":
        import scienceplots  # noqa: F401

        plt.style.use(["science", "nature", "no-latex"])
    elif tag == "science-ieee":
        import scienceplots  # noqa: F401

        plt.style.use(["science", "ieee", "no-latex"])
    elif tag == "nature":
        import scienceplots  # noqa: F401

        plt.style.use(["nature"])
    elif tag == "seaborn":
        import seaborn as sns

        sns.set_theme()
    elif tag not in ("default", "networkx"):
        raise SystemExit(f"unknown case {tag}")

    if plt.rcParams["axes.unicode_minus"]:
        raise SystemExit(f"{tag}: axes.unicode_minus is still True")
    assert_cjk_font(tag)

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        if tag == "networkx":
            import networkx as nx

            graph = nx.path_graph(2)
            nx.draw(
                graph,
                pos={0: (0.0, 0.0), 1: (1.0, 0.0)},
                labels={0: "方法", 1: "对照"},
                font_family="sans-serif",
                node_color="#4C78A8",
            )
            chart = out / f"{tag}.png"
            plt.savefig(chart, dpi=120)
            plt.close()
        else:
            fig, ax = plt.subplots(figsize=(4.2, 3.0), dpi=120)
            ax.plot([1, 2, 3, 4], [1.0, -0.5, 0.2, 1.4], label="方法A")
            ax.plot([1, 2, 3, 4], [0.2, 0.8, -0.3, 0.4], label="方法B")
            ax.set_title("剂量效应曲线")
            ax.set_xlabel("浓度 (μM)")
            ax.set_ylabel("抑制率 (%)")
            ax.legend()
            chart = out / f"{tag}.png"
            fig.savefig(chart)
            plt.close(fig)

        fig, ax = plt.subplots(figsize=(1.6, 1.1), dpi=100)
        ax.axis("off")
        ax.text(0.02, 0.15, "中", fontsize=72)
        glyph = out / f"{tag}-glyph.png"
        fig.savefig(glyph)
        plt.close(fig)

    missing = [
        str(item.message)
        for item in caught
        if "missing from font" in str(item.message).lower()
    ]
    if missing:
        raise SystemExit(tag + " missing glyphs:\n" + "\n".join(missing[:20]))
    stats = glyph_stats(glyph)
    print(tag, "glyph", stats, "chart_bytes", chart.stat().st_size)
    # A missing-glyph box is a hollow rectangle: the border is much darker
    # than the interior. Real strokes put ink inside the box.
    if stats["border"] >= 0.45 or stats["interior"] <= 0.15 or stats["ink"] < 200:
        raise SystemExit(f"{tag}: glyph looks like a box {stats}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/oc-cjk-mpl")
    parser.add_argument("--case", choices=CASES)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MPLCONFIGDIR", "/tmp/oc-cjk-mpl-cache")
    if args.case:
        draw_case(args.case, out)
        return
    for case in CASES:
        print(f"== {case} ==")
        subprocess.check_call(
            [sys.executable, str(Path(__file__).resolve()), "--case", case, "--out", str(out)]
        )
    print("CJK_MPL_OK")


if __name__ == "__main__":
    main()
