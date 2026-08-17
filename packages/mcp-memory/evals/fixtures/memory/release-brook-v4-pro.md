---
name: release-brook-v4-pro
description: V5 Brook-V4 Pro 已上线
type: project
---

# V5 Brook-V4 Pro 已上线

- product: OpenCanvas V5
- release: Release A / Release B
- bundle: bundle-1842
- commit: aa11bb22cc33
- shipped: 2026-08-13

本次发布把 Brook-V4 Pro 推到生产。上线 checklist 覆盖功能回归、模型路由、bundle 校验。Brook-V4 Pro 是长上下文阅读档，不是 Cedar-Q，不是 GLM-5.3。

Release notes:

- catalog id `brook-v4-pro`
- bundle 1842 带 weights 清单
- 功能：Pro 档默认 128k
- 优化：冷启动从 12s 收到 7s
- production 流量先 10% canary

English: Brook-V4 Pro release notes. The words production, pro, and bundle also appear in sibling memos, so a bag-of-words scorer can over-retrieve.
