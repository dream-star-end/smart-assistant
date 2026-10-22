# OCV5-591 方案：媒体工作台后端核心（商业版第一期）

- 总票 OCV5-586。用户 2026-10-23 01:02 拍板：只做商业版；PLAN v2 的全部 D 项按推荐执行；**默认档为最高自动化**；开关 `OC_STUDIO_ENABLED` 默认关，只开给 uid 247 和管理员。
- 依赖：OCV5-587（GPT 图片型号）、588（合成沙箱）、589（MiniMax 媒体客户端和 0322）、590（ElevenLabs 音乐）。前端是 OCV5-593，商业化是 OCV5-594。
- 集成点调研（master 侧能否直接调用各能力）的结论都已写进下文，并附有代码位置。

## 0. 原则
1. **编排放在 master，状态放在 PG**。扛得住容器回收、A/B 两个 master 并存和发布切换。
2. **LLM 只做“步骤函数”**（Plan、Prompt、Script、QA、Interpret），全部是无状态调用，输出用 zod 校验。是否推进、是否重试、是否扣费由确定性的状态机决定。
3. **计费复用各 provider 现有的账本**（GPT 图片、Muse、MiniMax、Grok 视觉）。工作台只记项目级汇总，并新增唯一一个自有扣费项：合成（ledger reason `media_studio`）。
4. 默认关闭，按白名单灰度；合入后对现网零行为变化。

## 1. 拆成 4 个 PR（每个都过 Codex 和 CI）
| PR | 内容 |
|---|---|
| **A0** 抽取 | ① 从 `http/internalCodexRelay.ts` 把 GPT 图片的预检、上游调用、结算抽成 `billing/image2Run.ts` 里的 `runImage2ForUser({userId, containerId: null, accountId, dispatcher, token, body, operation, model, requestId})`，relay 改为调用它，行为逐字节不变（这部分属于 egress surface，发布要带 `--egress`）；账号用 `pickCodexAccountForBinding(codexBindingAffinityKey(uid))` 选取。② 从 `grok/visionProxy.ts:382-566` 抽出 `runGrokResponsesForUser({userId, containerId: null, input: {text, images?}, model})` → `{text, usage}`，计费链路照旧（预检、journal、`settleDurableCodexBilling`），限流的 key 从容器改为“用户 + 容器或 studio”；HTTP handler 退化为一层薄包装。 |
| **A1** 数据与存储 | 迁移 0323、`studio/store.ts`、内容寻址的 blob 存储和配额、任务队列（lease 加 epoch）、文件下发（ticket + Range）、`/api/studio/*` 的增删查骨架、开关和白名单 |
| **A2** 编排与步骤 | 状态机、provider 适配器（GPT、Muse、Grok 图、MiniMax 图/视频/语音、ElevenLabs、合成）、LLM 步骤（Plan、Prompt、Script、QA、Interpret）、预算守卫、批注转指令、`sys.studio_event` 推送 |
| **A3** 容器入口 | `oc-studio` CLI 和 `/internal/v3/studio`：聊天里一句话开项目、查进度、批注 |

## 2. 数据模型（迁移 `0323_media_studio`，声明 `order-dependency: 0322_minimax_voices`）

```sql
studio_projects(id uuid pk, user_id fk cascade, title, brief text ≤4000, status
  check(draft|planning|running|awaiting_user|composing|done|failed|paused|canceled),
  autonomy check(max|confirm) default 'max', aspect check('16:9'|'9:16'|'1:1') , fps int, target_sec int,
  budget_credits bigint default 2000, spent_credits bigint default 0, settings jsonb, rev int,
  created_at, updated_at, deleted_at)
studio_assets(id uuid pk, project_id fk, user_id, kind check(character|scene|style|voice|reference|upload),
  name, locked bool, descriptor text, blob_sha, voice_id text null, meta jsonb, created_at)
studio_shots(id uuid pk, project_id fk, ordinal int, spec jsonb, status check(planned|generating|qa|needs_user|ready|failed),
  active_take_id uuid null, unique(project_id, ordinal) deferrable)
studio_lines(id uuid pk, project_id fk, shot_id fk null, ordinal, speaker_asset_id fk null, text ≤500,
  emotion text, speed numeric, active_take_id uuid null, status)
studio_takes(id uuid pk, project_id fk, owner_kind check(shot_frame|shot_video|line|music|bible|final),
  owner_id uuid, version int, provider, model, op, inputs jsonb, prompt text, status
  check(queued|running|succeeded|failed|canceled), error_code, cost_credits bigint default 0,
  provider_ref jsonb /* {table, id} 指向 image_generation_usage_records / muse_media_jobs / minimax_media_usage_records / usage_records / credit_ledger */,
  qa jsonb, blob_sha, meta jsonb, created_at, finished_at, unique(owner_kind, owner_id, version))
studio_annotations(id uuid pk, project_id fk, target_kind, target_id, take_id, author check(user|agent),
  kind check(point|box|brush|range|text), t_start_ms, t_end_ms, geom jsonb, text ≤1000, frame_blob_sha,
  interpretation jsonb, status check(draft|sent|applied|rejected), applied_take_id, created_at)
studio_events(id bigserial pk, project_id fk, ts, type, payload jsonb)   -- 活动日志，同时是推送源
studio_tasks(id uuid pk, project_id fk, kind, payload jsonb, idempotency_key unique,
  status check(queued|leased|done|failed|canceled), attempts int, run_after timestamptz,
  lease_owner text, lease_epoch int, lease_until timestamptz, affinity text null /* 'muse' 等 */,
  last_error text, created_at, updated_at)
studio_blobs(sha256 pk, user_id fk, bytes bigint, mime, path, refcount int, created_at, last_ref_at)
```

- `credit_ledger_reason_check` 增加 `media_studio`（写法同 0319 的放宽方式）。
- 保留期：`studio_events` 保留 180 天，在 `AUDIT_RETENTION_POLICIES` 登记；其余表属于用户自有数据，随用户删除级联清除，登记进 durable 清单。没被采用的 take 的 blob 由 GC 回收（§6）。
- 部署窗口：全部是新增表，加一处 CHECK 放宽；旧代码不读不写这些表，所以对旧代码安全。

## 3. 任务队列与 A/B 两个 master
- 认领方式照搬 `db/turnTapeJobs.ts` 的 lease + epoch：
  - 可认领的任务：`status='queued' AND run_after<=now()`，或 `status='leased' AND lease_until<now()`；
  - 认领语句：`FOR UPDATE SKIP LOCKED LIMIT n`，写入 `lease_owner = 本实例 id`、`lease_epoch+1`、`lease_until = now() + 90s`，运行中每 30 秒续租；
  - 完成时用 owner + epoch 做 CAS。
- **两个 slot 都跑 worker**（不进 leader bundle）。认领时按 provider 亲和过滤：`affinity='muse'` 的任务，只有本进程 `museHub.bridgeOnline()` 为真时才认领。原因是 Muse hub 在进程内存里，只有 bridge 所在的那个 slot 能派发。其它任务两边都可以认领。
- 同一项目的状态推进加 `pg_try_advisory_xact_lock(hashtext(project_id))`，保证同一时刻只有一个进程在推进它。
- 并发上限：每个项目同时进行中的生成任务 3 个；每个用户同时运行的项目 1 个；合成全站 2 个（由 runner 控制）。
- 失败重试：provider 返回“可重试”时按指数退避（30 s 起，最多 3 次）；不可重试的失败交给编排器决定是换备选 provider，还是标为 `needs_user`。

## 4. 编排状态机（默认最高自动化）

```
draft →(brief)→ planning: Plan 步骤 → 分镜、台词、配乐方向、统一设定、预估 → 写 shots/lines/assets
  ↓ autonomy=max：方案自动通过（预估 > 预算时停在 awaiting_user）
running:
  Bible：角色设定图（GPT，2 个候选）→ QA 选优 → 自动锁定；旁白音色（系统音色候选 → Script 步骤选择，或按方案设计音色）
  镜头（按依赖并行）：Prompt 步骤 → 首帧（GPT 或 Muse 图）→ QA_frame → 视频（Muse，首帧或续接）→ 抽帧 → QA_clip
       通过 → ready；不过且重试 < 2 → 调整提示词或换 seed 再来；两次分数都没提升 → needs_user（附最好的 2 个候选）
  台词：逐句 TTS（锁定的音色）→ 时长回填：台词比镜头长时自动延长镜头（Muse 原片约 10 s，裁剪余量够用），否则 needs_user
  音乐：方向 → ElevenLabs 生成 2 个候选（时长 = 成片时长）→ Script 步骤按情绪和高潮对齐打分选优
composing：合成沙箱 → final.mp4 → QA_final（抽帧 + 响度 + 时长）→ done
```

- **预算守卫**：每次派发前比较 `spent + 预估 ≤ budget`。超出时项目转为 `paused`，并发出 `needs_user`（类型为 budget）。
- **低置信度才找人**：QA 置信度低于 0.6，或重试两次没有提升，或 provider 不可用且没有备选时，才转人工。
- **批注即指令**：`studio_annotations` 写入后由 Interpret 步骤生成结构化指令（`op` 白名单）。autonomy=max 且置信度 ≥ 0.8 时直接执行，否则界面显示“agent 理解为”，等用户确认。
- 用户取消或暂停时：已经派出去的上游调用让它跑完（已在途的扣费照常），不再派新任务。

## 5. LLM 步骤（`studio/steps/*`）
- 调用 A0 抽出的 `runGrokResponsesForUser`（Grok 4.7）。**计费口径（D6c）**：视觉 QA 按 token 向用户收（沿用现有链路）；Plan、Prompt、Script、Interpret 由平台承担。平台承担的调用记在一个平台账户下，不写用户 ledger，只记 `studio_events`。实现方式：调用时传入 `billTo: 'platform'`，跳过用户结算，只做 journal。A0 会在 `runGrokResponsesForUser` 上加这个开关，并为它补测试。
- 每个步骤都有固定的系统提示词，用户输入（需求、批注、台词）只放在 JSON 数据区。输出要求严格 JSON，用 zod 校验；校验失败重试一次，再失败就 `needs_user`。
- QA 的评分表固定：角色一致、场景一致、动作符合、瑕疵、置信度（阈值见 PLAN §2.4），输入是抽出的 3–5 帧加锁定的设定图。

## 6. 存储（D5）
- 根目录 `OC_STUDIO_ROOT`，默认 `/var/lib/openclaude-v5/studio`：
  - `blobs/<aa>/<bb>/<sha256>`：内容寻址，0640，写入时先写临时文件再 rename，保证原子；
  - `work/<jobId>`：合成沙箱的工作目录。
- 配额：每用户 5 GB，全站 15 GB。写入前检查，超出返回 `STUDIO_QUOTA`。另有 `statfs` 硬下限：剩余空间少于 2 GB 时拒绝所有写入。
- 回收：没被采用的 take 的 blob 在 take 结束 30 天后回收；锁定的资产和成片跟着项目走；项目软删除 7 天后硬删除。由每天一次的 GC 任务完成，走队列。
- 下发：`POST /api/studio/blobs/:sha/ticket` 签发 HMAC ticket（15 分钟，绑定用户和 sha）→ `GET /api/studio/blobs/:sha?ticket=`，支持 Range（206/416），实现照搬 `media-generation/http.ts:150-200` 并抽成共享的 `sendFileWithRange`。缩略图在生成时由 ffmpeg 直接产出 webp 存成 blob，不在请求时现做。

## 7. 浏览器 API（A1 骨架，A2 补全）
- `/api/studio/*` 需要登录：`requireAuth` 加白名单（`OC_STUDIO_ALLOWED_UIDS`，逗号分隔或 `all`，规则同 `parseAllowedUids`，uid 4 一律忽略）；`OC_STUDIO_ENABLED` 不是 1 时全部返回 404。前缀要同时登记到 `buildCommercialRoutes` 和 `COMMERCIAL_ROUTE_PREFIXES`。
- 接口：项目的增删改查；`POST /projects/:id/brief`；`POST /projects/:id/approve`（autonomy=confirm 时用）；`POST /projects/:id/pause|resume|cancel`；`GET /projects/:id`（返回聚合视图：shots、lines、takes、最近事件、预算）；`POST /annotations`；`POST /annotations/:id/send`；`POST /takes/:id/select`；`POST /assets/voices/design|clone`（克隆要带授权声明）；`POST /projects/:id/compose`；blob ticket。
- 推送：新增帧 `sys.studio_event`，需要改四处：protocol 的 schema、`userChatBridge` 的容器禁伪造清单、web-react 的 `frames.ts` 和 `socket.ts`。通过 dual-master fan-out（`slotRelayClient.broadcastToUsers`）发送，所以连在另一个 slot 上的用户也能收到。

## 8. 安全
- 所有查询都带 `user_id`，项目、资产、blob 不会跨用户读取；blob ticket 绑定用户。
- 合成沙箱不联网，参数是类型化的（OCV5-588）。
- 克隆必须有授权声明（OCV5-589）；工作台层面另外要求音频样本来自本人上传（`studio_assets.kind='upload'`，记录来源）。
- 提示词注入：用户文本只放数据区；Interpret 输出的 `op` 和字段都走白名单；provider 侧的提示词由代码拼接，并附上统一设定。
- 内容审核（D7）：需求、台词、批注先过一次 Grok 审核（平台承担），成片抽帧后再审一次；明确违规就拒绝，拿不准的转人工（管理端队列在 OCV5-594）。

## 9. 测试
- A0：relay 现有的单测和 integ 全部原样通过（行为不变）；新函数的单测覆盖账号选取、计费和失败路径；visionProxy 现有测试原样通过；`billTo: 'platform'` 不写用户 ledger。
- A1：迁移 integ（从 0 重放、约束、级联删除）；队列 integ（两个实例并发认领、过期续抢、epoch CAS、亲和过滤）；blob 存储（原子写、配额、GC）；路由（开关、白名单、跨用户 404、ticket 和 Range）。
- A2：状态机用假 provider 和假 LLM 驱动，覆盖整条链路（通过、重试、需要你、预算暂停、取消、master 重启续跑）；批注转指令；计费汇总和各 provider 账本一致。
- 上线验证（需要批准）：uid 247 跑一个 15 秒、3 镜头的项目（真实生成，约 400–600 积分），做全量对账，截图对照设计稿。

## 10. 不在本票
- 前端（OCV5-593，等用户确认设计稿）；商业化的管理端审核队列、定价页、对账脚本（OCV5-594）；对口型（P2）。
