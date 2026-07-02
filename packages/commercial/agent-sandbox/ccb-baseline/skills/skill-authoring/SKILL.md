---
name: skill-authoring
description: "写好一个 skill 的平台规范: 目录结构(references/scripts/assets/evals)、SKILL.md 写法、评测用例(evals.json)格式与评测驱动迭代方法。创建/更新/训练 skill 前先读本文。"
version: "1.0.0"
tags: [system, skill, authoring, evals]
---

# Skill 编写规范(平台权威)

skill = **目录**,不只是一个 SKILL.md。按内容性质分层存放:

```
skill-name/
├── SKILL.md      # 必需:原则 + 工作流(目录页,<500 行)
├── references/   # 稳定知识:schema、API 文档、领域规则(按需 Read,读了才占上下文)
├── scripts/      # 重复/易碎动作的确定性脚本(执行不读入,只有输出占上下文)
├── assets/       # 输出用素材:模板、样板(永不读入上下文)
└── evals/
    └── evals.json  # 验收用例(评测驱动迭代的基准)
```

## SKILL.md 写法

- frontmatter `description` 是**触发的唯一依据**:第三人称,同时写"做什么 + 何时用",含触发关键词。
- 正文 <500 行,定位是导航页:触发条件、前提、checklist 式步骤、决策分支、常见坑、验证方式。
- 细节外链到 references/(引用只允许一层深);> 100 行的 reference 文件顶部加目录。
- 指令里区分 "Run scripts/x.py"(执行)与 "See references/y.md"(阅读)。
- 自由度判据:多解任务写文字启发式(高自由度);带参数流程写伪代码(中);易碎操作写精确脚本 + `Do not modify`(低)。

## evals/evals.json 格式

```json
{
  "version": 1,
  "cases": [
    {
      "id": "translate-abstract",
      "prompt": "把这段摘要翻译成英文:……(真实措辞,含必要上下文)",
      "assertions": [
        "输出为英文且无遗漏原文信息",
        "术语 'XX' 翻译为 'YY'",
        "保留原文的数字与单位"
      ]
    }
  ]
}
```

- 2-3 个用例起步(措辞多样化 + 至少一个边界 case),每用例 3-5 条**可判定**断言;上限 5 用例。
- 断言在看到第一轮真实输出后再补齐;恒过的断言删掉(模型本来就会),恒败的断言先怀疑断言本身。
- 平台评测跑法:with/without 双跑(有/无本技能),断言通过率 delta = 技能买到了什么;
  训练草稿自动跑 draft vs 现版(评测门),更差的草稿不要合并。

## 评测驱动迭代纪律

1. 先建评测再堆文档 —— 评测是唯一事实标准。
2. 从失败**泛化**改进,不要对用例 overfit;写"为什么",不写 ALWAYS/NEVER 空话。
3. 通过率平台期先试**删**指令(精简即优化)。
4. 每轮任务里重复手写的 helper 命令/脚本 → 沉淀进 scripts/。
5. 模型升级后重跑 evals:with/without 无差异的技能考虑退役。

## 成本提醒

评测与训练跑真实模型、消耗积分:用例数即成本上限;不要为琐碎技能建大评测。
