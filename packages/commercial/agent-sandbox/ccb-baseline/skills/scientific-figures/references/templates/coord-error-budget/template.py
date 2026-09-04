#!/usr/bin/env python3
"""coord-error-budget — 坐标系与误差预算图模板(u6 EOP 量级痛点)。

水平误差条图:**同量纲同组、组内条长按 log10 量级归一**,不同量纲(不同单位)分面板,
每条误差条带"数值+单位"。EOP 常见量级参考表内置于 constraints.json(数值可查、不进代码)。

示例:
  python3 template.py --items "PM-X:0.48:mas,PM-Y:0.35:mas,UT1:0.21:ms,LOD:0.02:ms,对流层延迟:0.15:m,固体潮:0.003:m" \
      --out fig_err.png
  python3 template.py --demo
"""
from __future__ import annotations

import argparse
import math
import sys
from typing import NoReturn

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, palette  # noqa: E402

DEMO_ITEMS = (
    "PM-X:0.48:mas,PM-Y:0.35:mas,UT1:0.21:ms,LOD:0.02:ms,"
    "对流层延迟:0.15:m,固体潮:0.003:m,测站速度:0.001:m"
)


def fail(msg: str) -> NoReturn:
    sys.exit(f"[coord-error-budget] {msg}")


def parse_items(raw: str) -> list[tuple[str, float, str]]:
    out = []
    for part in raw.split(","):
        segs = part.split(":")
        if len(segs) != 3:
            fail(f"--items 格式应为 '名:数值:单位,...'(收到 {part!r})")
        name, val, unit = segs[0].strip(), segs[1].strip(), segs[2].strip()
        try:
            v = float(val)
        except ValueError:
            fail(f"--items 数值不合法:{val!r}")
        if v <= 0:
            fail(f"误差量级必须为正(条长取 log10):{name}={val}")
        if not unit:
            fail(f"--items 单位不能为空:{name}")
        out.append((name, v, unit))
    if not out:
        fail("--items 至少一项")
    return out


def build(p: argparse.Namespace, pal: dict) -> Scene:
    items = parse_items(p.items)
    # 同量纲(同单位字符串)同组;跨单位(如 s 与 ms)由调用方先换算成一致单位
    groups: list[tuple[str, list[tuple[str, float, str]]]] = []
    for name, v, unit in items:
        for gi, (gunit, gitems) in enumerate(groups):
            if gunit == unit:
                gitems.append((name, v, unit))
                break
        else:
            groups.append((unit, [(name, v, unit)]))

    n_rows_total = len(items)
    row_h = 0.62
    panel_gap = 0.9
    label_w = 3.3
    bar_w = 8.2
    w = label_w + bar_w + 2.6
    h = 1.5 + n_rows_total * row_h + (len(groups) - 1) * panel_gap + 0.9

    sc = Scene(w_cm=w, h_cm=h, title=p.title or "误差预算(条长按 log10 量级归一,组内同量纲)")
    spec = sc.spec

    y = h - 1.5
    for gunit, gitems in groups:
        vals = [v for _, v, _ in gitems]
        vmin, vmax = min(vals), max(vals)
        # log 轴映射:log10(v) 线性 → 条长(全组最小/最大条长固定在 1.2..bar_w)
        lo, hi = math.log10(vmin), math.log10(vmax)
        span = hi - lo

        def bar_len(v: float) -> float:
            if span < 1e-9:  # 同组全部同值:条长一致
                return (1.2 + bar_w) / 2
            return 1.2 + (math.log10(v) - lo) / span * (bar_w - 1.2)

        # 组面板标题(单位)
        sc.add(Text(label_w / 2, y + 0.45, f"[单位:{gunit}]", size_pt=8, color=pal["second"]))
        for name, v, _ in gitems:
            L = bar_len(v)
            y0, y1 = y - row_h / 2, y + row_h / 2
            sc.add(
                Polygon([(label_w, y0), (label_w + L, y0), (label_w + L, y1), (label_w, y1)],
                        face=pal["fill_accent"], edge=pal["main"], lw_pt=0.9),
                Text(label_w - 0.25, y, name, size_pt=8.5, anchor="right", for_id=f"item-{name}"),
                Text(label_w + L + 0.3, y, f"{v:g} {gunit}", size_pt=8, anchor="left"),
            )
            spec["objects"].append({"id": f"item-{name}", "type": "error-bar",
                                    "anchor": [round(label_w + L / 2, 4), round(y, 4)]})
            spec["magnitudes"].append({"id": f"item-{name}", "label": name, "value": v, "unit": gunit,
                                       "group": gunit, "rendered_length": round(L, 4)})
            y -= row_h
        y -= panel_gap

    sc.spec_meta = {"template": "coord-error-budget", "kind": "figure", "units": None, "scene": {}}
    return sc


def main() -> None:
    ap = argparse.ArgumentParser(description="坐标系/误差预算图模板(条长 log10 量级归一,输出 png+svg+spec.json 或 pptx)")
    ap.add_argument("--items", default=DEMO_ITEMS, help="'名:数值:单位,...';同单位自动同组,跨单位请先换算")
    ap.add_argument("--demo", action="store_true", help="使用内置 VLBI/EOP 演示数据")
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--backend", choices=["mpl", "pptx"], default="mpl", help="mpl=matplotlib;pptx=python-pptx 原生可编辑 shapes")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    p = ap.parse_args()
    if p.demo:
        p.items = DEMO_ITEMS

    sc = build(p, palette(p.style))
    if p.backend == "pptx":
        from pptx_render import render_pptx

        render_pptx(sc, p.out or "/tmp/coord-error-budget.pptx")
        return
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[coord-error-budget] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    from mpl_render import render_mpl

    render_mpl(sc, p.out or "/tmp/coord-error-budget.png", style=p.style)


if __name__ == "__main__":
    main()
