# OCV5-589 方案：MiniMax 媒体 key 隔离 + 音色设计、声音克隆、音色列表 + TTS 按字符比例计费

- 总票 OCV5-586（媒体工作台第一期，商业版）。用户 2026-10-23 01:02 CST 批准：
  - D12：新订阅 key 只给媒体用，网页搜索继续用 `MINIMAX_TOKEN_PLAN_KEY`。
  - D6a：TTS 改为按字符比例计费，取整到分。
  - D6d：声音克隆 990 积分/个。
  - D7：克隆必须有授权声明，只能本人使用。
- 只改商业版 `feat/v5-aurora-rewrite`。

## 1. 现状

- `/internal/v3/minimax`（`minimax/mediaProxy.ts`）：容器的 `mmx` 走这条路，master 代持 `MINIMAX_TOKEN_PLAN_KEY`。已开放的操作是 image、speech、music、lyrics 和 video_*。
- 网页搜索 `/internal/v3/minimax-search` 也用同一个 key。媒体调用和搜索共用 Token Plan 的 5 小时额度窗口。
- TTS 计费：`calculateMiniMaxSpeechCost` 对每次调用取 `ceil(chars/10000) × 200`（turbo）或 `× 350`（hd）。生产上 266 次 speech 每次都正好扣了 200，所以一句话至少扣 200 积分（¥2）。
- 定价函数里已有 `calculateMiniMaxVoiceDesignCost`（990），但代理里没有 voice_design 和 voice_clone 的分支；表 0077 的 CHECK 约束已经允许 `voice_design` 和 `voice_clone` 两个 operation。
- **越权面**：MiniMax 的设计音色和克隆音色属于整个 key 所在的账号。目前 speech 接受任意 `voice_id`，只要有人知道别人克隆音色的 id，就能拿去合成。工作台一旦开放克隆，这个问题必须先堵上。
- D11 实测（01:1x）：新 key 调音乐返回 HTTP 410 / 2153，对新用户已经停止服务。

## 2. 改动

### 2.1 媒体 key（D12）

- 新增 `minimax/mediaKey.ts` → `resolveMiniMaxMediaKey(env, readFile)`：
  - 设置了 `MINIMAX_MEDIA_KEY_FILE` 时，读这个文件，去掉首尾空白，要求长度在 1–512 之间，并且不能含空白字符或控制字符。读取失败或格式不合规时返回 `{ key: undefined, error }`。**不会回退到** `MINIMAX_TOKEN_PLAN_KEY`，以免配置失误时悄悄去耗搜索的额度。此时媒体代理返回 503 `MINIMAX_NOT_CONFIGURED`，master 启动时记一条 error 日志（日志里不含 key 和路径内容）。
  - 没设置 `MINIMAX_MEDIA_KEY_FILE` 时，沿用 `MINIMAX_TOKEN_PLAN_KEY`，与现状完全一致。
  - 只在启动时读一次。换 key 需要重启 master，这与 env 键的生效方式一致。
- `index.ts` 装配：`makeMiniMaxMediaHandler({ tokenPlanKey: mediaKey.key })`。搜索 handler 不变，仍用 `cfg.MINIMAX_TOKEN_PLAN_KEY`。
- `config.ts` 增加 `MINIMAX_MEDIA_KEY_FILE`：可选，绝对路径。

### 2.2 master 侧媒体客户端（供工作台编排器调用，也供代理复用）

- 新增 `minimax/mediaClient.ts`，从 `mediaProxy.ts` 抽出 `postJson`、`getJson`、`hexToBase64`、`downloadFile`、`settle`、`ensureSufficientBalance`，并对外导出：
  - `synthesizeSpeech({ userId, containerId, requestId, model, text, voiceId, format, voiceSetting? })` → `{ audio: Buffer, format, usageCharacters, billing }`。`voiceSetting` 只接受 `speed` [0.5, 2]、`vol` (0, 10]、`pitch` [-12, 12]、`emotion`（白名单：happy、sad、angry、fearful、disgusted、surprised、calm、fluent、whisper）。
  - `designVoice({ userId, requestId, prompt, previewText })` → `{ voiceId, trialAudio: Buffer, billing }`。
  - `cloneVoice({ userId, requestId, sample: Buffer, sampleMime, consent, previewText? })` → `{ voiceId, demoAudioUrl?, billing }`。
  - `listSystemVoices()` → `[{ voiceId, voiceName, description[] }]`，进程内缓存 24 小时，失败时沿用上次的缓存。
- `mediaProxy.ts` 改为调用这些函数，对外行为不变。只有一处例外：speech 的音色校验，见 §2.4。
- **容器侧不新增** voice_design 和 voice_clone 操作。这两项只给 master 编排器用（工作台第一期），不扩大容器的攻击面；`RequestSchema` 也不加。

### 2.3 音色设计和声音克隆

- 音色 id 由我们生成：`oc{userId}x{12 位 base32 随机}`，例如 `oc247xk3m9…`。规则是字母开头、8–256 位、只含 `[A-Za-z0-9]`，满足 MiniMax 的格式要求。设计音色时显式传入这个 `voice_id`，使两类音色的命名一致。
- 克隆流程：
  1. 样本先在本地校验：mp3 / m4a / wav（看魔数），≤ 20 MB；时长 10 s–5 min 交给上游校验。
  2. `POST /v1/files/upload`（multipart，`purpose=voice_clone`）拿到 `file_id`。
  3. `POST /v1/voice_clone`，带 `{ file_id, voice_id, need_noise_reduction: true, need_volume_normalization: true }`。可选带 `text` 和 `model=speech-2.8-turbo` 生成试听，试听按 TTS 价另计。
  4. 上游返回 `input_sensitive === true`，或顶层 `input_sensitive_type` 不为 0 时，视为被审核拒绝：音色行记为 `failed`，不扣费（Codex plan r1 P1-1：官方响应是布尔值 `input_sensitive` 加顶层 `input_sensitive_type`）。
- **授权（D7）**：`consent` 必须是 `{ statement: 'self_or_authorized', acceptedAt: ISO }`，否则直接 400，不调上游。授权内容随音色一起落库。
- 计费：设计和克隆都按 `calculateMiniMaxVoiceDesignCost`（990，D6d），**在上游成功之后**经 `settleMiniMaxMediaSuccess` 扣费，operation 分别是 `voice_design` 和 `voice_clone`，`requestId` 保证幂等。设计时的试听按 TTS 价并入同一次结算，记在 units 里。MiniMax 那边要等音色首次用于合成才收费；我们在创建成功时就收，这是我们的定价口径，不影响和上游对账，因为我们的成本是固定订阅费。
- 7 天规则：克隆或设计出的音色如果 7 天内没有正式用于合成，会被 MiniMax 删除。所以创建成功后，编排器会紧接着用它合成第一句台词。表里记 `last_used_at`；超过 7 天没用的音色标为 `maybe_expired`，下次使用时如果上游报错，就提示“音色已过期，请重新创建”。

### 2.4 音色归属（堵越权）

- 新迁移 `0322_minimax_voices.sql`（`scripts/v5-migration-claim.sh` 申领结果。0320/0321 是只存在于个人版的社区博客迁移，商业树里没有；如果声明依赖它们，`migrate.ts` 会因为依赖既未 apply 又不在目录里而 fail-closed，所有 integ 都会挂。所以声明 `-- order-dependency: none (...)`，并在 PR 写明：博客以后同步进商业时，那两支要重编号到 0322 之后，做法同 OCV5-576 对个人版 0313–0315 的处理。只增不删）：

```sql
CREATE TABLE minimax_voices (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,          -- 调用方幂等键（编排器的 take id）
  params_sha256 TEXT NOT NULL,       -- kind + prompt/preview/样本摘要；同一 request_id 换参数 → 409
  status TEXT NOT NULL CHECK (status IN ('pending','active','failed')),
  voice_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('design','clone')),
  label TEXT NOT NULL DEFAULT '',
  prompt TEXT,                       -- 设计描述（克隆为 NULL）
  consent JSONB,                     -- 克隆授权声明（设计为 NULL）
  usage_id BIGINT REFERENCES minimax_media_usage_records(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (user_id, request_id)
);
CREATE INDEX idx_minimax_voices_user ON minimax_voices(user_id, created_at DESC);
```

- **创建幂等**（Codex plan r1 P1-2）：调上游**之前**，先以 `(user_id, request_id)` 插入一行 `pending`，同时写入生成好的 `voice_id` 和 `params_sha256`。同一 `request_id` 再次进来时：
  - `active`：直接返回原来的 `voice_id`，结算按 replay 处理，不重复扣费，也不再调上游；
  - `pending` 且 15 分钟内有更新：返回 409 `VOICE_CREATE_IN_PROGRESS`；
  - `pending` 超过 15 分钟（进程崩溃）或 `failed`：**先对账**（Codex plan r2 P1）。如果 `minimax_media_usage_records` 里已经有这个 `(user_id, request_id)` 的成功结算，说明是“结算已提交、但还没来得及置 active 就崩溃”，此时直接把原来的 `voice_id` 置为 `active`、补上 `usage_id`，按 replay 返回，不换号也不再调上游。只有确认从未结算过时，才换一个新的 `voice_id`，把行重置为 `pending` 后重试。旧 `voice_id` 在上游即使已经建成，也没人用，7 天后会被 MiniMax 自动删除，而且从未向用户收费；
  - `params_sha256` 不一致：返回 409 `REQUEST_ID_REUSED`，不调上游。
  上游成功并结算后 → `active`，写 `usage_id`；上游失败或审核拒绝 → `failed`。归属校验只认 `active` 状态的行。

  在 `retentionRegistry` 的 durable 清单登记：这是用户自有的配置，随用户删除级联清除，不做按时间的清理。
- speech 的音色校验（容器代理和 master 客户端共用）：`voice_id` 必须满足以下之一：
  - 在系统音色缓存里；
  - 是 `minimax_voices` 里属于本人、且 `deleted_at IS NULL` 的音色。
  否则返回 403 `MINIMAX_VOICE_FORBIDDEN`，不调上游。
  - 系统音色缓存拿不到时（启动后首次请求失败），只放行默认的 `male-qn-qingse` 和本人名下的音色，其余一律拒绝（fail-closed）。
  - 这对现有容器 mmx 用户的影响：历史 266 次全部用的是默认或系统音色，不受影响。

### 2.5 TTS 按比例计费（D6a）

- `calculateMiniMaxSpeechCost`：`cost = max(1, ceil(chars × unitPrice / 10000))` 分。units 改记 `{ characters, unit_price_cents_per_10k }`，snapshot 的 `unit` 改为 `char`、`quantity = chars`、`unit_price_cents` 记每 1 万字符的单价（注明是按比例计算）。
- 例子：20 个汉字 = 40 字符 → turbo 1 分，hd 2 分（以前都是 200 / 350）。
- 影响面：全站容器 mmx speech 的单价都会下降，属于用户批准的定价修正。已入账的历史记录不追溯。

### 2.6 额度窗口软上限（可选，默认关）

- `OC_MINIMAX_MEDIA_WINDOW_MAX_CALLS`（默认不设，表示不限）：最近 5 小时内全站成功的 MiniMax 媒体调用数达到上限时，新请求返回 429 `MINIMAX_QUOTA_WINDOW`，并带上 `retry_after_sec`（按窗口内最早一条记录推算）。计数直接查 `minimax_media_usage_records`（有 `idx_mmur_operation_time` 索引，并按 `created_at` 过滤）。
- 上游返回限流（1002 RPM、1039 TPM）或额度用尽时，映射成 429 `MINIMAX_UPSTREAM_RATE_LIMIT`，不扣费。

### 2.7 音乐

- 不改代码。新 key 下音乐会得到上游 410 → `MINIMAX_UPSTREAM_ERROR`（不扣费）。工作台的音乐改走 OCV5-590（ElevenLabs）。

## 3. 安全与不变量

- key 不进日志、不进响应、不进容器；`mediaKey` 的报错只说“文件不可读”或“格式不合规”，不打印路径内容。
- 克隆样本只在内存中处理，不落盘、不进日志；上游 `file_id` 记在 `upstream_file_id` 里。
- 越权：别人的设计或克隆音色 → 403；系统音色校验 fail-closed。
- 计费：所有新操作都是先拿到上游成功、再结算，requestId 幂等，余额不足时预检 402（沿用 `ensureSufficientBalance`）。
- 生效面：`minimax/*` 属于 master（不在 egress surface 清单里）；有迁移（人工 apply）；env 新增 `MINIMAX_MEDIA_KEY_FILE`（发布时同步，并把 key 文件以 root 0600 放到 kl-mirror，见 PR 正文的发布步骤；属于生产变更，需要批准）。

## 4. 测试

- 单测：
  - `mediaKey`：文件可读、空白、含换行、不可读、未设置这几种情况。
  - `calculateMiniMaxSpeechCost` 按比例计费：1 字、20 汉字、1 万字符、hd；同步更新已有用例 `minimaxMediaPricing.test.ts` 中按块计费的断言，按用例卫生规则写明依据。
  - 音色 id 生成和格式；授权声明校验；系统音色缓存的过期和失败回退。
- integ（新文件，登记到 `pr-*` 梯队）：
  - speech：系统音色放行；本人音色放行；别人的音色 403、不调上游；缓存不可用时 fail-closed。
  - voice_design / voice_clone：成功后扣 990 加试听费、写入 `minimax_voices`；`input_sensitive` 不为 0 时不扣费也不登记；同一 requestId 重放不重复扣费。
  - 窗口软上限：达到上限后返回 429。
  - 全部用注入的 fetch，不访问真实上游。
- 上线后：只在 uid 247 上用新 key 做验证——设计 1 个音色（约 990 积分）并合成 1 句，克隆不在线上测（需要真人样本和授权）；只记录状态码和扣费是否一致。
