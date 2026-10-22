# OCV5-577 个人版「经验分享」实施方案

- 需求：用户 2026-10-22 想要一个博客栏，在上面发布使用经验。
- 决定：2026-10-22 18:03 拍板（AI 自动审核、图片单张 ≤10MB 且每篇 ≤20 张、不做评论、未登录可读、noindex、发布后不可编辑、商业版随同步带过去但默认关）。
- 设计稿：18:31 确认，路径 `workspace/ocv5-577-blog/design/after/`。
- 基线：`feat/v5-selfhost` @ 40ccce4ad。

在现有 `community_tutorials`（`kind='markdown'`）上演进，不新建平行的发文体系。分三个 PR，按 A → B → C 合并：

| PR | 范围 |
|---|---|
| A 后端基础（本 PR） | 迁移、图片上传和归属、投稿校验与频控、读取接口补字段、管理端按状态列表、功能开关 |
| B AI 审核 | JEV 客户端共享、moderation worker、判定规则、站内信、shadow/on 开关 |
| C 前端 | 入口、列表、详情、编辑器、我的投稿、管理端，按设计稿实现 |

## PR-A 细节

### 1. 迁移 `0320_community_blog.sql`

**编号**：由 `scripts/v5-migration-claim.sh` 申领，建议号为 0320，没有在途占号。个人版当前最高号是 0315；0316–0319 是商业专用号（`*_commercial_*`），不会进入个人版。所以按 R3 规则，文件头要声明 `-- order-dependency: none (0316–0319 为商业专用号)`。同步到商业版时，0320 大于商业的 0319，没有顺序问题。

只做加法，并且只放宽约束：

1. **`tutorial_blobs`**
   - kind 的 CHECK 加入 `'image'`。
   - bytes 上限从 8388608 放宽到 10485760。
   - 做法：先 DROP，再按同名 ADD 回去。0244 里这两个约束是列级、未命名的，PG 自动生成的名字是 `tutorial_blobs_kind_check` 和 `tutorial_blobs_bytes_check`；迁移用 `IF EXISTS` 删掉后，新约束改用显式名字。
2. **新表 `tutorial_blob_uploads`**
   - 字段：`sha256` FK → `tutorial_blobs`，`ON DELETE CASCADE`；`user_id` FK → `users`；`created_at`。主键是 `(sha256, user_id)`。
   - 用途一：记录「谁上传过这张图」，用来授权作者预览、在投稿时绑定。
   - 用途二：24 小时上传计数。
   - 索引：`(user_id, created_at DESC)`。
3. **`community_tutorials` 加列**
   - `review_source TEXT NULL`，CHECK 取值为 `human` 或 `ai`。
   - `needs_human BOOLEAN NOT NULL DEFAULT false`。
   - `view_count BIGINT NOT NULL DEFAULT 0`。
   - 回填：已有的 `status='pending'` 行设为 `needs_human=true`，因为它们都在等人工审核。
4. **重建 `community_tutorials_review_state_chk`**
   - approved 和 rejected 的条件，由「`reviewed_by IS NOT NULL`」改为「`reviewed_by IS NOT NULL OR review_source IS NOT DISTINCT FROM 'ai'`」，其余条件不变。
   - 必须用 `IS NOT DISTINCT FROM`：`review_source` 为 NULL 时，用 `=` 得到的是 NULL，PG 的 CHECK 会放行 NULL，那样就会出现「既没有审核人、也不是 AI」的 approved 行（Codex 方案审 R1 P1）。
   - 只放宽，旧行和旧代码的写入全部满足。
5. **`needs_human` 不用 CHECK 和 status 绑定**（Codex 方案审 R1 P1）。0320 之前的代码改 status 时不知道这一列，回滚后旧代码的撤回和审核不能因此失败。读取方一律按 `status='pending' AND needs_human` 过滤；新代码在离开 pending 时顺手清掉 `needs_human`，只为数据整洁，不依赖它。
6. **索引** `idx_community_tutorials_needs_human`，建在 `(created_at, id)` 上，条件是 `WHERE status='pending' AND needs_human`。
7. **登记**：写入 `deploy/v5/release-metadata.json` 的 `requiredMigrations`；integ 测试登记到 `.github/integ-tiers`。每条可能有兼容风险的语句都写 `-- compat:` 说明（`scripts/v5-selfhost-migration-compat-check.sh`）。

**对线上旧代码是否安全（部署窗口三问）**：迁移只做加法。新列都有默认值；放宽后的约束对旧写入恒真；没有任何绑定新旧列的约束。所以：
- 迁移先于代码 apply，部署窗口内旧代码照常运行；
- 回滚到 0320 之前的代码也能正常读写，AI 审核过的行旧代码照样能读，只是看不到 review_source。

> **2026-10-22 改写（合入后，发布前）**：个人版列车的破坏性 DDL 门（`scripts/lib/v5-migration-ddl.sh`）拒绝任何 `ALTER ... DROP`，0320 原稿里放宽约束用的 `DROP CONSTRAINT` 会让下一趟列车卡住。改写后的 0320 不含任何 DROP，也不放宽既有约束：
> - 图片按既有的 `kind='media'` 入库，靠 mime 与 `image:` role 区分；入库上限沿用既有的 8 MiB（上传原图仍可到 10MB，前端先压成 webp）；
> - 审核状态约束不变：AI 结论的 `reviewed_by` 记最早的在职管理员作系统操作者（与系统站内信发件人同一做法），来源靠 `review_source='ai'` 区分；没有在职管理员时转人工。
> 上面第 1 节里放宽 kind/bytes/审核状态约束的条目因此作废。

### 2. 图片上传 `POST /api/tutorials/images`

- **前置条件**：需要登录，并且 `OC_COMMUNITY_BLOG_ENABLED` 为 `1` 或 `true`；开关关闭时返回 404 `FEATURE_DISABLED`。
- **请求体**：原始字节，`Content-Type` 只能是 `image/png`、`image/jpeg`、`image/webp`。新增 `readBinaryBody(req, max)`，上限 10485760，超过返回 413。
- **校验**：用魔数判定真实格式，并且必须和 Content-Type 一致；SVG、GIF 以及其它格式一律 400 `BAD_IMAGE`。
- **去元数据**：
  - png/webp 复用 snapshotSanitizer 现成的 chunk 级白名单剥离（导出为 `sanitizeTutorialImage`），不重新编码，所以没有二次压缩。
  - jpeg 用 sharp `.rotate().webp({quality: 90})` 转成 webp：重新编码时会丢掉 EXIF 和 GPS，同时把方向固化到像素里。
- **sharp 检查**：用 `metadata()` 做解码校验：
  - `failOn:'error'`；
  - `limitInputPixels` 50M；
  - 单边不超过 16384；
  - 页数按 `metadata.pages ?? 1` 判断：静态图的 pages 是 undefined，按 1 处理；大于 1 的是动图，拒绝（Codex 方案审 R1 P1）。
- **频控**：在事务里先取 `pg_advisory_xact_lock('tutorial-image-upload:<uid>')`。同一用户 24 小时内的上传行数达到 200 时，返回 429 `RATE_LIMITED`。同一张图（sha 相同）重复上传是幂等的：不新增行，也不占额度。
- **写入**：`tutorial_blobs`（kind=`image`，`ON CONFLICT DO NOTHING`），再写 `tutorial_blob_uploads`。
- **返回**：`{ sha256, mime, bytes, width, height }`。

### 3. 预览读取 `GET /api/tutorials/images/:sha`

- 登录用户满足以下任一条件就返回图片：
  - 上传过这张图；
  - 是某篇引用了它的稿件的作者；
  - 是管理员（`requireAdminVerifyDb` 的数据库角色核验）。
- 否则返回 404，不区分是不存在还是无权限。
- 响应头与 embed 一致：inline、nosniff、CSP sandbox、`Cache-Control: private, no-store`、`X-Robots-Tag: noindex`。
- 公开读取仍然只走 `/api/tutorial-embeds/:sha`，条件不变（引用它的稿件必须是 approved）；另外补一个 `X-Robots-Tag: noindex` 头。
- 前端带 Bearer 用 fetch 取图，转成 blob URL。原因是 `<img>` 带不上 Authorization。

### 4. 投稿 `POST /api/tutorials`（markdown）

- **body 上限**：改为 256KiB，修复 50000 字中文触发 413 的缺陷。
- **图片引用**：从正文里解析 `![alt](tutorial-blob:<sha64>)` 作为唯一来源（不另收 `imageShas[]`，以免正文和数组不一致）：
  - 去重后最多 20 张；
  - 每张必须在 `tutorial_blob_uploads` 里属于本人，否则 400 `BAD_IMAGE`；
  - 开关关闭时，只要带图片引用就返回 404 `FEATURE_DISABLED`。
- **外链图片**：正文里出现 `![..](X)`、而 X 不是 `tutorial-blob:` 的，返回 400 `EXTERNAL_IMAGE`。
- **泄密扫描**：
  - 扫描前把合法的 `tutorial-blob:<sha64>` 替换成占位符。现有规则会把 64 位和 32 位十六进制当成 container/trace id，不替换就会误报。
  - 其余规则不变。
  - 管理员人工通过前的复扫（`rescanBeforeReview`），扩展到 markdown 稿件引用的图片 blob（`scanArtifactBytes`）。
- **频控**：在事务里取已有的 `tutorial-quota:<uid>` advisory 锁：
  - 24 小时内 markdown 投稿已有 5 篇时，返回 429 `RATE_LIMITED`；
  - 本人处于 pending 的 markdown 稿件已有 3 篇时，返回 429 `RATE_LIMITED`。
- **写入**：插入稿件行，status=pending。在 PR-B 之前设 `needs_human=true`；PR-B 按 moderation 模式决定这个值。同一事务里把图片写入 `tutorial_blob_refs`，role 为 `image:<sha前12位>`；多张图前 12 位相同的概率可以忽略，如果撞了，就用完整 sha 作 role。
- **快照投稿**（`/snapshots`）的行为不变，只是新建的 pending 行也设 `needs_human=true`，否则会掉出人工队列。

### 5. 读取接口补字段

| 接口 | 新增 |
|---|---|
| `GET /api/tutorials`（列表） | `coverSha`：正文里第一张图的 sha，在 SQL 里用 substring 正则取出，没有图为 null。`readMinutes`：`max(1, ceil(char_length/400))`。只在第一页返回 `total`，即符合当前筛选条件的已发布篇数。`q` 的搜索范围加上作者昵称 |
| `GET /api/tutorials/:id`（详情） | `coverSha`、`readMinutes`；`refs` 对 markdown 稿件也返回（图片列表）；`X-Robots-Tag: noindex`；成功读取时 `view_count + 1`（尽力而为，失败不影响响应，也不改 `updated_at`） |
| `GET /api/tutorials/mine` 和 `/mine/:id` | `needsHuman`、`reviewSource`、`viewCount`、`coverSha`、`readMinutes` |
| `GET /api/public/config` | `feature_community_blog` |

### 6. 管理端

- 新增 `GET /api/admin/tutorials?status=pending|approved|rejected|takedown|withdrawn[&needsHuman=1]`：
  - status 是 pending 时按 `created_at ASC` 排序，其它状态按 `reviewed_at DESC NULLS LAST, id DESC` 排序，用游标分页。
  - 每行带 `authorName`、`imageCount`、`bodyChars`、`needsHuman`、`reviewSource`。
- 原有的 `/api/admin/tutorials/pending` 保留，旧管理页还在用，PR-C 再切换。
- review 和 takedown 都写入 `review_source='human'`、`needs_human=false`。

### 7. 不在 PR-A 范围

- AI 审核、站内信：PR-B。
- 前端：PR-C。
- 被驳回或撤回稿件的图片回收：`gcOrphanTutorialBlobs` 目前没有调用方。新上传的图在投稿绑定之前没有 ref，这个函数必须排除 30 天内有上传记录的图，PR-A 一并改掉，以免以后有人接上调用时误删草稿图。

### 8. 测试

- **单测**：魔数判定、图片引用解析（外链、超 20 张、重复、短 sha）、扫描占位、readMinutes。
- **integ**：新增 `communityBlog.integ.test.ts`，登记进 nightly 梯队（和现有 tutorial integ 同层），内容包括：
  - 上传：png、webp、jpeg 转 webp，去 EXIF 断言，SVG/GIF/伪装格式被拒，10MB 上限，200 张/天的 429。
  - 投稿：他人的图被拒；20 张上限；外链图被拒；50000 字中文能投稿；5 篇/天、3 篇待审的 429。
  - 预览授权：本人和管理员可读，其他人 404；未通过的稿件公开 embed 返回 404，通过后 200；下架后 404。
  - 迁移：旧行满足新约束；needs_human 约束生效。
- **现有测试**：现有 tutorial integ 和 unit 全部要通过。本地在 v5-dev 实跑 commercial unit、相关 integ，以及 `npm run typecheck`、`npm run lint:migration-order`、`npm run lint:integ-tiers`。

## PR-B / PR-C 概要（各自开工前再细化并送审）

- **PR-B**（2026-10-22 实施时调整，见下）：
  - `tutorialModeration.ts` worker 用租约认领（每篇一个作业），可重试，判定写入 `community_tutorial_moderations`（迁移 0321，`order-dependency: 0320`）。
  - 判定保守：全部为否且置信度 ≥0.9 才自动通过；任一为是且置信度 ≥0.9 才驳回，理由用模板；其余情况转人工。出错时绝不自动通过。
  - 稿件只作为数据传给模型，命中注入特征直接转人工；站内信通知（AI 与人工审核共用）；`OC_TUTORIAL_AI_MODERATION=off|shadow|on`。
  - **正文模型改为平台 deepseek-v4-flash**（`fetchPlatformFlash`，与市场 AI 审批同一通道），不用 JEV：实测平台 Vercel AI Gateway 账号是免费档，`typesafe-ai/jev` 对任何请求都回 403 "Free tier users do not have access to this model"。因此不再抽 JEV 共享模块，gateway 不动。
  - 顺带修：`openCodeGoAuthHeaders` 缺 `x-opencode-session`，OpenCode Go 自 2026-09-07 起回 400 MissingSessionID 且不触发回落，平台直连调用恒失败；补上与真实流量同源的会话头。
  - 图片用平台 Grok 订阅账号的视觉模型（`grok-build`），`OC_TUTORIAL_MODERATION_VISION=off` 时带图稿件转人工。
  - 20 篇中文样本实测（真实模型）：18/20 与预期一致；2 篇偏差都不是放过违规（一篇低质 0.85 转人工，一篇提到付费工具的经验文 ad=no 0.90 自动通过）。
- **PR-C**：按 `design/after/` 的 12 张图实现：
  - 教程中心「经验分享」页签和侧栏入口；
  - 列表、详情、分栏编辑器（拖拽、粘贴、点击上传，前端压缩为 webp）；
  - 我的投稿，管理端四个子页签；
  - 亮暗两种主题；390 和 1440 两种宽度；
  - `npm run test:web-react` 全绿。
