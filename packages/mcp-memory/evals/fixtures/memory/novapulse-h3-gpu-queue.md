---
name: novapulse-h3-gpu-queue
description: NovaPulse H3 GPU queue and busy-state
type: project
---

# NovaPulse H3 GPU queue

V5 上 NovaPulse H3 的 GPU queue 和 runtime 笔记同主题。这里只记排队：H3 的 queue depth、抢占和繁忙标记。

- `H3_GPU_QUEUE=64`
- 模型 进程按 FIFO 取 job，超 80% 标繁忙
- 队列 名称 `novapulse-h3-infer`
- 不要把 HelixForge 扫描件页塞进这条 GPU queue

English: the queue is for chat/inference tokens, not document OCR. When the queue is 繁忙, callers should retry with jitter. 任务 重试次数写在 runtime 的任务面板，本文件只保留 queue 口径。

This sibling repeats NovaPulse / H3 / GPU / queue so the family stays together without drowning the rest of the library.
