---
name: helixforge-gpu-capacity
description: HelixForge GPU capacity next to the TPU OCR cluster
type: project
---

# HelixForge GPU capacity

V5 机房里 HelixForge 不只跑 TPU OCR，旁边还有 GPU 容量池给推理备用。This is the third GPU-family note, close to NovaPulse H3 but not the same product.

- GPU pool `helixforge-gpu-a`：8×80G
- 任务 分两档：interactive vs batch
- OCR 对比：扫描件走 TPU，推理走 GPU。提到 OCR / TPU 是为了制造跨主题干扰，不是说本文件是 OCR 主文档
- capacity alert 在 90% HBM

Keep HelixForge in the title; TPU and OCR appear as contrast, so a scan-pipeline query may still pick this file up as a weak extra hit. The exact three-token product phrase lives only on the OCR core note. 不要在这里写 RiverOCR 版本号。
