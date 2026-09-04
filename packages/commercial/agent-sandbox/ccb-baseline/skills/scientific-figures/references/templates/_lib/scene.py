"""Scene — scientific-figures 领域模板共享几何模型。

模板的几何函数只产出 Scene(多段线/多边形/文字,单位 cm),由 mpl_render / pptx_render
两个通用渲染器分别输出 matplotlib 图与 python-pptx 原生 shape 图。两个后端看到的是
同一份几何,保证物理结构一致;FigureSpec(objects/links/magnitudes/labels)与几何同步
生成,供 `oc-figcheck --spec` 做物理一致性门。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

PT2CM = 0.0352778  # 1 pt = 0.0352778 cm


@dataclass
class Polyline:
    pts: list[tuple[float, float]]
    color: str = "#1a1a1a"
    lw_pt: float = 1.2
    dash: str = ""  # "" / "--" / ":" / "-."
    arrow_end: bool = False
    label: str | None = None  # 非 None 时进图例


@dataclass
class Polygon:
    pts: list[tuple[float, float]]
    face: str = "#e8e8e8"
    edge: str = "#1a1a1a"
    lw_pt: float = 0.8
    alpha: float = 1.0


@dataclass
class Text:
    x: float
    y: float
    s: str
    size_pt: float = 9
    color: str = "#1a1a1a"
    anchor: str = "center"  # matplotlib ha: left/center/right
    bold: bool = False
    for_id: str | None = None  # 非 None 时把 bbox 记入 spec.labels[fid](供 figcheck 标签检查)


def text_bbox_cm(t: Text) -> tuple[float, float, float, float]:
    """估文字包围盒(cm),mpl/pptx/spec 三处共用同一估计,保证标签检查与渲染一致。

    全角字符宽 ≈ 1.0×size,半角 ≈ 0.58×size;行高 ≈ 1.3×size(保守,利于遮挡检查)。
    """
    width_pt = sum(1.0 if ord(c) > 0x2E7F else 0.58 for c in t.s) * t.size_pt
    w = width_pt * PT2CM
    h = 1.3 * t.size_pt * PT2CM
    if t.anchor == "left":
        x0 = t.x
    elif t.anchor == "right":
        x0 = t.x - w
    else:
        x0 = t.x - w / 2
    return (x0, t.y - h / 2, x0 + w, t.y + h / 2)


def bbox_intersect_frac(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """两 bbox 交叠面积 / 较小者面积(与 oc-figcheck --spec 的标签遮挡判据一致)。"""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    sa = (a[2] - a[0]) * (a[3] - a[1])
    sb = (b[2] - b[0]) * (b[3] - b[1])
    return inter / max(min(sa, sb), 1e-12)


def arc_pts(cx: float, cy: float, r: float, a0_deg: float, a1_deg: float, n: int = 24) -> list[tuple[float, float]]:
    """圆弧离散成多段线点列(两后端统一走多段线,避免弧实现不一致)。"""
    a0, a1 = math.radians(a0_deg), math.radians(a1_deg)
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def sector_pts(cx: float, cy: float, r: float, a0_deg: float, a1_deg: float, n: int = 24) -> list[tuple[float, float]]:
    """扇形(波束锥)离散成多边形点列。"""
    return [(cx, cy), *arc_pts(cx, cy, r, a0_deg, a1_deg, n)]


@dataclass
class Scene:
    w_cm: float
    h_cm: float
    title: str | None = None
    polylines: list[Polyline] = field(default_factory=list)
    polygons: list[Polygon] = field(default_factory=list)
    texts: list[Text] = field(default_factory=list)
    legend: bool = False
    legend_loc: str = "upper right"
    # spec 元信息;objects/links/magnitudes 在几何函数里填,labels 由 finalize 自动补
    spec_meta: dict = field(default_factory=lambda: {"template": "", "kind": "schematic"})
    spec: dict = field(default_factory=lambda: {"objects": [], "links": [], "magnitudes": [], "labels": []})

    def add(self, *items: object) -> None:
        for it in items:
            if isinstance(it, Polyline):
                self.polylines.append(it)
            elif isinstance(it, Polygon):
                self.polygons.append(it)
            elif isinstance(it, Text):
                self.texts.append(it)
            else:
                raise TypeError(f"scene.add: 不支持的元素 {type(it)}")

    def finalize_spec(self) -> dict:
        """把 for_id 文字的 bbox 收进 spec.labels,并补 meta 字段。"""
        spec = {
            "template": self.spec_meta.get("template", ""),
            "kind": self.spec_meta.get("kind", "schematic"),
            "units": self.spec_meta.get("units"),
            "scene": self.spec_meta.get("scene", {}),
            "objects": self.spec["objects"],
            "links": self.spec["links"],
            "magnitudes": self.spec["magnitudes"],
            "labels": list(self.spec["labels"]),
        }
        used: set[str] = set()
        for t in self.texts:
            if not t.for_id or t.for_id in used:
                continue
            used.add(t.for_id)
            x0, y0, x1, y1 = text_bbox_cm(t)
            spec["labels"].append(
                {"id": f"lbl-{t.for_id}", "for": t.for_id, "text": t.s, "bbox": [[x0, y0], [x1, y1]]}
            )
        return spec


def palette(style: str) -> dict[str, str]:
    """journal-bw / journal-color 两套配色(与 references/styles/*.mplstyle 对齐)。"""
    if style == "bw":
        return {
            "main": "#111111",
            "second": "#555555",
            "accent": "#444444",
            "fill": "#d9d9d9",
            "fill_accent": "#c4c4c4",
            "text": "#111111",
        }
    return {
        "main": "#1a1a1a",
        "second": "#5c5c5c",
        "accent": "#2b6cb0",  # Set2 深化蓝,黑白打印仍有对比
        "fill": "#e6f0fa",
        "fill_accent": "#b8d4ea",
        "text": "#1a1a1a",
    }
