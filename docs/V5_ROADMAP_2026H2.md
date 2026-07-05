# V5 商业版开发演进路线(2026 H2)

> 制定:2026-07-05。基线状态:v5 灰度运行于 kl-mirror(单机,与 v3 同机共库),canonical `feat/v5-aurora-rewrite`,逐用户 cutover 迁移引擎已就位(inert)。
> 原则:**上线前一次做对**(v5 未全量 = 最后的重构窗口);每阶段有明确出口条件;架构债显式偿还,不许静默滚动。

---

## 现状盘点(已具备的能力)

- **底座**:Aurora 单底座重构;channel 隔离(控制面权威 OC_RUNTIME_CHANNEL);egress 独立进程(重启不断流+自动续写);重启断流根治。
- **引擎**:EngineAdapter 可插拔(CCB + Codex 官方 OAuth/egress 账号代理/遥测封堵);OpenCode Go 静态 provider(qwen);MiniMax 检索。
- **商业化**:双钱包订阅计费(期内桶+持久钱包+升档)、turn 免单、支付回调跨轨根治、首页/登录/套餐。
- **产品面**:AI 市场(技能+智能体+审核+发布闭环+自进化 evals)、预设助手(编程/办公/科研)、轻量团队模式(+隐藏审查员)、科研子系统(引用接地)、GitHub 绑定、站内信、管理中心、admin 后台。
- **迁移**:v3→v5「切换即迁移」三层引擎(L1 共享 PG / L2 sessions.db / L3 卷 rsync),`cutover <uid>` 逐用户灰度。
- **工程**:deploy-v5.sh 独立 lane、runtime image 流水、smoke fail-closed、遥测(显式开关)、V5_DEV_PLAYBOOK 工作流体系。

---

## P0 — 灰度收敛与质量闸门(现在 → +2 周)

目标:**灰度用户体验达到"可全量"标准**;把"能上线"变成"敢全量"。

1. **真机回归闭环**(阻塞项)
   - iPhone Safari:键盘收起留白(已上线修复,待真机确认)、生成中上翻是否被拽底(App.tsx realign 的 sending 分支,烦则收掉)、附件/灯箱。
   - 鸿蒙 ArkWeb:附件选取(FileList 快照修复回归)、下载/上传。
   - 建立**真机验收清单**固定文档,每次前端批次上线后过一遍。
2. **灰度扩量**:boss 按 `cutover <uid>` 分批迁移(建议 5→20→50→全量节奏),每批观察 48h:Caddy access log 错误率、/api/client-errors 上报、计费对账(usage_records vs journal)。
3. **监控告警最小集**(当前几乎为零,全量前必须有):
   - systemd unit 存活(v5/v5-egress)+ /healthz 探测 + 磁盘/内存水位 → 简单 cron 探测 + 微信/站内告警即可,不追求大平台;
   - 计费异常检测(单用户单日扣费突增、免单率突增);
   - 容器池水位(并发容器数、镜像拉起失败)。
4. **运营位补齐**:v5 官方 codex 账号池扩容(池空 fail-closed 会拒服务,boss 加账号);github 残余直连封堵(低危)。
5. **回归自动化**:把本批次建立的"基线失败集 diff 法"固化进 CI(`npm run check` v5 变体),push 即跑 typecheck+四层测试。

出口条件:两周内零 P0 事故、真机清单全绿、监控告警可用、账号池有冗余。

## P1 — 全量切换与 v3 收敛(+2 周 → +2 月)

目标:**v5 成为唯一现网**,v3 进入只读维护。

1. **全量 cutover**:剩余 v3 用户批量迁移(迁移引擎已验证);迁移期间 v3 保持可回滚(users.v5_migrated_at 状态机互斥)。
2. **v3 功能奇偶补齐核查**:微信通道(iLink)、cron/任务、共享技能库运行时复用——逐项确认 v5 等价或明确宣布不带走;微信通道是最大缺口,需要专项(把 v3-wechat 系列能力平移到 v5 channel,含遥测封堵同款)。
3. **v3 退役计划**:停新注册 → 只读 → 下线;共享库里 v3-only 机制(控制面 scheduler 等)清理;Caddy 路由简化(去 @v5user 分流,v5 变默认)。
4. **多机扩容准备**(单机 kl-mirror 是最大单点):
   - 复用 v3 compute-pool 模型:master + N 计算节点(volume 迁移/drain 工具 v3 已有,平移);
   - **异 DC 热备重建**(2026-06-26 同 DC 灾难教训:DR 容量当前为 0)——v5 全量后这是 P0 级风险,套用 v3-master-hot-standby-migration SOP;
   - 备份纪律:PG(已共享)、sessions.db、用户卷的定期快照与恢复演练。
5. **变更节奏制度化**:全量后告别"随改随发"——固定发版窗口 + changelog 面向用户 + 每版本必过 Codex 审计与 smoke。

出口条件:100% 用户在 v5、异 DC 备可切换、微信通道决策落地(平移或砍)。

## P2 — 架构债偿还与体验深化(+2 月 → +4 月)

目标:把灰度期"止血"的部分升级为"根治";体验从"能用"到"顺手"。

1. **团队卡 server-authored 一等公民化**(登记债):sink 持久化 agent-group/delegate-progress 行,撤销 parser 过时排除;跨设备团队历史打通;顺带把 `_masterHistoricalMessages` 注入语义与前端显示对齐(模型"记得过程"可选)。
2. **hidden reviewer pipeline 硬编排**(登记债):review 从队长自觉 delegate 升级为 gateway 代码编排的 review pass;结构化 verdict(PASS/NEEDS_FIX 协议字段);迭代/预算代码封顶(替换现在的次数熔断);审查发生与否落 runLog;**审查成本对用户可见披露**。
3. **可见性投影收口**(登记债):isHiddenSystemAgentId 散点过滤 → 单一"用户可见视图"。
4. **移动端体验专项**:PWA(安装/离线壳/推送)评估;长会话性能(虚拟滚动);弱网重连体验。
5. **检索与知识**:科研子系统开放项(OCR/MiniCheck 外部凭证、图表提取、litrag 语义召回);WebSearch/WebFetch 质量迭代。
6. **市场生态**:技能质量分层(evals 分数外显)、创作者激励(分成?)、市场运营看板(admin hosts/accounts 水位图收尾)。

出口条件:三项登记债清零;移动端 NPS 类指标改善;市场周活跃创作者 >0(有真实第三方发布)。

## P3 — 规模化与商业深化(+4 月 → +6 月)

按届时数据取舍,方向性列举:

1. **企业/团队版**:组织账号、成员管理、共享技能库/知识库的组织维度、用量报表、发票。双钱包模型天然可扩展到组织钱包。
2. **模型矩阵运营**:provider 健康度自动探测与降级路由(现在坏 provider 靠人工);价格/成本看板;新 provider 接入模板化(v3-token-plan-provider-integration 模式泛化)。
3. **开放能力**:openaiCompat 对外 API 商业化(API key 计费面已有雏形);webhook/自动化触达。
4. **多模态深化**:图/视频生成(seedream/seedance 已接火山)产品化入口;语音(seed-tts)对话。
5. **合规与安全**:遥测/数据留存策略成文(现 OC_TOOL_FAILURE_AUDIT 已显式化,补用户协议披露);渗透测试一轮;账号安全(2FA)。

---

## 持续性红线(所有阶段共守)

- v3 现网零影响(直至退役);共享库迁移永远人工受控 + Codex 审。
- 每个批次:测试实跑 + Codex PASS + 生效面矩阵分类部署 + smoke,缺一不发。
- 文档随事故与新机制**当场更新**(V5_DEV_PLAYBOOK §6)。
- 架构妥协必须显式登记(债表 + 触发条件),禁止把临时方案包装成最优解。

## 风险登记(定期复盘)

| 风险 | 现状 | 缓解 |
|---|---|---|
| 单机单点(kl-mirror) | v3+v5 同机,DR=0 | P1.4 异 DC 热备;先做备份恢复演练 |
| codex 官方账号池薄 | 池空 fail-closed | P0.4 扩容 + 池水位告警 |
| 上游模型渠道波动(Ark/MiniMax/Go) | 人工切换 | P3.2 健康度自动降级 |
| 强模型退场后的工程质量 | 本手册+分工体系承接 | 铁律三条(不猜/找权威源/完成定义)+ Codex 审计闸门 |
| 微信通道缺口 | v5 无 | P1.2 专项决策 |
