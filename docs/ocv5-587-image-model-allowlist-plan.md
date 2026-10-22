# OCV5-587 方案：codex relay 的 GPT 图片型号白名单可配置（为 gpt-image-2.5 做准备）

- 总票 OCV5-586（媒体工作台第一期，商业版）。用户 2026-10-23 01:02 CST 批准 D1：先放行型号，上线后在 uid 247 上做一次 2.5 探测。
- 只改商业版 `feat/v5-aurora-rewrite`。

## 背景

- relay 在三处写死了 `gpt-image-2`：
  - `normalizeNativeImageRequest`：JSON 和 multipart 两条分支都拒绝其它型号，并把型号强制改写成 gpt-image-2。
  - annotated-edits / outpaint 构造上游请求时，`model` 是常量。
  - 两处幂等摘要的前缀里也写死了这个字符串。
- 计费 `settleImageCharge` 的 memo 写死了 `gpt-image-2`；`reserveImageUsage` 的 INSERT 没有写 `model` 列，0131 里这一列默认是 `'gpt-image-2'`。
- OpenAI 已在 2026-09-08 发布 GPT Image 2.5（API 型号 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`）。Codex 0.163.0 仍然发 `gpt-image-2`。一旦 Codex 改发 2.5，现在的 relay 会回 400，GPT 生图整体失效。
- 媒体工作台第一期需要显式选型号：设定图和精修用 sunburst，普通生成用 flare 或 2。

## 改动

1. 新模块 `packages/commercial/src/billing/imageModels.ts`（纯函数，可单测）：
   - `parseImageModelPolicy(env)` → `{ allowed: ReadonlySet<string>, editDefault: string }`。
   - `OC_IMAGE2_ALLOWED_MODELS`：逗号分隔，默认 `gpt-image-2`。每一项必须匹配 `^gpt-image-[0-9][0-9a-z.\-]{0,40}$`，不合规的项丢弃并记 warn；解析后为空时回退到 `{gpt-image-2}`（fail-closed 到现状）。
   - `OC_IMAGE2_EDIT_MODEL`：annotated / outpaint 默认用的型号，默认 `gpt-image-2`。不在 allowed 里时回退到 `gpt-image-2` 并记 warn。如果连 `gpt-image-2` 也不在 allowed 里，editDefault 取 allowed 的第一项。
   - `IMAGE_MODEL_RE` 一并导出，供请求校验复用。
2. `normalizeNativeImageRequest(body, contentType, policy)`：
   - 型号必须在 `policy.allowed` 里，否则抛错（handler 现有逻辑映射为 400 `INVALID_IMAGE_REQUEST`）。
   - 不再改写型号，原样转发调用方给的合法型号。
   - multipart 仍要求恰好一个 `model` 字段。
   - 返回值新增 `model`。
   - 摘要算法不变：JSON 分支本来就对整个 parsed 做 stableStringify，multipart 分支本来就对全部字段做哈希，所以型号已经在摘要里。不同型号的同一请求得到不同摘要，不会互相命中缓存。
3. annotated-edits：
   - `AnnotatedImageRequest` 新增可选 `model?: string`。`parseAnnotatedImageRequest` 校验它匹配 `IMAGE_MODEL_RE`。是否在白名单里由 handler 用 policy 判断，不在就返回 400。没给时用 `policy.editDefault`。
   - 上游请求体的 `model`、两处摘要前缀（`<model>\0outpaint\0`、`<model>\0annotated_edit\0`）都改用解析出的型号。**注意**：这会改变已有幂等摘要的前缀。默认型号仍是 gpt-image-2 时，前缀字节完全不变（`gpt-image-2\0…`），所以现有缓存和重试的语义不变。
4. 计费：`reserveImageUsage` 和 `settleImageCharge` 新增可选参数 `model?: string`（默认 `gpt-image-2`）：
   - reserve 的 INSERT 显式写入 `model` 列（0131 已有该列，VARCHAR(80)，不需要迁移）。
   - settle 的 memo 改成 `${model} ${operation}…`。
   - **单价不变，每张 50 积分**：2.5 的 token 单价与 2 相同（社区和二手资料），用户的 D6 未调整图片单价。如果以后要按型号定价，另开票处理。
5. `makeCodexRelayHandler` 在构造时解析一次 policy；允许由 `deps.imageModelPolicy` 注入，供测试使用。
6. gateway `inboundDispatch.ts` 里展示用的 `model: 'gpt-image-2'` 不改。它只是对话记录的标签，不参与计费和上游请求。

## 不变量与风险

- 默认配置下（不设两个 env）行为与现在逐字节一致：只放行 gpt-image-2，上游请求体、摘要、memo 都不变。
- 放行列表只能是 `gpt-image-*` 形式，env 写错不会放开任意型号。
- 计费上限不变：n 仍然钳在 [1,4]，单价固定 50。
- 生效面：`packages/commercial/src/http/internalCodexRelay.ts` 和 `billing/` 属于 egress surface，发布要带 `--egress`。生产 env 新增两个键属于 env overrides，发布时手动同步（默认值就是现状，所以不同步也安全）。

## 测试

- 单测 `imageModels.test.ts`：默认值；多项解析；非法项丢弃；空值回退；editDefault 不在 allowed 时回退。
- relay 单测（沿用现有的 `internalCodexRelay` 测试夹具）：默认 policy 下 `gpt-image-2.5-flare` 被拒（400）；policy 放行后原样透传（上游收到的 body.model 等于请求值）；multipart 同理；annotated 带 `model` 时上游 body.model 正确，不在白名单时 400；不带时用 editDefault。
- `imageBilling.integ.test.ts`：reserve 和 settle 传 `model` 后，`image_generation_usage_records.model` 与 ledger memo 正确；不传时仍为 gpt-image-2。

## 上线后（需要发布批准，另记证据）

- env 加 `OC_IMAGE2_ALLOWED_MODELS=gpt-image-2,gpt-image-2.5-flare,gpt-image-2.5-sunburst`；`OC_IMAGE2_EDIT_MODEL` 暂不设（仍为 2）。
- D1 探测：用 uid 247 发一次 annotated-edit，带 `model=gpt-image-2.5-sunburst`（1 张，50 积分）。只记录上游状态码、是否出图、产物的 C2PA 型号字段。被拒时保持 2.0，结论写进工单。
