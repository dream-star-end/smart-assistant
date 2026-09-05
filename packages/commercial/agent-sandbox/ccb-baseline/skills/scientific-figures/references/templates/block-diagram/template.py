#!/usr/bin/env python3
"""block-diagram — 通用有向阶段链框图原型。

任意"源→阶段→…→汇"式的有向流程:处理链/信号链/数据流水线/反应路径/工作流。
链路单方向无环(支路源必须在目标上游,否则拒画)、每条连线两端都是声明的阶段——
由构造保证,并在伴生 FigureSpec(objects type=stage/annotation、links kind=flow)中声明,
供 `oc-figcheck fig.png --kind schematic --spec fig.spec.json` 复核。

示例:
  python3 template.py --chain "源,阶段A,阶段B,阶段C,汇" \
      --branch "阶段A:阶段C" --note "任意脚注" --out fig_block.png
"""
from __future__ import annotations

import argparse
import sys
from typing import NoReturn

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, palette  # noqa: E402


def fail(msg: str) -> NoReturn:
    sys.exit(f"[block-diagram] {msg}")


def parse_chain(raw: str) -> list[str]:
    names = [n.strip() for n in raw.split(",") if n.strip()]
    if len(names) < 2:
        fail("--chain 至少两个阶段(逗号分隔,按流向顺序)")
    if len(set(names)) != len(names):
        fail(f"--chain 阶段名重复:{names}")
    return names


def parse_branches(raws: list[str] | None, chain: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for raw in raws or []:
        src, sep, dst = raw.partition(":")
        if not sep:
            fail(f"--branch 格式应为 '源:目标'(收到 {raw!r})")
        src, dst = src.strip(), dst.strip()
        if src not in chain:
            fail(f"--branch 源阶段 {src!r} 不在 --chain 里")
        if dst not in chain:
            fail(f"--branch 目标阶段 {dst!r} 不在 --chain 里")
        if chain.index(src) >= chain.index(dst):
            fail(f"--branch {src}→{dst} 指向上游;链路必须单向无环(源须在目标上游)")
        if (src, dst) in out:
            fail(f"--branch {src}:{dst} 重复")
        out.append((src, dst))
    return out


def build(p: argparse.Namespace, pal: dict) -> Scene:
    chain = parse_chain(p.chain)
    branches = parse_branches(p.branch, chain)

    n = len(chain)
    bw, bh = 2.35, 1.05  # 阶段框宽高 cm
    gap = 0.95
    w = n * bw + (n - 1) * gap + 1.6
    h = 6.5 + len(branches) * 0.8  # 300dpi 下 ≥750px,满足 figcheck 分辨率门
    y_mid = h / 2 - 0.45
    x0 = 0.8

    sc = Scene(w_cm=w, h_cm=h, title=p.title or "阶段链框图")
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
        spec["objects"].append({"id": name, "type": "stage", "anchor": [round(cx, 4), round(cy, 4)]})
        if i:
            prev_cx = pos[chain[i - 1]][0] + bw / 2
            sc.add(Polyline([(prev_cx + 0.06, cy), (x_left - 0.06, cy)], color=pal["main"], lw_pt=1.1, arrow_end=True))
            spec["links"].append({"id": f"flow-{chain[i - 1]}-{name}", "from": chain[i - 1], "to": name, "kind": "flow"})

    # 支路:从源阶段上方绕到目标阶段上方,逐条抬升避免互相压线(仍单向:源在目标上游)
    for bi, (src, dst) in enumerate(branches):
        sx, sy = pos[src]
        dx, dy = pos[dst]
        y_up = y_mid + bh / 2 + 0.85 + bi * 0.8
        sc.add(Polyline([(sx, sy + bh / 2 + 0.06), (sx, y_up), (dx, y_up), (dx, dy + bh / 2 + 0.06)],
                        color=pal["accent"], lw_pt=1.0, arrow_end=True))
        bid = f"branch-{bi}"
        mid = ((sx + dx) / 2, y_up + 0.24)
        sc.add(Text(mid[0], mid[1], f"{src}→{dst}", size_pt=7.5, color=pal["second"], for_id=bid))
        spec["objects"].append({"id": bid, "type": "annotation", "anchor": [round(mid[0], 4), round(mid[1], 4)]})
        spec["links"].append({"id": f"branch-flow-{src}-{dst}", "from": src, "to": dst, "kind": "flow"})

    # 脚注(挂在链路下方)
    if p.note:
        sc.add(Text(w / 2, y_mid - bh / 2 - 0.65, p.note, size_pt=8, color=pal["second"], for_id="note"))
        spec["objects"].append({"id": "note", "type": "annotation",
                                "anchor": [round(w / 2, 4), round(y_mid - bh / 2 - 0.65, 4)]})

    sc.spec_meta = {"template": "block-diagram", "kind": "schematic", "units": None, "scene": {}}
    return sc


def main() -> None:
    ap = argparse.ArgumentParser(description="通用阶段链框图原型(输出 png+svg+spec.json 或 pptx)")
    ap.add_argument("--chain", default="源,阶段A,阶段B,阶段C,汇",
                    help="逗号分隔,按流向顺序(至少两段)")
    ap.add_argument("--branch", action="append", metavar="源:目标",
                    help="支路 '源:目标',可重复;源须在目标上游(保证无环)")
    ap.add_argument("--note", default=None, help="可选脚注(挂在链路下方)")
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--backend", choices=["mpl", "pptx"], default="mpl", help="mpl=matplotlib;pptx=python-pptx 原生可编辑 shapes")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    p = ap.parse_args()

    sc = build(p, palette(p.style))
    if p.backend == "pptx":
        from pptx_render import render_pptx

        render_pptx(sc, p.out or "/tmp/block-diagram.pptx")
        return
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[block-diagram] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    from mpl_render import render_mpl

    render_mpl(sc, p.out or "/tmp/block-diagram.png", style=p.style)


if __name__ == "__main__":
    main()
