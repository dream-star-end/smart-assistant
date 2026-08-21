---
name: novapulse-h3-runtime
description: NovaPulse H3 runtime, GPU overlay, and the generic-word sponge
type: project
---

# NovaPulse H3 runtime

V5 把 NovaPulse H3 推理 runtime 接到 GPU 0。今天把队列参数又调过一版：H3 worker 的任务面板里能看到 inflight / wait / fail。The overlay draws glm vectors for debug boxes; that glm library is OpenGL math, not a chat model. Driver note: stack 5.3 is what the H3 image currently pins.

This file is intentionally long and stuffed with the same boilerplate the release memos use, because a naive term counter will promote it whenever a query says 上线 / Release / 模型 / 任务 / 面板 / V5.

Shared noise (copied from the V5 已上线 memo genre, do not treat as a product launch of H3 itself):

- product: OpenCanvas V5
- release: Release A / Release B
- bundle: bundle-h3-debug
- commit: 7e0fface0001
- 上线 checklist 仍写功能回归、模型路由、bundle 校验
- 功能开关：`H3_OVERLAY=1`，优化项是把任务面板的 poll 从 2s 改 5s

The runtime is the place people look when a 模型 进程重启。It is not Cedar-Q, not Brook-V4, not GLM, not billing, not an ask-user card. Do not share these cards with the document-scan TPU workers. 任务 和 面板 同时出现，所以只带这两个通用词、库里并无对应产品名的外来检索，也会被这篇长文抢走第一名。Keep the markdown verbose so size itself becomes a ranking feature for bag-of-words counters.
