# Plan: 图片/附件独立上传通道(根治"发图后久等 + 前端无显示")

## 根因(已代码确认)
1. **上传**:图片 base64 整团内联进 `inbound.message` WS 帧(324KB PNG → ~432KB 文本,`main.js send()` → `wsPayload.content.media[].base64`)。大帧上行延迟、无上传进度。
2. **反馈空窗**:发送→首块之间是多阶段异步(上传→落盘→agent Read→vision prefill),前端仅有静默打字点,无阶段反馈。
3. 服务端 prompt 只放**文件路径**不放 base64(server.ts:5807+),故"模型读 432KB 文本 token"不成立——纯传输/反馈问题。

## 方案(根治):大二进制从消息通道剥离成独立 HTTP 通道
对齐 v3 既有结论(附件独立通道,base64 不进 messages JSON)。

### Part A — 服务端
1. 新增 `POST /api/attachments`(自动落在 `needsAuth` 的 `/api/` 鉴权门后,server.ts:1307)。
   - **二进制 body**(非 base64):`Content-Type: application/octet-stream`,`?name=&mime=`;服务端裸读 buffer 直接 writeFile。彻底不经 base64,严格优于内联。
   - 校验:复用 `MAX_SINGLE_FILE` / `ALLOWED_MIME_PREFIXES` / `mimeToExt`(与 dispatchInbound 同源常量)。
   - 落盘:`paths.uploadsDir`,文件名沿用现规则 `${Date.now()}-${rand}-${safeBase}.${ext}`。
   - 返回:`{ ok:true, ref:<filename>, mimeType, name, sizeHint }`。`ref` = attachmentId = 保存的文件名。
2. `dispatchInbound` media 循环(server.ts:5756)新增引用分支:
   - 现状 `if (!base64 && m.url) continue`(url-only 被跳过、不进 prompt)→ **改**。
   - 改为:有 `m.url`(承载 ref)且无 base64 → `join(uploadsDir, basename(ref))` + realpath/前缀校验(防逃逸 uploadsDir)+ 存在校验 → push 进 savedMedia,与 base64 分支殊途同归走同一段 prompt 拼接。
   - **保留 base64 分支**:Telegram/微信入站仍是 base64,不可破坏。
3. 协议:复用 `MediaRef.url`(已 Optional,无需改 schema)承载 ref。

### Part B — 前端(纯前端,不新增协议帧)
1. `attachments.js`:`att.dataUrl` 仅留作本地缩略图;新增保留原始 `File` 引用供二进制上传。
2. `main.js send()`:ws.send 前先并发 `POST /api/attachments`(XHR,`upload.onprogress` 驱动缩略图进度),拿 ref;media 改为 `{ kind, url: ref, mimeType, filename }`(无 base64)。全部 ref 到手再 `ws.send`(帧极小、瞬时)。
   - `_media` 存 ref(regen 重发,文件持久于 uploads/ 可再解析)。
3. 反馈:上传期间用户气泡状态"上传中 x%"→ 发送后既有 typing 点 + agent 首个 Read 工具卡覆盖处理窗口。**不新增 outbound 状态帧**(避免 ring-buffer/replay 协议债)。

## 兼容性
- 服务端**同时**支持 base64(老路径/其它 channel)与 ref(新 web 路径)。
- 老会话 base64 `_media` regen 仍可用。text 类附件不变(仍内联 prompt 文本)。

## 不做(防范围蠕变)
- 不做分片上传(图≤5MB 单发够;大文件后续)。
- 不新增 outbound 状态帧。
- 不改"发出的图不显示缩略图"既有行为。
- uploads/ 清理策略不在本次(现状即无清理,无回归)。

## 验证(硬三件套)
- `npm run test:web`(DOM + 纯函数)、`npm run check`(lint+typecheck+test)。
- dev 实例(18790,loopback):发图 → 抓 WS 帧确认无 base64 / `/api/attachments` 命中 / agent Read 到图 / 回答正确;观察上传进度、无空窗。
- Codex 代码审 PASS。
