#!/usr/bin/env python3
"""phased-array-obs — 相控阵/干涉观测示意图模板(u6 十轮返工根治)。

地面上的多个面板阵各以电子指向(boresight)形成波束锥,信号连线端点必须一端在目标
(卫星/射电源)、另一端在波束覆盖内;基线连线只连测站参考点,与信号线用不同线型。

模板构造即保证物理一致;参数不成立(目标落在锥外)会 fail-loud 拒画。
伴生 FigureSpec 带 beam(boresight_deg/half_angle_deg) 与 must_be_in_beam_of,
供 `oc-figcheck fig.png --kind schematic --spec fig.spec.json` 规则化复核。

示例:
  python3 template.py --panels "P1:0,35;P2:8,35;P3:16,35" --target "SAT:8,30" \
      --half-angle-deg 12 --out fig_obs.png
"""
from __future__ import annotations

import argparse
import math
import sys
from typing import NoReturn

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, palette, sector_pts  # noqa: E402


def fail(msg: str) -> NoReturn:
    sys.exit(f"[phased-array-obs] {msg}")


def parse_panels(raw: str) -> list[tuple[str, float, float]]:
    out = []
    for part in raw.split(";"):
        name, _, rest = part.partition(":")
        xs, _, os_ = rest.partition(",")
        try:
            out.append((name.strip(), float(xs), float(os_)))
        except ValueError:
            fail(f"--panels 格式应为 '名:x_m,boresight_deg;...'(收到 {part!r})")
    if not out:
        fail("--panels 至少一个面板")
    for _, _, o in out:
        if not 5 <= o <= 175:
            fail(f"boresight 应在 5..175°(朝上半空间,90°=天顶),收到 {o}°")
    return out


def parse_target(raw: str) -> tuple[str, float, float]:
    name, _, rest = raw.partition(":")
    xs, _, ys = rest.partition(",")
    try:
        return name.strip(), float(xs), float(ys)
    except ValueError:
        fail(f"--target 格式应为 '名:x_m,y_m'(收到 {raw!r})")


def in_beam(panel_xy: tuple[float, float], boresight_deg: float, half_deg: float, tgt_xy: tuple[float, float]) -> bool:
    vx, vy = tgt_xy[0] - panel_xy[0], tgt_xy[1] - panel_xy[1]
    b = math.radians(boresight_deg)
    bx, by = math.cos(b), math.sin(b)
    n = math.hypot(vx, vy)
    if n < 1e-9:
        return True
    cosang = (vx * bx + vy * by) / n
    return math.degrees(math.acos(max(-1.0, min(1.0, cosang)))) <= half_deg


def build(p: argparse.Namespace, pal: dict) -> Scene:
    panels = parse_panels(p.panels)
    tname, tx_m, ty_m = parse_target(p.target)

    # 世界坐标(m) → 画布(cm);面板都在地面(y=0),纵坐标只有地面与目标。
    # 比例尺由宽度主导,高度随目标高度自适应(标题+卫星标签留位),避免顶部重叠。
    xs = [x for _, x, _ in panels] + [tx_m]
    span_x = (max(xs) - min(xs)) or 1.0
    span_y = max(ty_m, 1.0)
    w = 14.0
    pad = 1.3
    s = (w - 2 * pad) / max(span_x, span_y * 1.05, 1.0)
    h = ty_m * s + 3.2  # 地面下缘 0.55 + 头部(标题+卫星标签) ≈2.65

    def X(xm: float) -> float:
        return (w - span_x * s) / 2 + (xm - min(xs)) * s

    def Y(ym: float) -> float:
        return 1.0 + ym * s

    ground_y = Y(0)
    sc = Scene(w_cm=w, h_cm=h, title=p.title or "相控阵干涉观测示意")
    spec = sc.spec

    # 地面
    sc.add(
        Polyline([(0.3, ground_y), (w - 0.3, ground_y)], color=pal["main"], lw_pt=1.3),
        Polygon([(0.3, ground_y), (w - 0.3, ground_y), (w - 0.3, ground_y - 0.55), (0.3, ground_y - 0.55)],
                face=pal["fill"], edge=pal["main"], lw_pt=0.5, alpha=0.6),
    )
    spec["objects"].append({"id": "ground", "type": "ground", "anchor": [w / 2, ground_y]})

    # 目标(卫星)
    tgt_xy = (X(tx_m), Y(ty_m))
    sc.add(
        Polygon([(tgt_xy[0] - 0.34, tgt_xy[1] + 0.1), (tgt_xy[0] + 0.34, tgt_xy[1] + 0.1),
                 (tgt_xy[0] + 0.2, tgt_xy[1] + 0.42), (tgt_xy[0] - 0.2, tgt_xy[1] + 0.42)],
                face=pal["fill_accent"], edge=pal["main"]),
        Text(tgt_xy[0] + 0.55, tgt_xy[1] + 0.42, f"{tname}({tx_m:g},{ty_m:g} m)", size_pt=8, anchor="left", for_id=tname),
    )
    spec["objects"].append({"id": tname, "type": "satellite", "anchor": [round(tgt_xy[0], 4), round(tgt_xy[1], 4)]})

    # 各面板:基座(落地) + 面板(坐基座) + 波束锥 + 信号线
    for name, xm, boresight in panels:
        base_xy = (X(xm), ground_y)
        mast_h = 0.45
        top = (base_xy[0], base_xy[1] + mast_h)
        b = math.radians(boresight)
        axv, ayv = math.cos(b), math.sin(b)
        # 面板:短粗线段(垂直于 boresight 的平板)
        half = 0.38
        pa = (top[0] - half * ayv, top[1] + half * axv)
        pb = (top[0] + half * ayv, top[1] - half * axv)
        sc.add(
            Polyline([(base_xy[0] - 0.16, ground_y), (top[0], top[1])], color=pal["main"], lw_pt=1.6),  # 基座立柱
            Polyline([pa, pb], color=pal["main"], lw_pt=2.4),  # 面板
            Polyline([top, (top[0] + 0.75 * axv, top[1] + 0.75 * ayv)], color=pal["second"], lw_pt=0.8,
                     arrow_end=True),  # 法线指示
            Text(base_xy[0] + 0.3, ground_y + 0.5, f"{name} {boresight:g}°", size_pt=7.5, anchor="left", for_id=name),
        )
        spec["objects"].append({"id": f"mount-{name}", "type": "mount", "anchor": [round(base_xy[0], 4), round((ground_y + top[1]) / 2, 4)],
                                "supports": "ground"})
        spec["objects"].append({"id": name, "type": "phased-array", "anchor": [round(top[0], 4), round(top[1], 4)],
                                "supports": f"mount-{name}", "orientation_deg": boresight,
                                "beam": {"boresight_deg": boresight, "half_angle_deg": p.half_angle_deg}})

        # 波束锥:半径取到目标的 1.15 倍(目标画在锥内),并裁剪不超出画布
        beam_r = math.dist(top, tgt_xy) * 1.15
        to_top = (h - 0.45 - top[1]) / max(math.sin(b), 0.35)  # 沿 boresight 到画布顶的近似距离
        beam_r = max(math.dist(top, tgt_xy) * 1.05, min(beam_r, to_top))
        sc.add(Polygon(sector_pts(top[0], top[1], beam_r, boresight - p.half_angle_deg, boresight + p.half_angle_deg),
                       face=pal["fill"], edge=pal["accent"], lw_pt=0.6, alpha=0.45))

        # 物理预检:目标必须在锥内(fail-loud,不静默画错图)
        if not in_beam(top, boresight, p.half_angle_deg, tgt_xy):
            fail(f"面板 {name}(boresight {boresight:g}°,半张角 {p.half_angle_deg:g}°)的波束覆盖不到目标 {tname};"
                 f"请调整 --panels 的指向角、--half-angle-deg 或 --target 位置——不允许画出'连线进不了波束'的错误示意图")
        # 信号线:面板相位中心 → 目标
        sc.add(Polyline([top, tgt_xy], color=pal["accent"], lw_pt=1.1, arrow_end=True,
                        label="信号连线" if name == panels[0][0] else None))
        spec["links"].append({"id": f"sig-{name}", "from": name, "to": tname, "kind": "signal",
                              "must_be_in_beam_of": name})

    # 基线:只连测站基座参考点(与信号线不同线型,图例强制区分);抬离地面线避免重合
    baseline_y = ground_y + 0.18
    for i in range(len(panels) - 1):
        a = (X(panels[i][1]), baseline_y)
        b2 = (X(panels[i + 1][1]), baseline_y)
        sc.add(Polyline([a, b2], color=pal["second"], lw_pt=1.0, dash="--",
                        label="基线" if i == 0 else None))
        spec["links"].append({"id": f"baseline-{panels[i][0]}-{panels[i + 1][0]}",
                              "from": f"mount-{panels[i][0]}", "to": f"mount-{panels[i + 1][0]}", "kind": "baseline"})
    sc.legend = True
    sc.legend_loc = "upper right"
    sc.spec_meta = {"template": "phased-array-obs", "kind": "schematic", "units": "m",
                    "scene": {"grounding": "required"}}
    return sc


def main() -> None:
    ap = argparse.ArgumentParser(description="相控阵/干涉观测示意图模板(输出 png+svg+spec.json 或 pptx)")
    ap.add_argument("--panels", default="P1:0,75;P2:8,90;P3:16,105", help="'名:x_m,boresight_deg;...'(三站干涉构型默认同盯一颗目标)")
    ap.add_argument("--target", default="SAT:8,30", help="'名:x_m,y_m'")
    ap.add_argument("--half-angle-deg", type=float, default=12.0, help="波束半张角(°)")
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--backend", choices=["mpl", "pptx"], default="mpl", help="mpl=matplotlib;pptx=python-pptx 原生可编辑 shapes")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    p = ap.parse_args()

    pal = palette(p.style)
    sc = build(p, pal)
    if p.backend == "pptx":
        from pptx_render import render_pptx

        render_pptx(sc, p.out or "/tmp/phased-array-obs.pptx")
        return
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[phased-array-obs] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    from mpl_render import render_mpl

    render_mpl(sc, p.out or "/tmp/phased-array-obs.png", style=p.style)


if __name__ == "__main__":
    main()
