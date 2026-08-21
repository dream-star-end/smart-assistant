---
name: release-client-error
description: V5 Client Error 分类已上线
type: project
---

# V5 Client Error 分类已上线

- product: OpenCanvas V5
- release: Release A / Release B
- bundle: bundle-1420
- commit: bada5510c0de
- shipped: 2026-08-12

本次发布把 Client Error 分类推到生产。上线 checklist 覆盖功能回归、模型路由、bundle 校验。错误码现在按 `user` / `provider` / `platform` 三桶展示，不再把 529 和 4xx 混成一块红字。

Release notes:

- 功能：前端黄卡读 `error_class`
- 优化：同一 turn 只提示一次
- commit bada5510c0de 必须和 bundle-1420 一起滚
- 这不是扫描件识别，也不是计费

English: client error classification release notes. The template words V5 / 上线 / Release / bundle / commit / 功能 are shared with every sibling memo so wide queries over-retrieve.
