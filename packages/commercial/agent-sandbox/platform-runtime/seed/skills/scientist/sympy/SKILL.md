---
name: sympy
description: "Exact symbolic math in Python with SymPy: algebra, calculus, equation solving, symbolic linear algebra, mechanics, simplification, and code generation."
version: 1.0.0
tags: [science, symbolic-math, algebra, calculus, python]
license: SymPy license
source: K-Dense-AI/scientific-agent-skills adapted static subset
source_commit: dab7aa672944a77f20cda3f2a672a6f1582adab6
---

# SymPy symbolic mathematics

## OpenClaude 商业版安全边界

本 skill 是 OpenClaude 从 K-Dense Scientific Agent Skills 精选并改写成**单文件、无脚本、无密钥要求**的静态指南。使用时必须遵守:

- 只在用户明确做科研、数据分析、建模、绘图或相关代码任务时调用;不要因为关键词偶然出现就接管普通对话。
- 不读取、打印、转发 `ANTHROPIC_AUTH_TOKEN`、`OPENCLAUDE_*`、API key、cookie、SSH key 或任何环境密钥。
- 默认在用户工作区本地处理数据;把私有数据上传到外部 API、云平台或公共数据库前,必须先说明目的并征得用户同意。
- 生物医学/临床相关输出只作为研究和教育辅助,不能当作诊断、治疗或合规结论。
- 需要安装依赖时,先检查环境;只安装当前任务必要包,避免全局污染和大规模无关下载。

## 什么时候用

- 用户需要精确代数、微积分、方程求解、矩阵符号运算、级数、符号推导或生成可执行公式代码。
- 浮点数值计算会丢精度,或需要展示推导过程而不仅是数值答案。
- 需要把论文公式、模型方程或物理推导转成可验证 Python 代码。

## 推荐流程

1. 用 symbols() 明确变量和假设(positive, real, integer 等),减少歧义。
2. 先保留 exact rational/symbolic 表达式,最后才 evalf() 转数值。
3. 对方程求解同时检查解析解和数值解;验证代回原方程。
4. 复杂表达式使用 simplify/factor/expand/collect 要有目标,不要盲目 simplify。
5. 需要高性能时用 lambdify 或 codegen,并用数值点测试等价性。

## 防错要点

- 符号假设影响积分、求解和化简结果;结果异常时先检查 assumptions。
- 多值函数、分段函数、复数域和奇点要明确说明。
- 不要把符号结果当成实验结论;它只是数学推导或模型辅助。

## 来源与许可

- Adapted from https://github.com/K-Dense-AI/scientific-agent-skills at commit `dab7aa672944a77f20cda3f2a672a6f1582adab6`.
- Upstream repository is MIT-licensed; this commercial runtime ships a rewritten static guidance subset only, with no upstream scripts/assets/env hooks.
- Package/library license noted in frontmatter: SymPy license.
