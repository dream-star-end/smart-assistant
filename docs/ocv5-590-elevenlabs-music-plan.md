# OCV5-590 方案：ElevenLabs 音乐 provider（媒体工作台第一期）

- 总票 OCV5-586。D11 实测 MiniMax 音乐对新用户停止服务（HTTP 410 / 2153），用户 2026-10-23 01:02 批准按推荐改用 ElevenLabs（D11'，方案 B），Google Lyria 作为纯音乐备选，以后再接。
- 只改商业版。本 PR **只交付 master 侧的 provider 客户端和定价函数**，不接 HTTP、不对容器开放、不写迁移。计费由 OCV5-591 的工作台扣费链路负责（`studio_*` 表和 ledger reason）。

## 接口（官方文档 https://elevenlabs.io/docs/api-reference/music/compose）
- `POST https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128`，头 `xi-api-key`，JSON：`{ prompt, music_length_ms: 3000..600000, model_id: "music_v1", force_instrumental }`。
- 成功：响应体就是音频（mp3）。失败：422 返回 `detail[]`，401/403 是鉴权失败，429 是限流，5xx 是上游故障。

## 模块 `media-studio/providers/elevenlabsMusic.ts`
- `resolveElevenLabsKey(env, read)`：只读 `ELEVENLABS_API_KEY_FILE`（root 0600），规则同 MiniMax 的媒体 key：文件不可读或格式不合规就返回“未配置”，不回退到别的来源，日志里不出现任何内容。
- `composeMusic(deps, { prompt (1..2000), durationMs (3000..600000), instrumental, modelId = "music_v1" })` → `{ audio: Buffer, mime: "audio/mpeg", durationMs, songId | null }`。
  - 超时 300 s；响应体超过 50 MB 立即中止；要求 `content-type` 是 audio/* 或 application/octet-stream，并且 mp3 的魔数（ID3 或帧同步）校验通过。
  - 错误映射：未配置 → `MUSIC_NOT_CONFIGURED`（503）；401/403 → `MUSIC_PROVIDER_AUTH`（503，记 error 日志）；422 → `MUSIC_INVALID`（400，带上游 msg 的前 200 字）；429 → `MUSIC_RATE_LIMIT`（429）；其它 → `MUSIC_UPSTREAM`（502）。
  - 不重试（重试由编排器统一决定）。
- `musicCostCredits(durationMs, perMinute = 150)`：每开始一分钟收 150 积分（D6：150–200 积分/首，37 秒的配乐就是 150）。由 `OC_STUDIO_MUSIC_CREDITS_PER_MINUTE` 配置，取值 1..2000。

## 配置
- `ELEVENLABS_API_KEY_FILE`（绝对路径，可选）、`OC_STUDIO_MUSIC_CREDITS_PER_MINUTE`（可选）。只在 `config.ts` 里加校验，不在 `index.ts` 装配。

## 测试（全部用注入的 fetch，不访问真实上游）
- 成功返回 mp3 和时长；请求体、头、query 正确（断言 key 只出现在头里）；
- 422 / 401 / 429 / 500 的映射；非音频响应、魔数不对、超过大小都会被拒；
- key 文件的各种情况；定价的边界（3 s、60 s、61 s、600 s）。

## 上线（需要批准）
- 用户提供 key 后，放到 kl-mirror 的 `/etc/openclaude/secrets/elevenlabs.key`（0600），通过 stdin 管道传过去，不回显。
- 在 uid 247 上实测生成一首 15 秒的纯音乐，记录状态码、时长、扣费。
