#!/usr/bin/env python3
"""optical-link — 自由空间光通信(FSOC)链路规格图模板(u224)。

侧视:发射望远镜 → 光束展宽(发散角)→ 大气信道(长度/衰减)→ 接收望远镜。
光路连续(端口对端口,无悬空断口)、波长/功率/几何规格标注一致——由构造保证。

示例:
  python3 template.py --range-km 5 --wavelength-nm 1550 --tx-power-dbm 30 \
      --rx-power-dbm -25 --divergence-mrad 0.05 --out fig_fsoc.png
"""
from __future__ import annotations

import argparse
import math
import sys

TEMPLATES_DIR = __file__.rsplit("/", 1)[0] if "/" in __file__ else "."
sys.path.insert(0, TEMPLATES_DIR + "/../_lib")

from scene import Polyline, Polygon, Scene, Text, palette  # noqa: E402


def build(p: argparse.Namespace, pal: dict) -> Scene:
    w, h = 16.0, 7.5
    ch_x0, ch_x1 = 5.2, w - 5.2  # 信道区左右边界
    y_opt = h * 0.46  # 光轴高度

    sc = Scene(w_cm=w, h_cm=h, title=p.title or f"自由空间光链路(L={p.range_km:g} km,λ={p.wavelength_nm:g} nm)")
    spec = sc.spec

    # 大气信道底色带(贯穿信道区,含轻微上下渐淡示意——两层多边形即可)
    sc.add(Polygon([(ch_x0, y_opt - 1.7), (ch_x1, y_opt - 1.7), (ch_x1, y_opt + 1.7), (ch_x0, y_opt + 1.7)],
                   face=pal["fill"], edge=pal["second"], lw_pt=0.7, alpha=0.5))
    sc.add(Text((ch_x0 + ch_x1) / 2, y_opt - 1.35, f"大气信道 L = {p.range_km:g} km", size_pt=8, color=pal["second"], for_id="channel"))
    spec["objects"].append({"id": "channel", "type": "atmosphere-channel", "anchor": [round((ch_x0 + ch_x1) / 2, 4), round(y_opt, 4)]})

    def telescope(cid: str, cx: float, name: str) -> tuple[float, float]:
        """筒形望远镜(梯形筒身 + 支架落地),返回朝信道端口的口径中心。"""
        tw, th = 1.9, 1.0
        port = (cx + tw / 2 - 0.08, y_opt) if cx < w / 2 else (cx - tw / 2 + 0.08, y_opt)
        base = (cx, y_opt - th / 2 - 1.05)
        sc.add(
            Polygon([(cx - tw / 2, y_opt - th / 2), (cx + tw / 2, y_opt - th / 2),
                     (cx + tw / 2, y_opt + th / 2), (cx - tw / 2, y_opt + th / 2)],
                    face=pal["fill_accent"], edge=pal["main"], lw_pt=1.2),
            Polyline([(cx - tw / 2 + 0.15, y_opt - th / 2), (cx, base[1])], color=pal["main"], lw_pt=1.0),
            Polyline([(cx + tw / 2 - 0.15, y_opt - th / 2), (cx, base[1])], color=pal["main"], lw_pt=1.0),
            Polyline([(cx - 0.8, base[1]), (cx + 0.8, base[1])], color=pal["main"], lw_pt=1.3),
            Text(cx, base[1] - 0.45, name, size_pt=8.5, for_id=cid),
        )
        spec["objects"].append({"id": cid, "type": "optical-terminal", "anchor": [round(port[0], 4), round(port[1], 4)]})
        return port

    tx_port = telescope("tx", 2.6, f"发射望远镜 口径 {p.tx_aperture_cm:g} cm")
    rx_port = telescope("rx", w - 2.6, f"接收望远镜 口径 {p.rx_aperture_cm:g} cm")

    # 光束展宽:从 TX 口径到 RX 口径的截锥(发散角 half=divergence×L/2 的简化示意)
    half_tx = 0.16
    half_rx = half_tx + p.divergence_mrad * 0.9  # 视觉放大,标注给真实值
    sc.add(Polygon([(tx_port[0], y_opt - half_tx), (rx_port[0], y_opt - half_rx),
                    (rx_port[0], y_opt + half_rx), (tx_port[0], y_opt + half_tx)],
                   face=pal["fill"], edge=pal["accent"], lw_pt=0.9, alpha=0.55))
    # 光轴(连续,无断口)
    sc.add(Polyline([tx_port, rx_port], color=pal["accent"], lw_pt=1.0, dash="--"))

    spec["links"].append({"id": "optical-path", "from": "tx", "to": "rx", "kind": "optical"})

    # 规格标注:发散角(光束上缘)+ 功率预算(下方)
    mid = ((tx_port[0] + rx_port[0]) / 2, y_opt + half_rx + 0.42)
    sc.add(Text(mid[0], mid[1], f"发散角 {p.divergence_mrad:g} mrad", size_pt=8, color=pal["second"], for_id="divergence-note"))
    spec["objects"].append({"id": "divergence-note", "type": "annotation", "anchor": [round(mid[0], 4), round(mid[1], 4)]})

    budget_y = y_opt - 1.9
    sc.add(Text(w / 2, budget_y,
                f"发射功率 {p.tx_power_dbm:g} dBm → 接收功率 {p.rx_power_dbm:g} dBm(链路损耗 {p.tx_power_dbm - p.rx_power_dbm:g} dB)",
                size_pt=8, color=pal["second"], for_id="budget-note"))
    spec["objects"].append({"id": "budget-note", "type": "annotation", "anchor": [round(w / 2, 4), round(budget_y, 4)]})
    # 功率数值(magnitudes,组内同单位 dBm;无条长声明=纯文本标注)
    spec["magnitudes"].append({"id": "tx-power", "label": "发射功率", "value": p.tx_power_dbm, "unit": "dBm", "group": "power-budget"})
    spec["magnitudes"].append({"id": "rx-power", "label": "接收功率", "value": p.rx_power_dbm, "unit": "dBm", "group": "power-budget"})
    spec["magnitudes"].append({"id": "wavelength", "label": "波长", "value": p.wavelength_nm, "unit": "nm", "group": "wavelength"})
    spec["magnitudes"].append({"id": "range", "label": "链路距离", "value": p.range_km, "unit": "km", "group": "range"})

    sc.spec_meta = {"template": "optical-link", "kind": "schematic", "units": "m", "scene": {}}
    return sc


def main() -> None:
    try:
        import matplotlib  # noqa: F401
    except ImportError as e:
        sys.exit(f"[optical-link] 缺依赖 matplotlib({e});容器应预装,本地请 pip install matplotlib")
    ap = argparse.ArgumentParser(description="FSOC 光链路规格图模板(输出 png+svg+spec.json)")
    ap.add_argument("--range-km", type=float, default=5.0)
    ap.add_argument("--wavelength-nm", type=float, default=1550)
    ap.add_argument("--tx-aperture-cm", type=float, default=10.0)
    ap.add_argument("--rx-aperture-cm", type=float, default=10.0)
    ap.add_argument("--tx-power-dbm", type=float, default=30.0)
    ap.add_argument("--rx-power-dbm", type=float, default=-25.0)
    ap.add_argument("--divergence-mrad", type=float, default=0.05)
    ap.add_argument("--style", choices=["bw", "color"], default="color")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None)
    p = ap.parse_args()

    from mpl_render import render_mpl

    render_mpl(build(p, palette(p.style)), p.out or "/tmp/optical-link.png", style=p.style)


if __name__ == "__main__":
    main()
