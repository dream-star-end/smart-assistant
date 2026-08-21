---
name: release-cedar-q-router
description: V5 Cedar-Q router 已上线
type: project
---

# V5 Cedar-Q 路由已上线

- product: OpenCanvas V5
- release: Release A / Release B
- bundle: bundle-1103
- commit: c0ffee12a4b8
- shipped: 2026-08-12

本次发布把 Cedar-Q router 推到生产。上线 checklist 覆盖功能回归、模型路由、bundle 校验。Cedar-Q 只负责把长上下文请求切到 Q 系 endpoint，不碰 GLM，不碰 Brook-V4 Pro。

Release notes:

- `CEDAR_Q_ROUTER=1` default on
- fallback still hits the previous router when Cedar-Q returns 529
- 功能 开关写在 `router-flags.json`
- 优化：把 router 的 timeout 从 8s 收到 5s

English: Cedar-Q router is the subject of this memo. The same V5 / 已上线 / Release A / Release B / commit / bundle 功能 模板也会被只含产品号的宽查询误伤。The body is padded on purpose.
