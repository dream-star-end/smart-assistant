# OCV5-591 A2-0 方案：媒体 provider 统一接口与注册表（商业版）

- 总票 OCV5-586，后端核心方案见 `docs/ocv5-591-media-studio-backend-plan.md`（本文是其中 A2「provider 适配器」的第一步，单独成 PR）。
- 用户 2026-10-23 09:44 决定：
  1. 图像、视频、配音、音乐走**统一的 provider 接口和注册表**，供应商和模型可配置、可新增；
  2. **缺 key 时功能显示「未配置」，不报错**；
  3. 音乐**只预留功能和接口，不绑定 ElevenLabs**，等用户加 key、选供应商；
  4. 设计音色、克隆音色暂不做真实调用。
- 叠在 A1（#1005，0324 数据层）和 A0（#1003，GPT Image / Grok runner）之上。**没有迁移，没有新表**；`OC_STUDIO_ENABLED` 默认关，合入后对现网零行为变化。

## 1. 目标与非目标
**目标**
- 编排器（A2-1）只依赖一个接口：`registry.candidates(kind, op)` → 按优先级排好、当前可用的适配器列表；逐个尝试，失败按 `retryable` 决定重试或换下一个。
- 新增一个供应商 = 写一个适配器文件 + 在适配器目录登记一行 + 配置里加一条，**不改编排器、不改前端**。
- 前端用 `GET /api/studio/providers` 得到每类能力的状态和可选模型，没有可用 provider 的能力显示「未配置」。

**非目标（不在本 PR）**
- 编排状态机、LLM 步骤（A2-1）；前端（OCV5-593）。
- MiniMax 图片/视频、Grok 生图的 master 侧 runner（它们目前只有容器 HTTP 入口）：本 PR 只给出适配器槽位的约定，等抽出 runner 后各自补一个适配器。
- ElevenLabs 适配器：不登记、不打包（#1002 的客户端代码保留在其分支，日后若用户选它，再改写成一个适配器）。
- 设计音色、克隆音色：适配器声明 `voice.design` / `voice.clone` 能力位，但本 PR 不新增任何真实调用路径，测试全部用注入的 fetch。

## 2. 接口（`media-studio/providers/types.ts`）

```ts
export type MediaKind = 'image' | 'video' | 'voice' | 'music'
export type MediaOp =
  | 'image.generate' | 'image.edit'
  | 'video.from_image' | 'video.from_text' | 'video.extend'
  | 'voice.tts' | 'voice.design' | 'voice.clone'
  | 'music.generate'

export type ProviderState = 'ready' | 'unconfigured' | 'disabled' | 'offline'
export type ProviderReason =
  | 'MISSING_KEY' | 'KEY_UNREADABLE' | 'DISABLED_BY_CONFIG' | 'FEATURE_OFF'
  | 'BRIDGE_OFFLINE' | 'NOT_ALLOWED_FOR_USER'

export interface ModelInfo { id: string; label: string; ops: MediaOp[]; isDefault?: boolean }

export interface ProviderStatus { state: ProviderState; reason?: ProviderReason }

export interface MediaRequest {            // 各 op 的入参是判别联合，zod 校验
  op: MediaOp
  model?: string                           // 不给就用该适配器的默认型号
  prompt?: string
  text?: string                            // voice.tts
  voiceId?: string
  durationSec?: number                     // video / music
  aspect?: '16:9' | '9:16' | '1:1'
  inputs?: { role: 'reference' | 'first_frame' | 'last_frame' | 'source'; blobSha: string }[]
  options?: Record<string, unknown>        // 适配器自己声明 schema 的扩展项，未声明的键一律拒绝
}

export interface MediaRunContext {
  userId: bigint
  execRequestId: string                    // studio:<task id>，重领不变（A1 方案 §3）
  maxCostCredits: bigint                   // 本任务已原子预留的积分（A1 §4），适配器据此标记 overReservation
  signal: AbortSignal
  readInput(sha: string): Promise<Buffer>  // 只能读本人有引用的 blob（StudioBlobStore.open）
}

export interface MediaOutput { bytes: Buffer; mime: string; durationMs?: number; width?: number; height?: number }

export interface MediaResult {
  outputs: MediaOutput[]
  model: string
  costCredits: bigint                      // 这次执行实际向用户扣掉的积分（重放为 0 但带 charged=false）
  charged: boolean
  providerRef: { table: string; id: string } | null   // 指向 provider 自己的账本行，供预算对账
  meta?: Record<string, unknown>
}

export class MediaProviderError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) { super(message) }
}

export interface MediaProvider {
  readonly id: string                      // 配置里的实例 id，例如 'gpt-image'、'muse'
  readonly adapter: string                 // 适配器类型，例如 'gpt-image'、'muse'、'minimax-speech'
  readonly kind: MediaKind
  readonly label: string
  models(): ModelInfo[]
  status(user?: { id: string; role?: string }): ProviderStatus   // 必须同步、无 IO（读缓存的 key 状态）
  estimateMaxCost(req: MediaRequest): bigint                      // 预算原子预留用的上限
  affinity?(): string | null                                      // 'muse' 等（A1 队列的亲和过滤）
  run(ctx: MediaRunContext, req: MediaRequest): Promise<MediaResult>
}
```

- `status()` 不做 IO：key 在注册表构建时解析一次（文件或环境变量），结果缓存为「有 / 没有 / 读不了」，**key 本身只保存在适配器闭包里，从不进入 status、日志或 API**。key 文件变更需要重启生效（与现有 `MINIMAX_MEDIA_KEY_FILE` 一致）。
- `run()` 内部仍调用各 provider 现有的计费原语，计费口径不变；注册表本身不扣费。

## 3. 注册表（`media-studio/providers/registry.ts`）

```ts
export interface AdapterFactory {
  adapter: string
  kind: MediaKind
  optionsSchema: z.ZodType               // 该适配器在配置里允许的字段（keyFile、keyEnv、baseUrl、models…）
  create(entry: ProviderEntry, deps: AdapterDeps): MediaProvider
}
export function createProviderRegistry(input: {
  entries: ProviderEntry[]               // 由配置解析而来（§4）
  factories: AdapterFactory[]            // 内置适配器目录（§5）
  deps: AdapterDeps
  warn: (msg: string) => void
}): ProviderRegistry

interface ProviderRegistry {
  list(): MediaProvider[]
  get(id: string): MediaProvider | undefined
  candidates(kind: MediaKind, op: MediaOp, user: { id: string; role?: string },
             opts?: { prefer?: string; exclude?: string[]; includeOffline?: boolean }): MediaProvider[]
             // 默认只返回 ready；includeOffline=true 时再追加 offline 的（plan r1 P1-2），见下
  describe(user): ProvidersView        // 给 HTTP 用的脱敏视图（§6）
}
```

- 构建时**永不抛错**：未知适配器类型、字段不合法、重复 id、key 读不了，都只 `warn` 一行（不含 key 内容）并把该条目标为 `disabled` / `unconfigured`；工作台其余能力照常可用。
- `candidates()` 的顺序：`prefer` 指定的实例排第一，其余按 `priority` 升序，再按 id 字典序，结果稳定可测。
- **可立即执行 vs 可排队（plan r1 P1-2）**：`offline` 只表示“本进程此刻不能执行”（例如本 slot 的 Muse bridge 不在线，另一个 slot 可能在线）。编排器派发任务时调用 `candidates(..., {includeOffline: true})`：先列全部 `ready`，再列 `offline`（各自按上面的顺序）。选中 `offline` 实例时照常入队，任务带上 `affinity()`（`muse`），由 A1 的亲和认领（只有 bridge 在线的 slot 认领）和 `affinity_deadline` 故障转移收敛；`unconfigured` / `disabled` 永远不会成为候选。默认调用（不带 `includeOffline`）只给“现在就能跑”的实例，供同步场景使用。
- 四类能力都会出现在视图里，即使一个实例都没有（音乐默认就是这种情况）：该类状态为 `unconfigured`、reason `NO_PROVIDER`。

## 4. 配置
- 新增 `OC_STUDIO_PROVIDERS`（可选，JSON 数组，长度 ≤ 32）。**`config.ts` 里只声明为不带任何约束的可选字符串（plan r1 P1-3）**：现有 `loadConfig()` 对 schema 失败直接抛 `ConfigError` 并阻断商业模块启动，所以 JSON 解析、数组/长度检查、每项字段校验全部放在注册表的 `parseProviderConfig()` 里做，失败只 warn 并降级（整串不是合法 JSON 数组 → 没有任何实例；单项不合法 → 只停用该项）。`OC_STUDIO_ENABLED` 关闭时注册表根本不构建，这个变量写成什么都不影响启动。每项的具体字段由对应适配器的 `optionsSchema` 校验：

```json
[
  {"id": "gpt-image", "adapter": "gpt-image", "priority": 10, "models": ["gpt-image-2"]},
  {"id": "muse", "adapter": "muse", "priority": 20},
  {"id": "minimax-speech", "adapter": "minimax-speech", "defaultModel": "speech-2.8-turbo"},
  {"id": "music-x", "adapter": "<将来的音乐适配器>", "keyFile": "/etc/openclaude/secrets/music-x.key", "enabled": false}
]
```

- 公共字段：`id`（`^[a-z0-9][a-z0-9-]{0,39}$`）、`adapter`、`enabled`（默认 true）、`priority`（默认 100）、`label`、`models`（必须是该适配器已知型号的子集；未知型号 warn 并忽略）、`defaultModel`、`keyFile`（绝对路径）/ `keyEnv`（环境变量名，`^[A-Z][A-Z0-9_]{0,63}$`）。
- **不设置 `OC_STUDIO_PROVIDERS` 时用内置默认**（与现有开关一致，不引入新的必配项）：
  - `gpt-image`：沿用 `OC_IMAGE2_ENABLED` 和 `OC_IMAGE2_ALLOWED_MODELS`（OCV5-587）；未开启 → `disabled/FEATURE_OFF`。
  - `muse`（image + video 两个实例 `muse-image`、`muse-video`）：沿用 `OC_MUSE_BRIDGE_ENABLED`、`OC_MUSE_ALLOWED_UIDS`；bridge 不在线 → `offline/BRIDGE_OFFLINE`（仍可入队，由 A1 的亲和截止期故障转移）。
  - `minimax-speech`：key 用 `resolveMiniMaxMediaKey()`（OCV5-589：`MINIMAX_MEDIA_KEY_FILE`，否则 `MINIMAX_TOKEN_PLAN_KEY`）；都没有 → `unconfigured/MISSING_KEY`。
  - 音乐：**默认没有任何实例**。
- 设置了 `OC_STUDIO_PROVIDERS` 时，以它为准（只出现它列出的实例）；这样运维可以关掉某个实例、调整顺序、限制型号，或加入新的实例。
- key 只认路径或环境变量名，配置里出现形似 key 的字面量（`key`、`apiKey`、`token` 字段）一律拒绝该条目并 warn，防止把密钥写进 env JSON。

## 5. 内置适配器（`media-studio/providers/adapters/`）
| 适配器 | kind / ops | 实现 | 计费与幂等 |
|---|---|---|---|
| `gpt-image` | image: generate, edit | A0 `makeImage2Runner().runImage2ForUser`，requestId = `execRequestId` | 沿用 image2 账本与完成缓存回放；`IMAGE_DAILY_LIMIT` → 不可重试错误，编排器换下一个候选 |
| `muse` | image: generate, edit；video: from_image, from_text, extend | `MuseBridgeHub.submit(..., {jobId: mj_<uuidv5(execRequestId)>})` → `view(wait)` 直到终态 → `fileFor()` 读文件 | 沿用 Muse 按 job 扣费；`affinity()='muse'`；`retryable` 取 hub 的 outcome |
| `minimax-speech` | voice: tts（声明 design、clone 能力位） | OCV5-589 `synthesizeSpeech`，requestId = `voice:tts:<execRequestId>` | 沿用 minimax 媒体账本按字数比例计费；design/clone 本 PR 不接入 run（返回 `UNSUPPORTED_OP`），保留给后续 |

- 适配器目录 `adapters/index.ts` 导出 `BUILTIN_ADAPTERS: AdapterFactory[]`。新增供应商的步骤写进本文 §8 和代码注释。
- 每个适配器的 `estimateMaxCost()` 用该 provider 现有定价函数取上限：GPT 按 `IMAGE2_UNIT_COST × n`（固定价），Muse 按 `OC_MUSE_PRICE_*`（按 job 固定价）。
- **TTS 的上限（plan r1 P1-1 / r2 P1）**：`synthesizeSpeech` 按上游返回的 `usage_characters` 结算，本地字数只是报价，不是上限。处理（**在扣费之前封顶**，不靠事后暂停）：
  1. 预留按 `calculateMiniMaxSpeechCost({usageCharacters: 2 × 码点数 + 16})`：MiniMax 规则是汉字记 2、其余记 1（10-23 实测 14 字中文 → 上游 26，本地计数 26），正常情况下预留就够；
  2. 给 `synthesizeSpeech` 增加可选参数 `costCap`（OCV5-589 客户端，本 PR 内修改）：按上游字数算出的价格超过 `costCap` 时，**只按 `costCap` 结算**，`price_snapshot.notes` 记 `capped from <原价>`，超出部分由平台承担。容器路由不传它，行为不变；
  3. 适配器调用时传 `costCap = ctx.maxCostCredits`（本任务已原子预留的额度），所以**实际扣费永远 ≤ 预留**，项目预算硬上限成立；注册表外层在调用前还会拒绝 `estimateMaxCost > ctx.maxCostCredits` 的任务（`RESERVATION_TOO_SMALL`）；
  4. `MediaResult.overReservation` 只作为对所有适配器的防御性检查保留（实际扣费 > 预留时为 true，A2-1 记录告警并暂停项目）；对内置适配器它不会发生：GPT、Muse 是固定价且不超过预留，TTS 已封顶；
  5. 测试：英文 50 字符 → 上限 116 字 ≥ 上游 51；integ：上游返回 151 字、`costCap=3` → 实扣 3、余额只少 3、snapshot 带 `capped from 4`；不传 `costCap` → 实扣 4。
- 适配器目录 `adapters/index.ts` 导出 `BUILTIN_ADAPTERS: AdapterFactory[]`。新增供应商的步骤写进本文 §8 和代码注释。
- 每个适配器的 `estimateMaxCost()` 用该 provider 现有定价函数取上限：GPT 按 `IMAGE2_UNIT_COST × n`（固定价），Muse 按 `OC_MUSE_PRICE_*`（按 job 固定价）。
- **TTS 的上限（plan r1 P1-1）**：`synthesizeSpeech` 按上游返回的 `usage_characters` 结算，本地字数只是报价，不是上限。处理：
  1. 预留按 `calculateMiniMaxSpeechCost({usageCharacters: 2 × 码点数 + 16})`：MiniMax 规则是汉字记 2、其余记 1（10-23 实测 14 字中文 → 上游 26，本地计数 26），所以 2 × 码点数覆盖全部字符都按最重的规则计，+16 兜住上游可能追加的停顿/标记字符；
  2. 适配器在 `run()` 前确认 `estimateMaxCost(req) ≤ 调用方传入的预留额`，并把预留额作为 `ctx.maxCostCredits` 传入；结算后若实际扣费超过 `ctx.maxCostCredits`（上游计数规则变化等极端情况），结果带 `overReservation: true`，A2-1 必须在同一事务里把超出部分计入 spent 并把项目转为 `paused`（预算类 `needs_user`），不再派发新任务。单次超出量最多一句台词（≤ 500 字），不会连续突破；
  3. 单测覆盖：英文 50 字符、上游 `usage_characters=51` → 预留足够；人为构造上游 `usage_characters` 超过预留 → `overReservation: true`。
- 输出统一成 `MediaOutput[]`，由调用方（A2-1）写入 `StudioBlobStore`；适配器不碰工作台存储。

## 6. HTTP：`GET /api/studio/providers`
- 走 A1 的同一套守卫：`OC_STUDIO_ENABLED` 不是 1 → 404；未登录 401；不在白名单 → 404。
- 返回（示例）：

```json
{"kinds": [
  {"kind": "image", "state": "ready", "providers": [
    {"id": "gpt-image", "label": "GPT Image", "state": "ready", "models": [{"id": "gpt-image-2", "label": "gpt-image-2", "isDefault": true, "ops": ["image.generate", "image.edit"]}]},
    {"id": "muse-image", "label": "Muse", "state": "offline", "reason": "BRIDGE_OFFLINE", "models": [...]}]},
  {"kind": "video", "state": "offline", "providers": [...]},
  {"kind": "voice", "state": "unconfigured", "providers": [{"id": "minimax-speech", "state": "unconfigured", "reason": "MISSING_KEY", "models": [...]}]},
  {"kind": "music", "state": "unconfigured", "reason": "NO_PROVIDER", "providers": []}
]}
```

- 每类的 `state`：有任一 `ready` → `ready`；否则有 `offline` → `offline`；否则 `unconfigured`。
- 视图只含 id、label、state、reason 代码、型号；**不含 key 来源、文件路径、环境变量名**（这些只出现在服务端 warn 日志里，且日志也不含 key 内容）。
- 前端据此：`ready` 正常；`offline` 显示「暂时不可用」并允许排队；`unconfigured` 显示「未配置」占位卡片（音乐页就是这个状态），不发任何生成请求。

## 7. 测试
- `studioProviders.test.ts`（单测，全部注入假 deps）：
  - 默认配置：四类都出现；音乐 `unconfigured/NO_PROVIDER`；无 MiniMax key → 语音 `unconfigured/MISSING_KEY`；`OC_IMAGE2_ENABLED` 关 → `disabled/FEATURE_OFF`；bridge 离线 → `offline`。
  - `OC_STUDIO_PROVIDERS`：未知适配器、非法 id、重复 id、未知型号、`apiKey` 字面量 → 只 warn 不抛、该项不可用；`enabled:false`；`priority` 与 `prefer` 排序；`exclude`。
  - key 文件不可读 → `unconfigured/KEY_UNREADABLE`；**`describe()` 和全部 warn 文本里都不出现 key 内容和路径**（用哨兵字符串断言）。
  - `candidates()`：默认只给 ready；`includeOffline` 时 ready 在前、offline 在后；unconfigured/disabled 永不出现。
- `OC_STUDIO_PROVIDERS` 写成非 JSON、非数组、超长、缺 adapter：`loadConfig()` 不抛错，注册表只 warn。
- 适配器：gpt-image 透传 requestId、把 `IMAGE_DAILY_LIMIT` 映射为不可重试；muse 的 jobId 由 execRequestId 确定性导出且重领一致、失败 outcome 的 retryable 透传；minimax-speech 的 requestId 命名空间、design/clone 返回 `UNSUPPORTED_OP`；全部用注入的 fetch / 假 hub，不访问真实上游。
- `studioHttp.test.ts` 增加 `/providers`：开关关 404、白名单外 404、正常返回结构。
- 不新增 integ（没有 SQL 变化）。

## 8. 以后新增一个供应商（例如用户选定音乐供应商时）
1. 在 `adapters/` 新建一个文件，实现 `AdapterFactory`（声明 kind/ops/型号、`optionsSchema`、`estimateMaxCost`、`run`），`run` 内调用该供应商客户端，并用工作台自有扣费（`studio_charges`，ledger reason `media_studio`，A1 已建表）或该供应商已有的账本结算；
2. 在 `adapters/index.ts` 登记一行；
3. 运维在 `OC_STUDIO_PROVIDERS` 加一条，key 放文件（只写路径）；
4. 前端无需改动：`/providers` 出现 `ready` 的实例后，对应页面自动从「未配置」变为可用。

## 9. 风险
- 默认配置推导和现有开关不一致 → 单测逐条覆盖，并在 PR 描述里列出默认推导表。
- Muse 适配器在 master 内等待 job：`view()` 的长轮询受 `signal` 约束，任务 lease 续租由 A2-1 的 worker 负责；本 PR 只保证 `run()` 响应 abort。
- 配置 JSON 写错导致能力全部不可用：构建不抛错，只 warn；`/providers` 能直接看到哪个实例是 `disabled`。
