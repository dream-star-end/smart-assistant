---
name: research-writing-style
description: 个性化写作风格库:收集并持久化用户偏好的写作样本/术语/结构,写报告/综述/段落时 few-shot 对齐用户风格(在去 AI 味基础上更像"这个用户/这个课题组"写的)。用户说"按我的风格写""学我之前的写法""统一术语"时使用。
tags: [research, writing, personalization, style]
---

# research-writing-style 个性化写作风格库

在 scientific-writing(规范 + 去 AI 味)之上,再对齐**这个用户/课题组**的个人风格 —— 用户最在意"不像 AI 写的、像我写的"。靠持久化的少量真人样本做 few-shot,不靠玄学。

## 风格库位置(per-user 持久,跨会话保留)

样本存容器内用户目录(per-user volume,跨会话保留):

```
/home/agent/.openclaude/research/style/
  ├─ samples/        # 用户提供的真人写作样本(.md/.txt,2~5 篇即可)
  └─ profile.md      # 提炼的风格画像(术语表 + 句式偏好 + 结构偏好 + 禁忌)
```

## 流程

1. **采样**:首次按风格写作前,请用户提供 2~5 段他/课题组**真实写过**的代表性文字(论文段落、报告、综述),存入 `samples/`。没有就先用 scientific-writing 通用规范,别编"个人风格"。
2. **提炼 profile**(只做一次 / 用户要求更新时):读 samples,提炼成 `profile.md`:
   - 术语表(用户惯用译名/缩写,如把 "embedding" 统一写"嵌入"还是"向量表示")
   - 句式偏好(长短句、主动/被动、是否用第一人称"我们")
   - 结构偏好(段落组织、是否爱用小标题/编号)
   - 禁忌(用户明确不喜欢的措辞)
3. **few-shot 写作**:写作时把 `profile.md` + 1~2 段最贴的 sample 作为 few-shot 注入,产出对齐风格的文本;再过 scientific-writing 去 AI 味。
4. **更新**:用户给反馈("这里不像我")→ 更新 profile.md,下次生效。

## 规则

- 风格只影响**措辞/结构**,**不影响事实与引用接地**(claim 仍须 quote 支撑 + oc-cite 校验)。
- 没有真实样本就别假装有个人风格;诚实回退通用规范。
- 样本是用户隐私文本,不外泄、不上传外部服务。
- 个人风格 vs 去 AI 味冲突时,以"自然、不浮夸"为先(去 AI 味是底线)。
