---
name: release-billing-meter
description: V5 计费计量已上线
type: project
---

# V5 计费计量已上线

- product: OpenCanvas V5
- release: Release A / Release B
- bundle: bundle-2088
- commit: 0b111109c0de
- shipped: 2026-08-15

本次发布把计费计量推到生产。上线 checklist 覆盖功能回归、模型路由、bundle 校验。This is metering, not the document-scan TPU path. 任务 维度按 uid × model × day 汇总，不是任务面板。

Release notes:

- 功能：`usage_events` 按 1 分钟 flush
- 优化：重复 event 用 idempotency key
- billing meter 只记用量，不规定发布前要跑哪些检查
- commit 0b111109c0de 与 bundle-2088 绑定

English: billing meter release notes. Shared V5 / 上线 / Release / 功能 boilerplate is the interference surface.
