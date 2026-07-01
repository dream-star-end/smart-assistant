---
name: office-spreadsheet
description: 生成与处理 Excel(.xlsx):把结构化数据做成规范表格、写公式、做数据清洗/透视/统计分析、出图表。用户要"做个 Excel/表格""整理成表""算一下这批数据""数据透视""导出 xlsx"时调用。
tags: [office, excel, xlsx, data, spreadsheet]
---

# Excel / 表格与数据处理

给用户产出**真·可编辑的 .xlsx**(不是 CSV 改扩展名、不是 HTML 表格)。容器内已预装:`openpyxl`、`XlsxWriter`、`pandas`、`duckdb`,以及确定性 CLI `oc-xlsx`。

## 何时用 CLI,何时直接写 Python

- **最高频"数据 → 规范 Excel"一击** → 用 `oc-xlsx`(自动表头加粗+底纹、冻结首行、自动列宽、数字右对齐、中文字体)。
- **需要公式 / 多 sheet 关联 / 数据透视 / 图表 / 条件格式 / 大数据分析** → 直接写 Python 用 `openpyxl` / `pandas` / `duckdb`(见下)。

## 1. oc-xlsx:结构化数据 → 规范 Excel

```bash
# CSV → 规范 xlsx
oc-xlsx from-csv data.csv -o /home/agent/.openclaude/结果.xlsx

# JSON 对象数组 → xlsx(列取并集,缺失留空)
oc-xlsx from-json records.json -o out.xlsx

# markdown 表格 → xlsx(文中多张表 → 多个 sheet,sheet 名取表格前最近的标题)
oc-xlsx from-md report.md -o tables.xlsx
```

先把要落表的数据写成 CSV/JSON/markdown 表,再一条命令成表,省 token 又稳定。

## 2. 公式 / 透视 / 图表:openpyxl 直接写

写**真公式**(用户改数据后自动重算),不要把算好的常数塞进去。示例:

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
wb = Workbook(); ws = wb.active
ws.append(["月份", "收入", "成本", "利润"])
data = [["1月", 120, 80], ["2月", 150, 90], ["3月", 200, 110]]
for i, (m, rev, cost) in enumerate(data, start=2):
    ws.append([m, rev, cost])
    ws[f"D{i}"] = f"=B{i}-C{i}"          # 利润=收入-成本(真公式)
ws["A5"] = "合计"; ws["B5"] = "=SUM(B2:B4)"; ws["D5"] = "=SUM(D2:D4)"
chart = BarChart(); chart.title = "月度利润"
chart.add_data(Reference(ws, min_col=4, min_row=1, max_row=4), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=4))
ws.add_chart(chart, "F2")
wb.save("/home/agent/.openclaude/财务.xlsx")
```

数据透视用 `pandas.pivot_table` 算好后写入一个 sheet,或用 openpyxl 的公式;大表统计用 `duckdb` 写 SQL(比手搓 DataFrame 更省 token、更快):

```python
import duckdb
df = duckdb.sql("""
  SELECT 部门, ROUND(SUM(金额),2) AS 合计, COUNT(*) AS 笔数
  FROM read_csv_auto('明细.csv') GROUP BY 部门 ORDER BY 合计 DESC
""").df()
df.to_excel("/home/agent/.openclaude/汇总.xlsx", index=False)   # pandas 走 openpyxl 引擎
```

## 3. 读取用户上传的表格

用户上传的 .xlsx/.csv 用 `pandas.read_excel` / `read_csv` 读;若是扫描/复杂版式,用 `oc-web parse <文件>`(markitdown,已支持 xlsx/docx/pptx)转成 Markdown 再理解。

## 4. 中文正确性(必守)

- 落表文本保持 UTF-8;CSV 读取用 `encoding="utf-8-sig"` 兼容带 BOM 的国产导出。
- 金额/数量等应是**数字类型**(参与公式/图表),不要写成带引号的文本。
- 表头简明、列宽足够放中文(oc-xlsx 已按中文 2 倍宽估算列宽)。

## 5. 交付前验证

```bash
test -s out.xlsx && unzip -tq out.xlsx      # xlsx 本质是 zip,结构完好即合法
```

最终回复给**绝对路径**(如 `/home/agent/.openclaude/结果.xlsx`)并一句话说明表里有什么、哪些是公式。

## 工具调用纪律(重要)

- 生成 Excel **优先 `oc-xlsx` 或 openpyxl/pandas/duckdb**,不要输出"假表格"(纯文本对齐/HTML 表)冒充 xlsx。
- 写公式就写**真公式**让 Excel 重算,不要预先算成常数。
- 合规:**绝不装或用 PyMuPDF(AGPL)、Marker(GPL)** 等传染性许可库处理数据;本 skill 依赖全部宽松许可。
