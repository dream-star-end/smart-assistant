"""matplotlib 后端渲染器:Scene → PNG(+SVG)+ FigureSpec JSON。"""
from __future__ import annotations

import json
import math
import pathlib
import sys

from scene import Scene


def apply_style(style: str) -> None:
    """science/nature 版式基底 + journal-bw/color 覆盖层;容器无 LaTeX 必须带 no-latex。"""
    import matplotlib.pyplot as plt

    styles_dir = pathlib.Path(__file__).resolve().parent.parent.parent / "styles"
    overlay = styles_dir / ("journal-bw.mplstyle" if style == "bw" else "journal-color.mplstyle")
    if not overlay.exists():
        sys.exit(f"[mpl_render] 样式文件缺失: {overlay}")
    try:
        import scienceplots  # noqa: F401
    except ImportError as e:  # fail-loud:容器应预装 scienceplots
        sys.exit(f"[mpl_render] 缺依赖 scienceplots({e});请勿静默降级,先安装再出图")
    plt.style.use(["science", "no-latex", str(overlay)])
    plt.rcParams["font.family"] = ["Noto Serif CJK SC", "serif"]


def render_mpl(scene: Scene, out_png: str, style: str = "color", also_svg: bool = True) -> dict:
    import matplotlib.pyplot as plt

    apply_style(style)
    fig = plt.figure(figsize=(scene.w_cm / 2.54, scene.h_cm / 2.54))
    ax = fig.add_axes([0.005, 0.005, 0.99, 0.99])
    ax.set_xlim(0, scene.w_cm)
    ax.set_ylim(0, scene.h_cm)
    ax.set_aspect("equal")
    ax.axis("off")

    for poly in scene.polygons:
        xs = [p[0] for p in poly.pts]
        ys = [p[1] for p in poly.pts]
        ax.fill(xs, ys, facecolor=poly.face, edgecolor=poly.edge, linewidth=poly.lw_pt, alpha=poly.alpha)

    for line in scene.polylines:
        xs = [p[0] for p in line.pts]
        ys = [p[1] for p in line.pts]
        ax.plot(
            xs,
            ys,
            color=line.color,
            linewidth=line.lw_pt,
            linestyle=line.dash or "-",
            label=line.label,
            solid_capstyle="round",
        )
        if line.arrow_end:
            # 箭头 overlay 只画末端 0.35cm(基本就是三角头本身):线型/虚线相位由 plot
            # 的完整线段负责,避免 annotate 整段重画虚线造成相位错位、看起来像实线。
            px, py = (xs[-2], ys[-2]) if len(xs) > 1 else (xs[-1], ys[-1])
            qx, qy = xs[-1], ys[-1]
            seg = math.hypot(qx - px, qy - py)
            if seg > 0.4:
                px, py = qx - 0.35 * (qx - px) / seg, qy - 0.35 * (qy - py) / seg
            ax.annotate(
                "",
                xy=(qx, qy),
                xytext=(px, py),
                arrowprops=dict(arrowstyle="-|>", color=line.color, lw=line.lw_pt,
                                linestyle=line.dash or "-", shrinkA=0, shrinkB=0),
            )

    for t in scene.texts:
        ax.text(t.x, t.y, t.s, fontsize=t.size_pt, color=t.color, ha=t.anchor, va="center",
                fontweight="bold" if t.bold else "normal")

    if scene.title:
        ax.text(scene.w_cm / 2, scene.h_cm - 0.35, scene.title, fontsize=11, ha="center", va="top", fontweight="bold")
    if scene.legend:
        handles, labels = ax.get_legend_handles_labels()
        if handles:
            # 锚点角用数据坐标(cm):图例实际落点与 spec.legend.bbox 的声明共用同一锚
            # (scene.legend_anchor_cm),遮挡检查(legend↔title/labels/objects)与渲染一致。
            ax.legend(handles, labels, loc=scene.legend_loc, bbox_to_anchor=scene.legend_anchor_cm(),
                      bbox_transform=ax.transData, frameon=False, fontsize=8)

    fig.savefig(out_png, dpi=300)
    if also_svg:
        fig.savefig(str(pathlib.Path(out_png).with_suffix(".svg")))
    plt.close(fig)

    spec = scene.finalize_spec()
    spec_path = pathlib.Path(out_png).with_suffix(".spec.json")
    spec_path.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[mpl] {out_png}")
    if also_svg:
        print(f"[mpl] {pathlib.Path(out_png).with_suffix('.svg')}")
    print(f"[mpl] {spec_path}")
    return spec
