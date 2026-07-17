# `_orderSeq` 拆轴实现总结

## 基线与范围

- worktree：`/opt/openclaude/openclaude-v5-orderseq`
- 分支：`feat/v5-orderseq-axis`
- 基线：`ca32a35b7f9bc74388244d9b749fd0965b23725f`
- 未 push、未 deploy；`TASK.md` 为任务输入，保持 untracked 且不提交。
- PR#95 的持久化四态、SessionManager owner chain、Bash tail fail-closed 路由、
  前端 `_source !== 'server'` 删除判据及收紧后的 `_seq` normalize 均未改动。

## 改动清单

### storage / commercial PG

- `packages/storage/src/sessionsDb.ts`
  - 新增首次持久化冻结的 `_orderSeq` 及统一比较/派生函数。
  - `_seq` 继续只做内容版本与 `since` 增量游标；内容 patch 不再改变展示位置。
  - CLIENT PUT 将 `_orderSeq` 视为 server-authoritative，客户端伪造值会被剥离并计数。
  - PUT merge、turn 分组、phantom/plan dedup 先恢复冻结顺序；未持久化窗口使用
    `(order anchor, ts, index)` 全序。
  - chat projection 按 `_orderSeq` 排序，checkpoint/tail 投影携带 order anchor。
  - hot read 惰性派生 order；partial 仍按 `_seq > since` 筛选。
  - archive read/filter/page 改走 `_orderSeq`。
- `packages/storage/src/clientSessionsPlan.ts`
  - spill 先按 `_orderSeq` 规范数组，再从最老端搬运。
  - 物理 `first_seq/last_seq/archived_through_seq` 列保留滚动兼容名称，值语义改为 order 轴。
  - cost patch、delegate drain 保留 `_orderSeq`，只推进 `_seq`。
- `packages/commercial/src/db/pgSessionsBackend.ts`
  - PG upsert/read/partial/archive/精确 billing 与 SQLite 双轴语义对齐。
  - lossless tape 和 runtime batch 展开行继承 anchor 的 `_orderSeq`；同一 tape 仍共享
    `_seq` 增量原子单元。

### web-react

- `packages/web-react/src/lib/persist.ts`、`lib/chat/model.ts`
  - `ChatMessage` 增加 `_orderSeq`；历史排序改为统一的
    `(anchorOrderSeq, ts-or-0, originalIndex)` 字典序比较器。
  - 删除“任一行缺 ts 则整趟放弃”的旧逻辑；比较器对所有 pair 传递。
  - full/incremental/archive 三条合并路径共用新顺序轴，已归档行判断优先 `_orderSeq`。
  - PR#95 完成证据删除仍严格使用 `_source !== 'server'`，未扩大删除角色范围。
- `packages/web-react/src/components/chat/turnSegment.ts`
  - 评分卡按 `_clientMessageId` 分组；同 turn 多段正文按 `_orderSeq/ts/index` 选末段。
  - 无 `_clientMessageId` 的滚动 legacy 行保留 user-boundary fallback。
- `archivePaging.ts`、`chat/socket.ts`、`lib/types.ts`
  - 归档已加载指标、distinct tape anchor、下一页 before 游标改走 `_orderSeq`；
    旧 IndexedDB 行仍以 `_seq` fallback。

### 文档

- `docs/V5_DEV_PLAYBOOK.md`：§5 技债标记为代码已偿还、待审计/上线，并记录物理兼容命名。

## 红绿证据

先在未实现代码上补行为测试并实跑：

- storage 定向：87 条中 5 条新增场景失败（patch 后顺序、legacy 冻结、turn 分组、
  projection、spill）。
- web-react 定向：54 条中 3 条新增场景失败（真全序与两类评分锚定）。

实现后最终证据：

- `npm run typecheck`：通过，`tsc --build` 无诊断。
- `npm run test:storage`：324/324 通过。
- `npm run test:gateway`：1901/1901 通过；其中包含 PR#95 的 post-terminal tail 折叠、
  origin 归位、LRU fail-closed、shutdown drain 与四态用例。
- `cd packages/web-react && npm test -- --reporter=dot`：145 文件、1536/1536 通过。
- 关键定向组合：storage 120/120、web 69/69；后续新增 plan-order 用例后 merge 52/52。
- `npm run test:commercial:unit`（唯一允许的 mutex 入口）：命令完成。canonical 基线本次预跑为
  `4335 tests / 62 fail / 39 cancelled`；实现后为
  `4332 tests / 62 fail / 51 cancelled`。失败总数未增加，但失败集合未做到逐字节一致：新增的
  4 个顶层 suite 均在共享 PG 清理 hook 报 `40P01 deadlock detected` 后父级取消，属于该全量并发
  套件的环境波动，未触及本批文件。故 commercial 不能记作“全绿”，这里只能记作“无本批
  功能失败证据”；storage 双 backend 共享的纯 plan 与 TypeScript 契约已全绿。

验收场景覆盖：

- 重复 `_seq` 与 patch 高 `_seq` 不再影响 projection/web 展示顺序。
- client PUT 乱序不能改变已有 `_orderSeq` 或 turn/plan 分组。
- 真实 cost patch 推进早期行 `_seq` 后触发 spill，archive page + hot tail 仍按 `_orderSeq`
  精确拼回原序。
- gateway 既有主/子 agent late Bash tail 归位及未知归属 fail-closed 全量回归通过。
- 评分卡对错序数组按 `_clientMessageId` 各轮唯一锚定。

## 存量数据派生/回填语义

- legacy hot row：读时按当前耐久 JSON 数组顺序惰性赋值，从既有归档 order 水位之后开始；
  读本身不写库。下一次任意写路径执行同一确定性派生并把 `_orderSeq` 写回，此后同 id 永不改变。
- legacy archived row：归档内容已不可 patch，读取时用其既有 `_seq`/物理 chunk 范围作为兼容
  `_orderSeq` 并冻结解释；新 chunk 一律写真实 `_orderSeq`。这不尝试猜测或修复历史上已经丢失的
  原始顺序，只保证升级后不再继续漂移。
- 无新表、无 DDL、无第二套持久化协议；物理列及 wire 的 `archivedThroughSeq/oldestSeq`
  名称保留，值已是 `_orderSeq` 轴。

## 风险与未尽事项

- 旧归档若在本批前已因 mutable `_seq` 出现可见错序，兼容派生只能冻结既有物理轴，无法无损
  重建已丢失的历史顺序；如需修复具体事故数据，仍应走会话级备份/清理脚本。
- `archivedThroughSeq` wire 名未改但语义换轴，后端/storage 与 web dist 必须同批发布；旧页面在
  滚动窗口内仅有 `_seq` fallback，刷新到新 dist 后收敛。
- commercial 全量的共享 PG 清理死锁仍是测试基础设施债；本批没有修改该并发套件。
- 部署生效面（本任务禁止执行）：storage/commercial 需 master 生效，容器内 gateway 所带 storage
  需重建 runtime image；web-react 需 Vite build + dist 同步 + 重启。无 schema migration。
