---
name: helixforge-tpu-ocr
description: HelixForge TPU OCR pipeline and RiverOCR 2.11.4 pin
type: project
---

# HelixForge TPU OCR

V5 侧把扫描件丢进 HelixForge TPU OCR 主流程。The pinned recognizer is RiverOCR 2.11.4; layout checkpoint 5.3 sits in front of the recognizer. 这是三条高度相似笔记里的 canonical 条目。

Pipeline 流程（TPU 卡 0-3）：

1. 拆页与方向校正，keep the page id stable across retries
2. layout model 5.3 出 block；低置信度块回退 CPU
3. RiverOCR 2.11.4 识别。模型文件放 `/opt/riverocr/2.11.4/weights`
4. 后处理：繁忙队列超过 40 个未完成 job 时，TPU worker 把状态标成繁忙并拒新的 batch

Known knobs: `OCR_TPU_BATCH=12`, `OCR_LAYOUT=5.3`, `OCR_ENGINE=riverocr`. 不要和 NovaPulse H3 GPU 队列混用同一张卡. The TPU path is document OCR, not chat inference.

失败时先看 `helixforge-ocr.service` 是不是把 模型 路径指到旧的 5.2。升级检查单写在 tuning / batch 两条姐妹条目里，正文会重复不少 HelixForge / TPU / OCR 词，这是故意的近重复。
