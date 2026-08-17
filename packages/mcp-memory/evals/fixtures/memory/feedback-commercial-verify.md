---
name: feedback-commercial-verify
description: V5 商业版按风险分级验证
type: feedback
---

# V5 商业版验证流程

用户反馈：V5 商业版必须按风险分级验证，不要拿个人版 checklist 直接当商业版门。The point of this note is verifying commercial releases by risk tiers.

分级：

- T0 配置 / catalog：改 key、文案、开关。验证 = 单测 + 配置 diff
- T1 单包代码：验证 = 该包测试，不跑全量发布列车
- T2 跨包 / 协议 / 迁移：验证 = 迁移双锁 + 受控发布

管理 口径：Opus 可以审验证计划，执行 仍按 user.md 交给 Grok 跑命令。This feedback is the only file that contains 商业 and 验证 together with 流程.

English keywords planted for fuzzy queries: commercial, edition, verification, workflow, risk, tiers, verify. 不要把 Release A / 记忆 / HelixForge 写进来。V5 必须留下：宽查询一旦只靠这个产品号，就会把几乎全库召回来。
