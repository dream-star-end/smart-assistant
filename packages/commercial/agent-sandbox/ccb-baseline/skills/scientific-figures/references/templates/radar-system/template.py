#!/usr/bin/env python3
"""radar-system — 雷达系统链路(框图)模板。

线性信号链(振荡器→功放→天线→信道→接收→处理)+ 可选注入支路(如本振→混频器)。
链路单方向无环、每条连线两端都是声明的器件端口——由构造保证,并在 spec 中声明,
供 `oc-figcheck fig.png --kind schematic --spec fig.spec.json` 复核。

示例:
  python3 template.py --chain "振荡器,功放,发射天线,信道,接收天线,低噪放,混频器,ADC,信号处理" \
      --inject "本振:混频器" --band "X 波段 9.4 GHz" --out fig_radar.png
"""
from __future__ import annotations

import argparse
import sys
from typing import NoReturn

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, palette  # noqa: E402


def fail(msg: str) -> NoReturn:
    sys.exit(f"[radar-system] {msg}")


def parse_chain(raw: str) -> list[str]:
    names = [n.strip() for n in raw.split(",") if n.strip()]
    if len(names) < 2:
        fail("--chain 至少两个器件(逗号分隔,按信号流顺序)")
    if len(set(names)) != len(names):
        fail(f"--chain 器件名重复:{names}")
    return names


def build(p: argparse.Namespace, pal: dict) -> Scene:
    chain = parse_chain(p.chain)
    inject = None
    if p.inject:
        src, _, dst = p.inject.partition(":")
        src, dst = src.strip(), dst.strip()
        if src not in chain:
            fail(f"--inject 源器件 {src!r} 不在 --chain 里")
        if dst not in chain:
            fail(f"--inject 目标器件 {dst!r} 不在 --chain 里")
        if chain.index(src) > chain.index(dst):
            fail(f"--inject {src}→{dst} 指向左方(上游),链路必须单向无环")
        inject = (src, dst)

    n = len(chain) + (1 if inject else 0)
    bw, bh = 2.35, 1.05  # 器件框宽高 cm
    gap = 0.95
    w = n * bw + (n - 1) * gap + 1.6
    h = 6.5  # 300dpi 下 ≥750px,满足 figcheck 分辨率门
    y_mid = h / 2 - 0.45
    x0 = 0.8

    sc = Scene(w_cm=w, h_cm=h, title=p.title or "雷达系统链路")
    spec = sc.spec

    pos: dict[str, tuple[float, float]] = {}
    for i, name in enumerate(chain):
        x_left = x0 + i * (bw + gap)
        cx, cy = x_left + bw / 2, y_mid
        sc.add(
            Polygon([(x_left, cy - bh / 2), (x_left + bw, cy - bh / 2), (x_left + bw, cy + bh / 2), (x_left, cy + bh / 2)],
                    face=pal["fill"], edge=pal["main"], lw_pt=1.1),
            Text(cx, cy, name, size_pt=8.5, for_id=name),
        )
        pos[name] = (cx, cy)
        spec["objects"].append({"id": name, "type": "device", "anchor": [round(cx, 4), round(cy, 4)]})
        if i:
            prev_cx = pos[chain[i - 1]][0] + bw / 2
            sc.add(Polyline([(prev_cx + 0.06, cy), (x_left - 0.06, cy)], color=pal["main"], lw_pt=1.1, arrow_end=True))
            spec["links"].append({"id": f"flow-{chain[i - 1]}-{name}", "from": chain[i - 1], "to": name, "kind": "signal-flow"})

    # 注入支路:从源器件上方绕到目标器件上方(单向)
    if inject:
        src, dst = inject
        sx, sy = pos[src]
        dx, dy = pos[dst]
        y_up = y_mid + bh / 2 + 0.85
        sc.add(Polyline([(sx, sy + bh / 2 + 0.06), (sx, y_up), (dx, y_up), (dx, dy + bh / 2 + 0.06)],
                        color=pal["accent"], lw_pt=1.0, arrow_end=True))
        mid = ((sx + dx) / 2, y_up + 0.24)
        sc.add(Text(mid[0], mid[1], p.inject_label or f"{src}→{dst}", size_pt=7.5, color=pal["second"], for_id=f"inj-{src}-{dst}"))
        spec["objects"].append({"id": f"inj-{src}-{dst}", "type": "annotation",
                                "anchor": [round(mid[0], 4), round(mid[1], 4)]})
        spec["links"].append({"id": f"inject-{src}-{dst}", "from": f"inj-{src}-{dst}", "to": dst, "kind": "signal-flow"})

    # 频段/体制标注(挂在链路下方)
    if p.band:
        sc.add(Text(w / 2, y_mid - bh / 2 - 0.65, f"工作频段:{p.band}", size_pt=8, color=pal["second"], for_id="band-note"))
        spec["objects"].append({"id": "band-note", "type": "annotation",
                                "anchor": [round(w / 2, 4), round(y_mid - bh / 2 - 0.65, 4)]})

    sc.spec_meta = {"template": "radar-system", "kind": "schematic", "units": None, "scene": {}}
    return sc


def main() -> None:
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[radar-system] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    ap = argparse.ArgumentParser(description="雷达系统链路框图模板(输出 png+svg+spec.json)")
    ap.add_argument("--chain", default="振荡器,功放,发射天线,信道,接收天线,低噪放,混频器,ADC,信号处理",
                    help="逗号分隔,按信号流顺序")
    ap.add_argument("--inject", default=None, help="注入支路 '源:目标'(如 '本振:混频器';源须在目标上游)")
    ap.add_argument("--inject-label", default=None)
    ap.add_argument("--band", default="X 波段 9.4 GHz")
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    p = ap.parse_args()

    from mpl_render import render_mpl

    render_mpl(build(p, palette(p.style)), p.out or "/tmp/radar-system.png", style=p.style)


if __name__ == "__main__":
    main()
