# 领域模板索引(scientific-figures references/templates)

命中下列领域时**先套模板、改参数,不要从零手摆坐标**;模板不覆盖再走通用路径(SKILL §2)。
每个模板 = 可执行 `template.py`(matplotlib 后端,输出 `png + svg + spec.json`;期 C 起支持
`--backend pptx` 输出可编辑原生 shapes)+ `constraints.json`(物理约束清单,供人审与 figcheck 对照)。

## 模板一览

| 模板 | 适用图 | 关键参数 | 核心物理约束 |
|---|---|---|---|
| `antenna-station` | 测站布局 / 抛物面天线系统(侧视 elevation / 俯视 layout) | `--diameter-m --elevation-deg --tower-m --stations` | 支撑链落地、馈源腿≥3、开口朝向=波束方向(防"悬空/倒扣") |
| `phased-array-obs` | 相控阵/干涉观测示意(u6 十轮返工场景) | `--panels "名:x_m,boresight_deg;..." --target --half-angle-deg` | 波束锥中轴=面板指向;信号线端点必须落在锥内;基线≠信号线 |
| `radar-system` | 雷达系统链路框图 | `--chain --inject --band` | 信号流单向无环;链路两端=声明器件 |
| `optical-link` | FSOC/光链路规格图(u224) | `--range-km --wavelength-nm --tx/rx-power-dbm --divergence-mrad` | 光路连续无断口;功率/波长/单位一致 |
| `coord-error-budget` | 坐标系/误差预算条形图(u6 EOP) | `--items "名:数值:单位,..."` | 同组同量纲;条长按 log10 量级归一;每条带数值+单位 |

EOP 常见量级参考表在 `coord-error-budget/constraints.json` 的 `reference_magnitudes`(改数值须人审)。

## 用法与闭环

```bash
T=<本目录>/<模板名>
python3 $T/template.py [参数] --style bw|color --out /home/agent/.openclaude/research/<id>/fig.png
# 产物三件套: fig.png(300dpi) / fig.svg(矢量) / fig.spec.json(物理声明)
oc-figcheck /home/agent/.openclaude/research/<id>/fig.png --kind schematic --spec .../fig.spec.json
# VERDICT: PASS 才交付;FAIL 按 issues 改参数重跑(参数不成立模板会直接拒画并说明原因)
```

- 依赖(容器已预装,缺失会 fail-loud 拒画):`matplotlib`、`scienceplots`(样式)、`--backend pptx` 需 `python-pptx`。
- 模板通过 `sys.path` 引用 `../_lib` 共享渲染器(Scene/样式/pptx),**引用时保持目录结构完整**。
- 期刊双版:同一参数跑 `--style bw` 与 `--style color` 各一次,即"正文黑白+补充材料彩色"。

## FigureSpec 格式(伴生产物,oc-figcheck --spec 的输入)

模板渲染时同步输出(几何已知,非像素反推)。字段:

```jsonc
{
  "template": "phased-array-obs",     // 模板名
  "kind": "schematic",                // figure|schematic|network|3d|composite
  "units": "m",                       // 画布坐标单位(框图可为 null)
  "scene": { "grounding": "required" },  // required 时启用支撑链检查
  "objects": [                        // 声明的物理对象
    { "id": "panel-1", "type": "phased-array", "anchor": [x, y],   // 画布坐标(cm)
      "supports": "mount-1",          // 支撑对象 id 或 "ground"
      "orientation_deg": 35,          // 朝向(度)
      "beam": { "boresight_deg": 35, "half_angle_deg": 12 } }      // 波束锥几何(有则启用锥覆盖检查)
  ],
  "links": [                          // 连线/信号流:端点必须是已声明 objects[].id
    { "id": "l1", "from": "panel-1", "to": "target", "kind": "signal",
      "must_be_in_beam_of": "panel-1" }   // to 端必须落在该对象波束锥内
  ],
  "magnitudes": [                     // 图上数值量:单位一致性/量级归一检查
    { "id": "eop-x", "label": "PM-X", "value": 0.48, "unit": "mas",
      "group": "mas",                  // 同组必须同单位;跨度>10² 时条长须按 log10 归一
      "rendered_length": 3.2 }         // 画成条形时提供(纯文本标注可不提供)
  ],
  "labels": [                         // 标签包围盒(渲染器自动估填);用于遮挡检查
    { "id": "lbl-panel-1", "for": "panel-1", "text": "P1 35°",
      "bbox": [[x0, y0], [x1, y1]] }
  ]
}
```

`oc-figcheck --spec` 确定性规则:支撑链接地(悬空 FAIL)/ 连线端点命中声明对象(未声明 FAIL)/
`must_be_in_beam_of` 锥覆盖(锥外 FAIL)/ 同组单位混量纲(FAIL)/ 跨度>10² 条长不按 log10(FAIL)/
标签 bbox 相交>20%(FAIL)/ 对象缺标签(FAIL)。详见 `oc-figcheck --help` 与 gateway `figSpec.ts`。
