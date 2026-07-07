---
name: oc-vision
description: 用 `oc-vision understand <本地图片路径> --prompt "问题"` 命令识图。当前模型若按纯文本接入、看不到图(deepseek / glm / qwen / kimi 等),或你需要看清一张已保存到容器本地的图片(上传/微信收到的图片,通常在 uploads 目录下)时使用。看到本地图片路径却"看不到内容"时,先用本命令识别,不要说"不支持图片/没有上传图片"。
tags: [vision, image, ocr, multimodal]
---

# oc-vision 识图(CLI)

给**看不到图的纯文本模型**做图片理解的兜底工具。把一张容器内本地图片交给平台的视觉后端
(默认 MiniMax-M3,平台托管凭证),返回图片描述 / 回答你的问题 / 抽取图中文字。

> 取代旧的 `understand_image` MCP 工具:同一后端,改成一次性命令行,更稳(无常驻连接可挂死)。

## 用法

```bash
# 识别一张图片并回答问题
oc-vision understand <图片本地绝对路径> --prompt "<你想问的问题>"

# 不带 --prompt:默认"清晰描述图片并含所有可见文字"
oc-vision understand <图片本地绝对路径>
```

例子:

```bash
oc-vision understand /home/agent/.openclaude/uploads/photo.png --prompt "这张图里写了什么字?"
oc-vision understand /home/agent/.openclaude/uploads/chart.jpg --prompt "总结这张图表的主要趋势"
```

输出:识图结果**纯文本**直接打到 stdout,可直接读取并据此回答用户。

## 何时用

- **当前模型看不到图**:你按纯文本接入(上传的图会被 strip),用户发来图片但你"看不到"内容 →
  对每一张本地图片路径先 `oc-vision understand`,再基于返回内容回答。**不要**声称"不支持图片"
  或"没收到图片"。
- 微信/上传收到的图片会以容器内本地路径给你(通常在 `/home/agent/.openclaude/uploads/<文件名>`),
  直接把该路径作为参数传给本命令。

## 约束

- **只支持容器内本地文件路径**(gateway 已把上传/微信图片保存在 uploads 目录下)。**不支持 URL**
  —— 出于防 SSRF,URL 输入被明确拒绝。若要识别网络图片,先让用户上传,再用其本地路径。
- 支持的格式:PNG / JPEG / GIF / WebP;单张有大小上限,超限会明确报错。
- 路径必须是**绝对路径**且位于 uploads 目录下;传其它系统路径会被拒绝。

## 工具调用纪律(重要)

- **只用本命令传参调用**;鉴权、后端、proxy、计费全由平台封装,你只需给图片路径和问题。
- **绝不**自己拼 `curl` / `wget` / 直连 HTTP 去识图,**绝不**猜测或硬编码任何 URL / 端口 / token。
- 命令失败(超时 / 上游错误 / 图片不合规)按报错如实告诉用户或重试本命令,**绝不**改用 HTTP 兜底。

## 安全

- 不打印/回显容器身份 token:不要 `echo`、`printenv`、`set -x`、读 `/proc/*/environ`。
- 不尝试发现或猜测平台视觉后端的 API key —— 它们只在 master,容器里没有也不需要。
