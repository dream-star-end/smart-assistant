# OCV5-591 A2-1b 质检与批注方案

依据：编排方案 `docs/ocv5-591-a2-1-orchestrator-plan.md`（A2-1b 一行、§2 状态机、§4 计费）、后端方案 `docs/ocv5-591-media-studio-backend-plan.md`（质检 / 交人条件 / Interpret 白名单）；用户 2026-10-23 21:42「由 agent 操作时只按 agent 的 token 用量计费」。叠在 #1048（A2-1c-2）上。**不新增迁移**：任务 kind 是正则约束（`qa`、`interpret` 直接可用），镜头状态 `qa`、批注表 `studio_annotations`（状态 draft / sent / applied / rejected）、blob 引用种类 `annotation` 在 0324 都已存在。

拆三个 PR：**A2-1b-1 质检**（后端）→ **A2-1b-2 批注与 Interpret**（后端）→ **FE-7**（批注「交给 agent」、确认 / 拒绝 agent 的理解、质检结果展示）。

## 1. 质检（A2-1b-1）

### 1.1 什么时候质检
- 镜头首帧（shot_frame）、镜头视频（shot_video）、设定图（bible 的 image 资产）生成成功后，**不再直接采用**，改为入队一个 `qa` 任务（payload `{takeId, target: 'frame' | 'clip' | 'bible'}`，幂等键 `qa:<takeId>`），镜头进入 `qa` 状态（设定图保持未锁定）。
- 质检通过才采用：首帧通过后才派发视频；视频通过后镜头 `ready`（成为 active take）；设定图通过后锁定。
- 质检关闭（`OC_STUDIO_QA=off`，或 Grok 未配置）→ 保持现在的行为（直接采用），take 的 `qa` 写 `{skipped: true, reason}`，事件 `qa.skipped` 说明原因；此时没有画面审核，成片的 `qa.moderation` 为 `review`（成片页显示「待人工复核」），需求审核按 §1.6 的严格规则。默认：Grok 已配置即开启。
- 用户手动选版本（`/takes/:id/select`）不经过质检；批注触发的重做（§2）照常质检。

### 1.2 质检输入：一张联系表
Grok 视觉一次只收一张图（`visionProxy` 限 1 张、≤ 6 MB），所以先拼一张联系表（sharp，JPEG，长边 ≤ 2048）：
- **frame**：候选首帧（大）+ 该镜头引用的已锁定设定图（角色 / 场景，最多 3 张，小）。
- **clip**：合成沙箱 `frames` 操作在视频 10% / 35% / 60% / 85% 处抽 4 帧（已有操作，未用过），2×2 排列 + 设定图条。
- **bible**：候选图本身 + 需求里对该资产的描述（文字放进提示词，不进图）。
- 每格角上标编号（`F1…F4`、`R1…R3`），提示词里说明各编号是什么。联系表不落盘、不入 blob（只用于这一次调用），避免占用户配额。

### 1.3 评分与判定
- 提示词要求**严格 JSON**：`{character, scene, action, artifacts, moderation, confidence, summary, issues: [{frame?, what}]}`。前四项和 `confidence` 都在 0–1；`moderation ∈ 'pass' | 'review' | 'block'`（画面内容审核：成人、血腥暴力、仇恨、真人冒用等，D7）；`summary` ≤ 200 字（中文，给用户看）。用 zod 校验，格式不对重问一次（同一请求 id 的下一次 attempt），仍不对 → 按「低置信度」处理。
- 前端已经按这些字段显示（Review 页 `QA_ROWS`、`take.qa.score`、成片页 `moderation`），所以 take 的 `qa` 写：`{score, character, scene, action, artifacts, moderation, confidence, summary, issues, passed, model, attempt}`；`score` = 四项的最小值。
- 通过：`moderation = 'pass'`，character ≥ 0.75、scene ≥ 0.7、action ≥ 0.7、artifacts ≥ 0.8，且 confidence ≥ 0.6。设定图只看 moderation、character（或 scene，按资产类型）和 artifacts。
- **审核阻断**（plan r1 P1）：`moderation = 'block'` → 这一版不采用、**不自动重做**，镜头（或设定图）`needs_user`，项目 `awaiting_user`，事件写原因（用户可改需求 / 批注后重做）；`'review'` → 同样交给用户，不采用。成片的 `qa.moderation` = 所有采用镜头的审核结果都为 `pass` 时 `pass`，否则 `review`（A2-1c 的成片 QA 补这一项）。
- 不通过 → 自动重做（同 owner 的新 take，`gen` 任务照常预留和扣费），提示词追加质检的 `issues` 作为「避免」项，换 seed；每个 owner 最多自动重做 **2 次**。
- 交给用户（`needs_user`，镜头状态 `needs_user`，项目 `awaiting_user`）——满足任一条就交，镜头一定会离开 `qa`（plan r1 P1）：
  - **达到重做上限**：第 3 次（原始 + 2 次重做）仍不通过，不论分数是否在提升；
  - 提前停止：某次重做的分数没有超过之前最好的一次（不再浪费第二次重做）；
  - confidence < 0.6（含两次都解析失败）；
  - 审核 `block` / `review`（见上）；
  - Grok 调用不可重试地失败（且没有备选）。
  事件写 `summary`，并给出最好的 2 个候选 take id，用户在 Review 页选版本或写批注。

### 1.4 计费
- 视觉质检的 Grok 调用 **`billTo: 'user'`**（编排方案 §4：用户承担视觉 QA；与「agent 操作按 token 用量计费」一致），走 `makeGrokRunner` 已有的预检 → 账本路径，按实际 token 扣费，重试按 `<requestId>~<attempt>` 记账，不会重复扣。
- 项目预算：`qa` 任务入队前按 Grok 目录价 × 8000 token（与 runner 预检同一估算，导出成一个函数）`reserveBudget`；调用结束后从账本读回实际扣费，`bookTaskCharge(..., {release: true})` 计入 `spent_credits`。读回按 Grok 结算写的账本引用（实现时以 integ 测试钉住具体 ref 类型）。迟到的扣费由现有的对账器补记（扩展到 `kind = 'qa'`）。
- 预算不够预留 → 不质检，项目按 A2-1a 的超预算规则暂停（事件说明“预算不足，质检暂停”）。
- 平台承担的 LLM 步骤（Plan、Interpret、需求审核）照旧不占预算。

### 1.5 状态机改动
- `decide`：新增 `dispatch_qa`。首帧 take 成功且无 qa → 入队 qa；frame 的 `qa.passed` 才算可用来派发视频；视频同理。`MAX_INFLIGHT_PER_PROJECT`（3）把 qa 任务也算在内。
- `execute`：新增 `runQa`（租约内：读 take → 沙箱抽帧 → sharp → Grok → 写 qa → 采用 / 重做 / 交人，同一事务里改镜头状态和写事件）。失租、重领按现有 `withLease`，Grok 结果按请求 id 存进 `studio_step_results`，重领时直接用存下的结果（不再调用、不再扣费）。
- 续接镜头用上一镜头的尾帧（编排方案 §1 第 3 条 A2-1b 起）：**不在本 PR**，单独评估（会改变视频生成的输入，和质检无关）。
- 设定图候选数（管家 2026-10-24 03:07 拍板）：默认 **1 个候选 + 质检 + 不通过自动重做**，重做用完按 §1.3 交给用户。做成配置 `OC_STUDIO_BIBLE_CANDIDATES`（`1` | `2`，默认 `1`，其它值按 `1`）：设为 `2` 时同一设定图一次派发两个候选（子任务键 `gen:bible:<assetId>:v<n>:c<i>`），两个都质检后取通过且分数高的锁定，都不通过则按重做规则继续——切换只改配置，不改代码；2 个候选每个设定图多一次图片生成（约 50 积分）。

### 1.6 需求审核（D7，平台承担）
- `start` 时在 Plan 之前加一步文字审核（Grok，`billTo: 'platform'`），输出 `{verdict: 'pass' | 'uncertain' | 'block', reason}`：
  - `block` → 项目 `failed`，事件写原因；
  - `uncertain` → 视觉质检开启时通过（每一版画面都会经过 §1.3 的 `moderation` 判定，`block` / `review` 不会被采用）；**视觉质检关闭时按 `block` 处理**（没有后续把关，plan r1 P1），事件说明“需求可能不合规，请修改后再开始”；
  - Grok 不可用 → 视觉质检开启时通过并记事件；关闭时同 `uncertain`。
  结果存 `studio_step_results`，重领不重复调用。

## 2. 批注与 Interpret（A2-1b-2）

### 2.1 接口
- `POST /projects/:id/annotations`：建批注（默认 `draft`）。body `{takeId, kind: 'point' | 'box' | 'range' | 'text', tStartMs?, tEndMs?, geom?: {x, y, w?, h?}（0–1 归一化）, text}`。服务端由 take 推出 `target_kind / target_id`（shot_frame / shot_video → shot，line → line，music → music，final → final，bible → asset），校验 take 属于该项目、几何和时间在范围内、`text` ≤ 1000。
- `PATCH /annotations/:id`（仅 draft：改文字 / 几何）、`DELETE /annotations/:id`（仅 draft）。
- `POST /annotations/:id/send`：draft → `sent`，入队 `interpret` 任务（幂等键 `interpret:<id>`）。
- `POST /annotations/:id/apply`（用户确认 agent 的理解）、`POST /annotations/:id/reject`（不采用，状态 `rejected`）。
- 项目视图返回该项目的批注（最近 200 条，不含 interpretation 里的内部字段）。
- 前端草稿现在在 sessionStorage（`oc.studio.annotationDrafts.<projectId>`）：FE-7 改为「交给 agent」时把草稿建到服务端并 send，本地草稿删掉；未发送的草稿仍留本地。

### 2.2 Interpret
- 输入：批注文字、目标（镜头 spec / 台词 / 配乐设置 / 成片时间点）、批注所在的那一帧（视频按 `tStartMs` 用沙箱 `frames` 抽一帧；图片直接用），用 sharp 把 box / point 画在帧上，作为一张图交给 Grok（`billTo: 'platform'`）。
- 输出严格 JSON `{op, args, confidence, explanation}`，`op` 白名单与参数（zod）：
  | op | 参数 | 执行 |
  |---|---|---|
  | `regenerate_shot` | `{shotId, promptDelta}` | 新的首帧 + 视频（gen，照常预留扣费），提示词追加 promptDelta |
  | `edit_frame` | `{shotId, region: {x,y,w,h}, instruction}` | `image.edit`（GPT Image / Muse 支持）：源图 = 当前首帧，参考图 = 画了框的那一帧，指令写明框内要改什么；然后重出视频 |
  | `retime_shot` | `{shotId, durationSec}` | 改镜头 `spec.durationSec`（2–10 s，与分镜方案同一范围），重出视频 |
  | `change_line` | `{lineId, text}` | 改台词文字，重新配音 |
  | `swap_voice` | `{voiceId}`（仅系统音色） | 换旁白音色，重新配音全部台词 |
  | `adopt_take` | `{takeId}` | 选用已有的某一版（同 `/takes/:id/select`） |
- 不在白名单、参数不合法、或目标不属于该项目 → 批注保持 `sent`，`interpretation = {op: null, explanation}`，界面显示「agent 没看懂，可以换个说法」。
- `autonomy = 'max'` 且 confidence ≥ 0.8 → 直接执行；否则把 `interpretation` 写进批注，界面显示「agent 理解为 …」，等用户 apply / reject（后端方案 §3）。
- **一次性执行记录**（plan r1 P1）：自动执行和用户 apply 走同一个入口 `executeAnnotation`，先在一个事务里原子认领：`UPDATE studio_annotations SET interpretation = interpretation || {"execution": {"n": k, "state": "running", "taskKey": "annot:<id>:<k>"}} WHERE id = $1 AND status = 'sent' AND (interpretation->'execution' IS NULL OR interpretation->'execution'->>'state' = 'failed') RETURNING …`，只有认领成功的那一次才派发（同一事务里入队，不经过每次新建版本的 `dispatchRequest`，所以重复 apply / 自动执行与 apply 并发都只会派发一次、预留一次）。认领不到 → 409 `ANNOTATION_BUSY`（已在执行）。
- **子任务的幂等键**（plan r2 P1）：一次执行可能派发多个生成（`swap_voice` 重配全部台词、`regenerate_shot` 先首帧后视频），队列的 `idempotency_key` 全局唯一，所以每个子任务用由目标和步骤派生的独立、稳定的键：`annot:<id>:<k>:<ownerKind>:<ownerId>:<step>`（例：`annot:…:2:line:<lineId>:tts`、`annot:…:2:shot_frame:<shotId>:edit`）。同一次执行重放时得到同样的键（不重复派发），不同目标 / 步骤互不去重；执行记录 `execution.tasks` 记下派发的键，全部完成才算 `done`，任一交给用户或失败即 `failed`。
- `reject` 只在没有执行在跑时允许（同样的原子条件 `execution IS NULL OR state = 'failed'`），否则 409。
- 执行完成（新 take 通过质检，或 adopt 完成）→ 批注 `applied`，`applied_take_id` 指向新 take，`execution.state = 'done'`；执行失败或新 take 交给了用户 → `execution.state = 'failed'` 并写原因，批注保持 `sent`，可以再次 apply（k + 1）。
- **完成的项目上的批注**（target final 或任意目标，项目 `done`，plan r1 P1）：`interpret` 只读不改素材，所以执行器的门控对 `interpret` 放行 `done` 项目（其它任务仍按现有规则）；**执行时**（认领成功的同一事务里）把项目从 `done` 转回 `running`（`rev + 1`，事件 `project.reopened`，原因是这条批注），再派发重做；成片批注按时间点找到对应镜头再按上表处理。重做完成后照 A2-1c 的规则重新合成（不收费）。在途的导出合成按 A2-1c 已有的输入指纹复核处理：输入变了就不发布，导出按新输入重新入队。`adopt_take` 在 `done` 项目上同样先转回 `running` 再选版本（`selectTake` 对 `done` 的拒绝不变，批注执行走自己的事务）。Interpret 没给出可执行的指令时项目保持 `done`。

### 2.3 计费与限流
- Interpret 平台承担，不占预算；每个项目同时最多 2 个 interpret 在跑，每用户每分钟 10 次（Grok runner 的 rateKey）。
- 执行产生的生成照常预留和扣费；预算不够 → 批注保持 `sent`，原因“预算不足”。

## 3. 前端（FE-7）
- Review / 图片工作台：「交给 agent」按钮启用（建批注 + send）；批注卡片显示状态（理解中 / agent 理解为 … / 已执行 / 未采用）与 apply / reject；成片批注入口去掉「导演 agent 上线后开放」。
- 质检：Review 页质检面板已按 §1.3 字段显示；补「自动重做第 n 次」「已交给你：最好的两个候选」两种状态。

## 4. 测试
- 单测：评分判定与阈值、JSON 解析与重问、联系表布局（尺寸 / 格数 / ≤ 6 MB）、decide 的 qa 分支、Interpret 白名单与参数校验、批注几何 / 时间校验、take → target 推导。
- integ（CI，`.github/integ-tiers/pr-2.txt`，min-tests 相应上调）：假沙箱 + 假 Grok 跑通「首帧 → 质检通过 → 视频 → 质检通过 → ready」；不通过自动重做 2 次后交人且给出最好的两个候选；质检扣费进账本和项目 `spent`、重领不重复扣；预算不足暂停；质检关闭时直接采用；批注 draft → send → interpret → autonomy max 直接执行 / 否则等确认 → apply → applied；不在白名单 → 保持 sent；reject；**同一批注并发 apply 两次只派发一次、只预留一次**；`swap_voice` 在两条以上台词的项目上每条台词各派发一次（子任务键不互相去重）；执行中 reject → 409；**done 项目上的成片批注** → interpret 不被取消、执行时转回 running 并重新合成，在途导出按新输入重排；**重做上限**：三次都不通过（分数一直在升）→ needs_user；审核 block → 不采用、不重做、交人；质检关闭 + 需求审核 uncertain → 不开始。

## 5. 不在本步
- 续接镜头用上一镜头尾帧；设定图 2 候选择优；片尾字幕署名（成片 end card）；导演自动选曲（M1-3）。
