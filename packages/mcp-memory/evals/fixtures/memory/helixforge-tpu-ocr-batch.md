---
name: helixforge-tpu-ocr-batch
description: HelixForge TPU OCR 批处理与积压
type: project
---

# HelixForge TPU 批处理 OCR

第三条近重复：HelixForge 集群上的 TPU OCR 批任务。夜间把 8000 页扫进 queue，worker 以 12 页一组喂 RiverOCR。这里写的是积压和重试，不是调参，也不是主流程三词连写。

Batch contract:

- source bucket `s3://helixforge-ocr-inbox`
- dest bucket `s3://helixforge-ocr-out`
- 失败页进 `dead-letter`，同一 TPU 卡重试不超过 3 次
- 批处理报表每天 07:00 写到 `ocr-batch-report.md`

When the inbox is deep, the batch supervisor spreads jobs across TPU 0-3. OCR throughput is about 1.6 pages/s/card. 不要把这套 inbox 接到 NovaPulse H3，H3 是推理卡不是扫描件识别卡。

和另外两条一样堆了 HelixForge / TPU / OCR / RiverOCR 词，用来惩罚 "词袋命中就整组召回" 的排序。
