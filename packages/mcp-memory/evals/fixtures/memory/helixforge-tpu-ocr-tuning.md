---
name: helixforge-tpu-ocr-tuning
description: HelixForge TPU 上 OCR 的调参笔记
type: project
---

# HelixForge TPU 上的 OCR 调参

和主流程笔记几乎同主题：还是 HelixForge，还是 TPU，还是 OCR，但这里只记阈值。RiverOCR 2.11.4 的 `beam=4` 比 `beam=8` 更稳，调参笔记里不要再写 exact 三词连写，避免和 canonical 条抢 exact-phrase 分。

- 低对比扫描件：binarize window 31, 不要开 V5 文档路由（这条故意不写产品号以免污染专名检索）
- 表格：layout 先切 cell 再认，TPU 显存峰值约 6.8G
- 手写：HelixForge 的 TPU kernel 对连笔差，必要时降到 CPU OCR
- 调参笔记要记录每次 beam / nms 的前后 diff，方便回滚

English note: tuning is iterative. Change one knob, rerun the 40-page fixture, keep the markdown table in this file. 与 batch 笔记共享大量 HelixForge TPU OCR 词汇，排序必须能分清 "调参" 和 "主流程"。
