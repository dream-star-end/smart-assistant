---
name: research-tournament
description: 用"锦标赛辩论"挑最优方案/假设/综述提纲:生成 N 个候选 → 两两评审(pairwise judge)→ 用 `oc-rank` 算确定性 Elo 排名 → 从胜者综合(融合亚军亮点)。解题空间大、要在多个方案里选最优时使用(对标 Google AI co-scientist)。
tags: [research, tournament, debate, ranking]
---

# research-tournament 锦标赛辩论(CC 原生编排)

当方案/假设/提纲空间大、一次产出不够好时,用锦标赛比"一次到位再改"更稳。编排走 CC 原生
(delegate/team),**排名走确定性 `oc-rank`**(不让模型心算 Elo,必错)。

## 流程

1. **多候选**:从不同角度(如 MVP 优先 / 风险优先 / 用户优先 / 新颖优先)用 delegate_task
   生成 N 个候选(N=3~6),各给一个稳定 id(c1…cN)。
2. **两两评审**:对候选两两配对,用 delegate(可换不同评审视角:正确性/可行性/新颖性)判
   每对胜负,收集成 `matches.json`:
   ```json
   {"items":["c1","c2","c3"],"matches":[{"a":"c1","b":"c2","winner":"a"},{"a":"c1","b":"c3","winner":"a"},{"a":"c2","b":"c3","winner":"b"}]}
   ```
3. **确定性排名**:
   ```bash
   oc-rank elo --matches matches.json
   ```
   输出 `{ ranked: [{id,rating,wins,losses,draws}] }`,`ranked[0]` 即胜者。
4. **综合**:以胜者为主干,把亚军/季军的亮点择优 graft 进去,产出最终方案。

## 规则

- 候选要真有差异(别只是措辞不同),否则锦标赛无意义。
- 评审 prompt 给明确判据(不是"哪个看起来好"),并尽量用多视角评审分散偏差。
- 候选数别爆:N≤6、配对数 ~N²/2;大了改用 swiss/分组,别全配对刷爆 delegate。
- 锦标赛挑的是"方案/内容";最终方案里的**事实仍须经引用接地**(oc-litrag/oc-cite)。
