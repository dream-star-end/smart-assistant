---
name: scientific-figures
description: 科研图表规范与**闭环出图工作流**。出图后必须用 `oc-figcheck` 回看自纠(看到重叠/裁切/取景空/背景异常再改),直到 PASS。按图类型选对确定性工具:数据图=matplotlib+SciencePlots/seaborn;网络关系图=networkx+graphviz;复杂热图=PyComplexHeatmap;组合集合=UpSetPlot/venn;精密示意/机制图=Typst+CeTZ(矢量);简单流程=Mermaid;3D工程装置图=matplotlib-3D(信息优先)+闭环。**严禁生成式 AI 插画**。要给报告/论文/PPT 配图、画数据图/网络图/示意图/装置图时使用。
tags: [research, figures, matplotlib, scienceplots, seaborn, networkx, typst, cetz, figcheck]
priority: 5
---

# scientific-figures 科研图表规范(闭环出图)

科研产物的图**必须专业、可复现、零 AI 味**。这是用户最高 ROI 的反馈——生成式插画一眼假,而"盲画一版就交"会出现子图重叠、标签被裁、图例遮数据、取景过空、背景色翻车等**肉眼一看就知道、但你(纯文本/看不到渲染结果时)不知道**的低级错误。曾有用户为一张 3D 装置图手动来回改了 7 版还没成——根因就是没有闭环。

## 0. 铁律

- **严禁**生成式 AI 出"插画/示意图/封面图"(Midjourney/DALL·E/SD 类,或让模型吐 base64 图)。一律用下面的确定性工具。
- **出图必须闭环**:任何要给用户/报告/论文的图,`savefig` 后**必须** `oc-figcheck` 回看自纠(见 §1),不允许画完直接交。这是本 skill 的核心纪律。
- **按图类型选对工具**(见 §2),不要用 matplotlib 硬画一切(网络图、精密示意图硬画必糊)。
- 图必须有清晰坐标轴标签+单位、图例、必要标题;字号适配印刷;投稿再出矢量(§6)。

## 1. 核心工作流:出图 → figcheck → 自纠 → 直到 PASS

```
1) 选对工具(§2)画图,savefig 到 /home/agent/.openclaude/research/<id>/figN.png,dpi=300,bbox_inches='tight'
2) oc-figcheck <png> --kind <figure|schematic|network|3d|composite>
3) 读输出:deterministic.issues(确定性硬伤)+ vision.review(审稿意见)+ 末行 VERDICT
4) VERDICT!=PASS → 按问题改绘图代码重画 → 回到步骤 2;PASS → 交付
```

`oc-figcheck` 两层把关(一条命令搞定):
- **确定性**(不耗模型额度):分辨率/DPI 不足、**主背景占比过高=取景过空/物体飘散**、**背景主色异常偏色=渲染背景翻车(整张绿/黄)**、**画布边缘内容密集=元素被裁**。
- **vision 审图**(默认 MiniMax-M3,实测对版式缺陷识别准):按图类型逐条找会被审稿挑剔的问题(裁切/重叠/取景/标注缺失/字号/低级错误)。

```bash
oc-figcheck /home/agent/.openclaude/research/<id>/fig1.png --kind figure
# 复杂图表要精确读数核对时(minimax 已够;仅特殊场景)可加 --focus "核对每个数值标注是否正确"
```

**不要跳过 figcheck 直接交图。** 复杂图尤其要迭代到 PASS——这正是把"7 版手动折腾"变成"机器自纠 2-3 轮"的关键。

## 2. 图类型 → 工具选型表(选错工具=注定画不好)

| 图类型 | 用什么(确定性工具) | kind |
|---|---|---|
| 折线/柱/散点/误差棒/双轴 | matplotlib + SciencePlots(叠 `no-latex`) | figure |
| 统计分布/回归/分组对比/小提琴/分面 | seaborn 或 **plotnine**(ggplot2 语法,复杂分面更省心) | figure |
| 多面板拼图 (a)(b)(c)(d) | matplotlib `subplot_mosaic` + 面板编号 | composite |
| **网络/关系/通路/DAG** | **networkx + graphviz**(`dot`/`neato`/`sfdp` 布局),**不要**手摆节点 | network |
| **复杂热图**(带聚类树/注释条/多面板) | **PyComplexHeatmap**;简单热图 seaborn `heatmap` | figure |
| 集合/组合 | **UpSetPlot**、**matplotlib-venn** | figure |
| 树图/占比 | **squarify**(treemap) | figure |
| 大量点标签易重叠 | 叠 **adjustText** 自动排开标签 | figure |
| **精密示意/机制/几何/装置原理图** | **Typst + CeTZ**(矢量,§4) | schematic |
| 简单流程/架构/时序(方框+箭头) | Mermaid(前端渲染)或 Typst fletcher | schematic |
| **3D 工程装置/场景布置图** | matplotlib-3D,**信息优先**(§5) | 3d |
| 交互式 HTML 图 | plotly(`fig.write_html`,**不要** `write_image`——无 kaleido) | figure |

## 3. 数据图:matplotlib + SciencePlots

```python
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
import scienceplots  # noqa: F401
plt.style.use(['science', 'nature', 'no-latex'])  # 或 ['science','ieee','no-latex']
plt.rcParams['font.family'] = ['Noto Serif CJK SC', 'serif']  # 中文图注(字体已装)
fig, ax = plt.subplots(figsize=(3.5, 2.6))
ax.plot(x, y, label='method A')
ax.set_xlabel('Epoch'); ax.set_ylabel('Accuracy (%)'); ax.legend()
fig.savefig('/home/agent/.openclaude/research/<id>/fig1.png', dpi=300, bbox_inches='tight')
print('/home/agent/.openclaude/research/<id>/fig1.png')
```
- 样式列表**必须含 `'no-latex'`**——容器无 LaTeX,不带会在 savefig 时报 `latex could not be found`。公式用 mathtext(`$...$`)即可。
- 保存路径单独成行 print → 前端渲染成图片卡;该路径作为 oc-report ReportSchema 的 figure.path。

## 4. 精密示意图:Typst + CeTZ / fletcher(替代硬画框线图)

机制图/信号流/几何/装置原理/通路这类**精密示意图**,matplotlib 硬画框线会"草图感";用 **CeTZ**(Typst 绘图包,矢量、对齐严谨、可投稿)写 `.typ`,再用 `oc-diagram` 渲染。容器内 Typst=Quarto 自带,CeTZ 0.4.2 / fletcher 0.5.8 已**离线预置**(无需联网)。简单方框+箭头流程也可用 Mermaid(前端渲染)或 fletcher;**精密图一律 CeTZ**。

```typst
// signal_model.typ —— 例:发—传—收信号模型示意
#import "@preview/cetz:0.4.2"
#set page(width: auto, height: auto, margin: 8pt)  // 必加:裁紧到内容,否则默认 A4 页面留大片空白
#set text(font: "Noto Serif CJK SC", size: 10pt)
#cetz.canvas({
  import cetz.draw: *
  rect((-0.6,-0.4),(0.6,0.4), name:"tx"); content("tx", [节点 i\ 发射机])
  circle((4,-1.5), radius:0.5, fill:orange.lighten(30%), name:"tgt"); content("tgt",[目标])
  rect((7.4,-0.4),(8.6,0.4), name:"rx"); content("rx",[中心\ 处理])
  line("tx","tgt", mark:(end:">"), name:"s"); content(("s",0.5,"s"),[$s_i(t)$], anchor:"south")
  line("tgt","rx", mark:(end:">"))
})
```

```bash
oc-diagram signal_model.typ --png              # → signal_model.pdf(矢量) + signal_model.png(进报告)
oc-figcheck signal_model.png --kind schematic  # 闭环回看:标注是否齐全、对齐、无裁切
```

- CeTZ 用精确坐标 + `rect`/`circle`/`line`/`content` + 箭头 `mark:(end:">")` + 锚点对齐,天生比 matplotlib 框线整齐;中文 `#set text(font:"Noto Serif CJK SC")`(字体已装)。
- 流程/时序/DAG 也可 `@preview/fletcher:0.5.8`(node/edge 声明式)。
- `oc-diagram` 默认出矢量 PDF;`--png` 追加位图进报告;`--svg` 追加 SVG。产物路径末行 print → 前端渲染卡片。

## 5. 3D 工程装置/场景布置图(CAD 类)——信息优先 + 闭环

这类图(如"双天线基准迁移试验系统三维示意图")最容易翻车:纯 3D 渲染引擎(pyvista/vtk)出的图**好看但零标注、构图失控**(主体飘在空白里、背景翻车、看不出哪个是哪个),而论文示意图的核心是**信息传达**不是照片级真实。铁律:

- **走 matplotlib-3D**(`Axes3D`),信息完整可控:每个部件用清晰 marker + **文字标注**、给**坐标轴/比例参照**、**图例**说明各部件、用线连出观测/连接关系。
- **不要**追求照片级渲染而牺牲标注;不要让主体只占画面一角(收紧 `ax.set_xlim/ylim/zlim` 让主体充满)。
- 需要多视角就出等轴测/俯视/近景各一张,**每张都过 `oc-figcheck --kind 3d`**——取景空、物体悬空、背景异常、标注缺失都会被抓出来。
- 若确需精致渲染,走"渲染底图 + 矢量标注层叠加"分层合成,但先确保信息完整。

## 6. 配色 / 可读性 / 矢量

- 离散类别用 ColorBrewer `Set2`/`Dark2`(`plt.get_cmap('Set2')`);连续量用 `viridis`/`cividis`(色盲友好)。
- 不用红绿对比传达关键信息;线型 + 颜色双编码。
- 投稿要矢量:同名再存 `.svg`/`.pdf`(matplotlib 原生,无需 LaTeX);Typst/CeTZ 产物本就是矢量。
- 图注中文设 `font.family=['Noto Serif CJK SC','serif']`;英文 serif/sans 一致。
- **networkx 画中文节点/边标签**必须显式传 `nx.draw(..., font_family='Noto Serif CJK SC')` —— 它默认 `sans-serif` 会覆盖 rcParams,导致中文豆腐块(□□□)。graphviz 布局用 `nx.nx_pydot.graphviz_layout(G, prog='dot'|'neato'|'sfdp')`(层次图用 dot,力导向用 neato/sfdp),避免手摆节点糊成一团。

## 7. 已预装(版本固定,可复现,勿重装)

数据/科学计算:`matplotlib` `scienceplots` `numpy` `pandas` `scipy` `seaborn` `statsmodels` `sympy` `scikit-learn` `plotly`。
复杂图扩展:`networkx`+graphviz(`dot`) `plotnine` `PyComplexHeatmap` `upsetplot` `matplotlib-venn` `squarify` `adjustText` `cairosvg`。
矢量示意:Typst(Quarto 自带)+ CeTZ/fletcher(离线预置)。
(精确 pin 版本以运行时 Dockerfile 为准;新增库随镜像固定,勿在会话里 pip 重装。)
