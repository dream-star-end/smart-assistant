# 通用图形原型索引(scientific-figures references/templates)

三套**学科无关**的参数化图形原型:命中时**先套模板、改参数,不要从零手摆坐标**;
不覆盖再走通用路径(SKILL §2)。每个原型 = 可执行 `template.py`(输出 `png + svg +
spec.json`;`--backend pptx` 输出可编辑原生 shapes),物理关系由构造保证、由
`oc-figcheck --spec` 确定性复核。

## 原型一览

| 原型 | 适用图 | 关键参数 | 核心约束 |
|---|---|---|---|
| `block-diagram` | 有向阶段链框图(流程/信号链/数据流水线/反应路径/处理链) | `--chain "源,阶段A,阶段B,汇" --branch "源:目标"(可重复) --note` | 链路单向无环(支路源必须在目标上游,否则拒画);连线两端=声明阶段 |
| `magnitude-compare` | 量级对比条形图(误差源/贡献项/预算/灵敏度/能耗) | `--items "名:数值:单位,..."` | 数值必须为正(条长取 log10);同单位自动同组分面板;每条带数值+单位 |
| `coverage-geometry` | 覆盖几何(传感器阵列/光源/声源/相机 FOV/任何指向单元共同覆盖目标) | `--emitters "名:x,boresight_deg;..." --target "名:x,y" --half-angle-deg [--no-baselines]` | 单元支撑链落地;目标必须在每个覆盖锥内(否则拒画);基线与覆盖连线不同线型进图例 |

三个原型共享 `_lib/`(Scene 几何模型 + mpl/pptx 双后端 + spec 伴生),**引用时保持目录结构完整**。

## 用法与闭环

```bash
T=<本目录>/<原型名>
python3 $T/template.py [参数] --style bw|color --out /home/agent/.openclaude/research/<id>/fig.png
# 产物三件套: fig.png(300dpi) / fig.svg(矢量) / fig.spec.json(物理声明)
oc-figcheck /home/agent/.openclaude/research/<id>/fig.png --kind schematic --spec .../fig.spec.json
# VERDICT 的确定性 issues 为 0 才算过(自绘代码 3 轮未归零按 SKILL §1 如实交付);参数不成立模板会直接拒画(exit≠0)并说明原因
```

- 依赖(容器已预装,缺失会 fail-loud 拒画):`matplotlib`、`scienceplots`(样式)、`--backend pptx` 需 `python-pptx`。
- 期刊双版:同一参数跑 `--style bw` 与 `--style color` 各一次,即"正文黑白+补充材料彩色"。

## FigureSpec 格式(伴生产物,oc-figcheck --spec 的输入)

模板渲染时同步输出(几何已知,非像素反推);**任何自定义绘图代码也可按此格式手写声明**,
规则按 spec 数据特征触发,与学科和模板名无关。字段:

```jsonc
{
  "template": "coverage-geometry",   // 来源模板名(仅溯源;校验不依赖它)
  "kind": "schematic",                // figure|schematic|network|3d|composite
  "units": "m",                       // 画布坐标单位(框图可为 null)
  "scene": { "grounding": "required" },  // required 时启用支撑链检查
  "objects": [                        // 声明的对象
    { "id": "S1", "type": "sensor", "anchor": [x, y],     // 画布坐标(cm)
      "supports": "mount-S1",         // 支撑对象 id 或 "ground"
      "orientation_deg": 35,          // 朝向(度)
      "beam": { "boresight_deg": 35, "half_angle_deg": 12 },  // 覆盖锥几何(有则启用锥覆盖检查)
      "grounded": false }             // 可选:false = 该对象豁免落地检查(任何自定义 type 都能用)
  ],
  "links": [                          // 连线/流向:端点必须是已声明 objects[].id
    { "id": "l1", "from": "S1", "to": "T1", "kind": "coverage",
      "must_be_in_beam_of": "S1" }    // to 端必须落在该对象覆盖锥内
  ],
  "magnitudes": [                     // 图上数值量:单位一致性/量级归一检查
    { "id": "item-a", "label": "项A", "value": 0.5, "unit": "mV",
      "group": "mV",                  // 同组必须同单位;跨度>10² 时条长须按 log10 归一
      "rendered_length": 3.2 }        // 画成条形时提供(纯文本标注可不提供)
  ],
  "labels": [                         // 标签包围盒(渲染器自动估填);用于遮挡检查
    { "id": "lbl-S1", "for": "S1", "text": "S1 35°",
      "bbox": [[x0, y0], [x1, y1]] }
  ]
}
```

`oc-figcheck --spec` 确定性规则:支撑链接地(悬空 FAIL;`grounded:false` 或自由漂浮
type 豁免)/ 连线端点命中声明对象(未声明 FAIL)/ `must_be_in_beam_of` 锥覆盖(锥外
FAIL)/ 同组单位混量纲(FAIL)/ 跨度>10² 条长不按 log10(FAIL)/ 标签 bbox 相交>20%
(FAIL)/ 对象缺标签(FAIL)。详见 `oc-figcheck --help` 与 gateway `figSpec.ts`。
