#!/usr/bin/env python3
"""antenna-station — 测站布局 / 抛物面天线系统示意图模板。

两个子模式:
  --mode elevation  侧视(俯仰面):基墩-塔架-抛物面-馈源支撑腿-波束方向,防"悬空/倒扣";
  --mode layout     俯视:多测站坐标 + 基线连线(测站布局/基线网)。

伴生 FigureSpec(与图同步生成):支撑链必须落到 ground、馈源腿 >=3、开口朝向=波束方向。
出图后用 `oc-figcheck fig.png --kind schematic --spec fig.spec.json` 过物理一致性门。

示例:
  python3 template.py --mode elevation --station 测站A --diameter-m 25 --elevation-deg 45 \
      --tower-m 12 --style bw --out fig_antenna.png
  python3 template.py --mode layout --stations "A:0,0;B:120,60;C:200,-40" --out fig_layout.png
"""
from __future__ import annotations

import argparse
import math
import sys
from typing import NoReturn

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, arc_pts, palette  # noqa: E402


def fail(msg: str) -> NoReturn:
    sys.exit(f"[antenna-station] {msg}")


def parse_stations(raw: str) -> list[tuple[str, float, float]]:
    out = []
    for part in raw.split(";"):
        name, _, xy = part.partition(":")
        xs, _, ys = xy.partition(",")
        try:
            out.append((name.strip(), float(xs), float(ys)))
        except ValueError:
            fail(f"--stations 格式应为 '名:x,y;...'(收到 {part!r})")
    if not out:
        fail("--stations 至少一个测站")
    return out


def build_elevation(p: argparse.Namespace, pal: dict) -> Scene:
    """侧视:地面 y=0;基墩落地 → 塔架 → 抛物面(开口沿仰角朝斜上)→ 馈源在焦点。

    物理关系由构造保证:天线坐在塔顶、支撑链全部落地、开口朝向=波束方向(禁止倒扣)。
    """
    h = 12.0  # 画布高 cm
    scale = 0.82 * h / max(p.tower_m + p.diameter_m, 1e-6)  # m → cm,留标题/图例空间
    ground_y = 1.2
    cx = 3.8

    if not (0 < p.elevation_deg < 90):
        fail(f"仰角应在 (0,90)°内,收到 {p.elevation_deg}(0=水平贴地、90=天顶;负仰角=倒扣,被禁止)")

    elev = math.radians(p.elevation_deg)
    axis = (math.cos(elev), math.sin(elev))  # 反射轴/波束方向:与水平面夹角=仰角
    perp = (-axis[1], axis[0])  # 口径方向

    def y_of(m_above_ground: float) -> float:
        return ground_y + m_above_ground * scale

    H = p.tower_m * scale
    R = p.diameter_m * scale / 2
    focal_len = 0.35 * 2 * R  # 焦比 f/D=0.35 → f=0.35D=0.7R
    top_y = y_of(p.tower_m)

    sc = Scene(w_cm=9.5, h_cm=h, title=p.title or f"{p.station} 抛物面天线(侧视)")
    spec = sc.spec

    # 地面
    sc.add(
        Polyline([(0.3, ground_y), (9.2, ground_y)], color=pal["main"], lw_pt=1.4),
        Polygon([(0.3, ground_y), (9.2, ground_y), (9.2, ground_y - 0.9), (0.3, ground_y - 0.9)],
                face=pal["fill"], edge=pal["main"], lw_pt=0.6, alpha=0.7),
        Text(0.75, ground_y - 0.5, "地面", size_pt=8, color=pal["second"], anchor="left"),
    )
    spec["objects"].append({"id": "ground", "type": "ground", "anchor": [0.75, ground_y]})

    # 基墩(落地)
    pw = 0.9
    sc.add(Polygon([(cx - pw / 2, ground_y), (cx + pw / 2, ground_y), (cx + pw / 2 * 0.7, ground_y + 0.5),
                    (cx - pw / 2 * 0.7, ground_y + 0.5)], face=pal["fill_accent"], edge=pal["main"]))
    spec["objects"].append({"id": "foundation", "type": "foundation", "anchor": [cx, ground_y + 0.25], "supports": "ground"})
    sc.add(Text(cx + 0.8, ground_y + 0.25, f"基墩(塔高 {p.tower_m:g} m)", size_pt=8, anchor="left", for_id="foundation"))

    # 塔架(桁架:两斜腿 + 横撑)
    tw_bottom, tw_top = 0.6, 0.26
    base_y = ground_y + 0.5
    sc.add(
        Polyline([(cx - tw_bottom / 2, base_y), (cx - tw_top / 2, top_y)], color=pal["main"], lw_pt=1.1),
        Polyline([(cx + tw_bottom / 2, base_y), (cx + tw_top / 2, top_y)], color=pal["main"], lw_pt=1.1),
    )
    n_brace = max(2, int(p.tower_m / 4))
    for i in range(1, n_brace + 1):
        f = i / (n_brace + 1)
        yb = base_y * (1 - f) + top_y * f
        xl = (cx - tw_bottom / 2) * (1 - f) + (cx - tw_top / 2) * f
        xr = (cx + tw_bottom / 2) * (1 - f) + (cx + tw_top / 2) * f
        sc.add(Polyline([(xl, yb), (xr, yb)], color=pal["fill_accent"], lw_pt=0.55))
    spec["objects"].append({"id": "tower", "type": "tower", "anchor": [cx, (base_y + top_y) / 2], "supports": "foundation"})
    sc.add(Text(cx + 0.8, (base_y + top_y) / 2, "塔架", size_pt=8, anchor="left", for_id="tower"))

    # 抛物面剖面:局部 v = u²/(4f),开口向 +axis;顶点在塔顶 mount
    mount = (cx, top_y)
    dish_pts = []
    for i in range(25):
        u = -R + 2 * R * i / 24
        v = u * u / (4 * focal_len)
        dish_pts.append((mount[0] + u * perp[0] + v * axis[0], mount[1] + u * perp[1] + v * axis[1]))
    rim_a, rim_b = dish_pts[0], dish_pts[-1]
    dish_back = [(x - 0.12 * axis[0], y - 0.12 * axis[1]) for (x, y) in dish_pts]  # 背面微偏移给厚度感
    sc.add(Polygon([*dish_pts, *reversed(dish_back)], face=pal["fill"], edge=pal["main"], lw_pt=1.4, alpha=0.95))

    focus = (mount[0] + focal_len * axis[0], mount[1] + focal_len * axis[1])
    # 馈源支撑腿 >=3:口径 -R / 中上 +R/2 / +R 三个位置到焦点(侧视投影)
    for u_leg in (-R, R, R / 2):
        start = (mount[0] + u_leg * perp[0] + (u_leg * u_leg / (4 * focal_len)) * axis[0],
                 mount[1] + u_leg * perp[1] + (u_leg * u_leg / (4 * focal_len)) * axis[1])
        sc.add(Polyline([start, focus], color=pal["second"], lw_pt=0.8))
    sc.add(Polygon(arc_pts(focus[0], focus[1], 0.2, 0, 360), face=pal["fill_accent"], edge=pal["main"], lw_pt=1.0))

    spec["objects"].append({"id": "dish", "type": "parabolic-dish", "anchor": [mount[0], mount[1] + 0.3],
                            "supports": "tower", "orientation_deg": p.elevation_deg, "diameter_m": p.diameter_m})
    dish_top = max(pt[1] for pt in dish_pts)
    sc.add(Text(cx - 0.45, min(dish_top + 0.42, h - 0.55), f"抛物面 D={p.diameter_m:g} m",
                size_pt=8, anchor="right", for_id="dish"))
    spec["objects"].append({"id": "feed", "type": "feed", "anchor": [round(focus[0], 4), round(focus[1], 4)], "supports": "dish"})
    # 馈源标签外移到馈源斜下方(让开波束虚线与支撑腿),短线引回馈源圆点
    sc.add(
        Text(focus[0] - 0.45, focus[1] - 0.38, "馈源", size_pt=8, anchor="right", for_id="feed"),
        Polyline([(focus[0] - 0.34, focus[1] - 0.29), (focus[0] - 0.15, focus[1] - 0.13)],
                 color=pal["second"], lw_pt=0.5),
    )

    # 波束方向:馈源沿轴(开口朝向)虚线箭头,长度裁到画布内
    t_max = min(
        (9.0 - focus[0]) / axis[0] if axis[0] > 1e-9 else math.inf,
        (h - 0.6 - focus[1]) / axis[1] if axis[1] > 1e-9 else math.inf,
    )
    beam_end = (focus[0] + t_max * axis[0], focus[1] + t_max * axis[1])
    sc.add(Polyline([focus, beam_end], color=pal["accent"], lw_pt=1.2, dash="--", arrow_end=True,
                    label=f"波束方向({p.elevation_deg:g}°)"))
    sc.legend = True
    sc.legend_loc = "upper left"
    # 锚到标题带下方的左上空白区(默认几何下该处无对象/标签;偏离默认参数由 --spec 门拦截)
    sc.legend_anchor = (0.55, h - 1.1)
    # 波束=方向指示,以对象关系入 spec(from/to 均已声明,过端点检查)
    spec["links"].append({"id": "beam-dir", "from": "feed", "to": "dish", "kind": "boresight"})

    sc.spec_meta = {"template": "antenna-station", "kind": "schematic", "units": "m",
                    "scene": {"grounding": "required"}}
    return sc


def build_layout(p: argparse.Namespace, pal: dict) -> Scene:
    stations = parse_stations(p.stations)
    xs = [s[1] for s in stations]
    ys = [s[2] for s in stations]
    span_x = max(xs) - min(xs) or 1.0
    span_y = max(ys) - min(ys) or 1.0
    pad = 1.5
    # 比例尺由横向主导(铺满画布宽),高度随之自适应,避免 x 方向大片留白=取景过空
    s = min((14.0 - 2 * pad) / span_x, 0.06)
    w = span_x * s + 2 * pad
    h = span_y * s + 3.0
    x0 = pad - min(xs) * s
    y0 = (h - 0.6 - span_y * s) / 2 - min(ys) * s

    sc = Scene(w_cm=w, h_cm=h, title=p.title or "测站布局与基线网")
    # 坐标网格 + 刻度数字(每 span/4):稀疏布局图的内容密度与可读坐标参照
    grid_step = max(span_x, span_y) / 4
    n_grid_x = int(round(span_x / grid_step)) + 1
    n_grid_y = int(round(span_y / grid_step)) + 1
    for i in range(n_grid_x + 1):
        xg = min(xs) + i * grid_step
        gx = x0 + xg * s
        if 0.6 < gx < w - 0.4:
            sc.add(
                Polyline([(gx, 0.75), (gx, h - 0.95)], color=pal["fill_accent"], lw_pt=0.7),
                Text(gx, 0.48, f"{xg:.0f}", size_pt=6.5, color=pal["second"]),
            )
    for j in range(n_grid_y + 1):
        yg = min(ys) + j * grid_step
        gy = y0 + yg * s
        if 0.6 < gy < h - 0.95:
            sc.add(
                Polyline([(0.7, gy), (w - 0.45, gy)], color=pal["fill_accent"], lw_pt=0.7),
                Text(0.32, gy, f"{yg:.0f}", size_pt=6.5, color=pal["second"], anchor="right"),
            )
    for i in range(len(stations)):
        for j in range(i + 1, len(stations)):
            (na, xa, ya), (nb, xb, yb) = stations[i], stations[j]
            pa = (x0 + xa * s, y0 + ya * s)
            pb = (x0 + xb * s, y0 + yb * s)
            blen = math.dist((xa, ya), (xb, yb))
            mid = ((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2)
            sc.add(Polyline([pa, pb], color=pal["second"], lw_pt=1.0, dash="--",
                            label="基线" if i == 0 and j == 1 else None))
            sc.add(Text(mid[0], mid[1] + 0.26, f"{blen:.0f} km", size_pt=7, color=pal["second"]))
            sc.spec["links"].append({"id": f"baseline-{na}-{nb}", "from": na, "to": nb, "kind": "baseline"})
    for name, xm, ym in stations:
        pos = (x0 + xm * s, y0 + ym * s)
        ring = arc_pts(pos[0], pos[1], 0.4, 0, 360)
        ring2 = arc_pts(pos[0], pos[1], 0.55, 0, 360)
        anchor = "center"
        if pos[0] > 0.82 * w:
            anchor = "right"
        elif pos[0] < 0.18 * w:
            anchor = "left"
        label_y = pos[1] - 1.0 if pos[1] > 0.85 * h else pos[1] + 0.95
        sc.add(
            Polygon(ring2, face=pal["fill"], edge=pal["second"], lw_pt=0.6, alpha=0.6),
            Polygon(ring, face=pal["fill_accent"], edge=pal["main"], lw_pt=1.4),
            Text(pos[0], label_y, f"{name}({xm:g},{ym:g})", size_pt=8.5, anchor=anchor, for_id=name),
        )
        sc.spec["objects"].append({"id": name, "type": "station", "anchor": [round(pos[0], 4), round(pos[1], 4)],
                                   "supports": "ground"})
    # 手动图例(单一线型,不占 mpl legend 边角):左上角虚线样例 + 文字
    sc.add(
        Polyline([(1.1, h - 1.05), (2.2, h - 1.05)], color=pal["second"], lw_pt=1.0, dash="--"),
        Text(2.4, h - 1.05, "基线", size_pt=8, color=pal["text"], anchor="left"),
    )
    sc.spec_meta = {"template": "antenna-station", "kind": "schematic", "units": "km",
                    "scene": {"grounding": "required"}}
    return sc


def main() -> None:
    ap = argparse.ArgumentParser(description="测站布局/抛物面天线系统示意图模板(输出 png+svg+spec.json 或 pptx)")
    ap.add_argument("--mode", choices=["elevation", "layout"], default="elevation")
    ap.add_argument("--station", default="测站A", help="elevation 模式测站名")
    ap.add_argument("--diameter-m", type=float, default=25.0, help="抛物面口径 D(m)")
    ap.add_argument("--elevation-deg", type=float, default=45.0, help="仰角(0,90)°")
    ap.add_argument("--tower-m", type=float, default=12.0, help="塔架高度(m)")
    ap.add_argument("--stations", default="A:0,0;B:120,60;C:200,-40", help="layout 模式:'名:x_km,y_km;...'")
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--backend", choices=["mpl", "pptx"], default="mpl", help="mpl=matplotlib 位图+矢量;pptx=python-pptx 原生可编辑 shapes")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None, help="输出路径(默认 /tmp/antenna-station-<mode>.png|.pptx)")
    p = ap.parse_args()

    pal = palette(p.style)
    sc = build_elevation(p, pal) if p.mode == "elevation" else build_layout(p, pal)

    if p.backend == "pptx":
        from pptx_render import render_pptx

        render_pptx(sc, p.out or f"/tmp/antenna-station-{p.mode}.pptx")
        return
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[antenna-station] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    from mpl_render import render_mpl

    render_mpl(sc, p.out or f"/tmp/antenna-station-{p.mode}.png", style=p.style)


if __name__ == "__main__":
    main()
