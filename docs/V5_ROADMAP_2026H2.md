# V5 商业版开发演进路线(2026 H2)

> 制定:2026-07-05。基线状态:v5 灰度运行于 kl-mirror(单机,与 v3 同机共库),canonical `feat/v5-aurora-rewrite`,逐用户 cutover 迁移引擎已就位(inert)。
> 原则:**上线前一次做对**(v5 未全量 = 最后的重构窗口);每阶段有明确出口条件;架构债显式偿还,不许静默滚动。
>
> **进度登记 2026-07-06**:全量 cutover 完成(199/199 零 error),P0 已收口(两波上线 e5f0ff0b / d84ffd61 + 归因修复 4080b2c8)。boss 决策四条:① **Codex 审查不再强制**(AI 全权负责质量,重大计费/安全面自行判断送审);② codex 账号池扩容、异 DC 热备**推迟(后续再说)**,风险保留登记;③ 消息通道:个人微信 iLink 不平移;企业微信接入**同日二次口径改为暂缓**(架构调研已完成归档,企业主体已有但未认证);④ 执行顺序 = **直接开始 P2**(登记债优先)。

---

## 现状盘点(已具备的能力)

- **底座**:Aurora 单底座重构;channel 隔离(控制面权威 OC_RUNTIME_CHANNEL);egress 独立进程(重启不断流+自动续写);重启断流根治。
- **引擎**:EngineAdapter 可插拔(CCB + Codex 官方 OAuth/egress 账号代理/遥测封堵);OpenCode Go 静态 provider(qwen);MiniMax 检索。
- **商业化**:双钱包订阅计费(期内桶+持久钱包+升档)、turn 免单、支付回调跨轨根治、首页/登录/套餐。
- **产品面**:AI 市场(技能+智能体+审核+发布闭环+自进化 evals)、预设助手(编程/办公/科研)、轻量团队模式(+隐藏审查员)、科研子系统(引用接地)、GitHub 绑定、站内信、管理中心、admin 后台。
- **迁移**:v3→v5「切换即迁移」三层引擎(L1 共享 PG / L2 sessions.db / L3 卷 rsync),`cutover <uid>` 逐用户灰度。
- **工程**:deploy-v5.sh 独立 lane、runtime image 流水、smoke fail-closed、遥测(显式开关)、V5_DEV_PLAYBOOK 工作流体系。

---

## P0 — 灰度收敛与质量闸门(现在 → +2 周) ✅ 已收口(2026-07-06)

目标:**灰度用户体验达到"可全量"标准**;把"能上线"变成"敢全量"。

1. ✅ **真机回归闭环**:iPhone 键盘视口修复、鸿蒙 ArkWeb 附件选取(FileList 快照)等已上线并通过真机验收(2026-07-06);清单已固化为 `docs/V5_DEVICE_TEST_CHECKLIST.md`,每次前端批次上线后过一遍。
2. ✅ **灰度扩量**:被全量 cutover 直接达成(见 P1.1,199/199 零 error),分批观察节奏不再适用;全量后的常态关注面 = Caddy access log 错误率、/api/client-errors 上报、计费对账(usage_records vs journal)。
3. ✅ **监控告警最小集**:已上线(e5f0ff0b,`docs/V5_MONITORING.md`)——unit 存活/healthz/水位探测 + 计费异常检测 + 容器池水位;systemd timer 已 enable(**不在 deploy 脚本内,换机需手动装**)。
4. ◐ **运营位补齐**:github 残余直连已封堵(insteadOf + bare 仓 safe.directory,d84ffd61);codex 官方账号池扩容**推迟(boss 2026-07-06:后续再说)**——池空 fail-closed 拒服务的风险保留在风险登记,放量提速前必须回头补。
5. ✅ **回归自动化**:CI 基线失败集门已固化(`docs/V5_CI.md`),push 即跑 typecheck+四层测试。
6. ✅ **团队功能止血**:诚信三连 + delegate 计费打标(迁移 0104)已上线(e5f0ff0b);委派失败主因治理 = delegate 资源闸有界排队(d84ffd61);团队/委派成本积分归因到队长行(4080b2c8);微信死开关隐藏诚实化(f0041dbc)。

出口条件:除「账号池有冗余」随 P0.4 推迟外,其余全部达成。

## P1 — 全量切换与 v3 收敛(+2 周 → +2 月) ◐ 核心目标已提前达成

目标:**v5 成为唯一现网**,v3 进入只读维护。

1. ✅ **全量 cutover**:2026-07-06 完成,199/199 用户零 error;12 活跃用户 v3 卷保留 3 天回滚窗(driver `/root/cutover-drive.sh`)。
2. ⏸ **消息通道:企业微信接入暂缓(boss 2026-07-06 二次口径:先不搞,直接 P2)**。已沉淀待复活时直接开工:
   - v3 个人微信 iLink **不平移**(v5 侧死开关已隐藏诚实化 f0041dbc;iLink broker 全链代码在 v5 树里但被 runtime_channel 双重硬关+启动期 fail-closed 拒启)。
   - v3-wechat 架构与 v5 接入点调研**已完成归档**:`/root/openclaude-scratch/v5-wecom-channel-research-2026-07-06.md`。核心结论:跨进程通道骨架(master broker + 容器 sink + outbox 状态机 + session pointer + 网页兜底)模式可复用,但存储 schema(`wechat_*` 表无 channel 列)、渲染器(微信语义硬编码无 capabilities 入参)、context_token 模型均与 iLink 深耦合——接企业微信须新写协议客户端、渲染器 capabilities 化、表加 channel 维度。
   - 企业主体现状 = **已有企业但未认证**(若走「微信客服」形态需先认证,自建应用/群机器人可立即用)。
3. 🔄 **v3 退役计划**:已启动——停新注册(新号 v5 原生 b8fb9689)、Caddy 默认路由翻 v5、旧容器随 cutover 回收、磁盘 84%→38%;剩余:bridge-pin、v3 master 停服时点、共享库 v3-only 机制(控制面 scheduler 等)清理、Caddy @v5user 分流简化。
4. ⏸ **多机扩容/异 DC 热备:推迟(boss 2026-07-06:后续再说)**。风险不消失:全量后单机 kl-mirror DR=0 已是现实;复活触发条件 = 用户/收入显著增长或任何一次单机事故,届时套用 v3-master-hot-standby-migration SOP(compute-pool 模型、volume 迁移/drain 工具 v3 已有);近期至少做一次 PG/sessions.db/用户卷的备份恢复演练。
5. **变更节奏制度化**:未启动,随 P2 批次逐步落地(固定发版窗口 + 面向用户 changelog + smoke;Codex 口径见「持续性红线」更新)。

出口条件:「100% 用户在 v5」已达成;「异 DC 可切换」随 P1.4 推迟;「微信通道决策落地」已达成(企业微信专项)。

> **当前执行顺序(boss 2026-07-06 二次口径)**:直接开始 P2(三项登记债优先)。企业微信、账号池扩容、异 DC 热备、v3 退役收尾均暂缓,按需插入,不阻塞主线。

## P2 — 架构债偿还与体验深化(+2 月 → +4 月) 🔄 当前主线(2026-07-06 启动,登记债 1/2/3 先行)

目标:把灰度期"止血"的部分升级为"根治";体验从"能用"到"顺手"。

1. **团队卡 server-authored 一等公民化**(登记债):sink 持久化 agent-group/delegate-progress 行,撤销 parser 过时排除;跨设备团队历史打通;顺带把 `_masterHistoricalMessages` 注入语义与前端显示对齐(模型"记得过程"可选)。
2. **hidden reviewer pipeline 硬编排**(登记债):review 从队长自觉 delegate 升级为 gateway 代码编排的 review pass;结构化 verdict(PASS/NEEDS_FIX 协议字段);迭代/预算代码封顶(替换现在的次数熔断);审查发生与否落 runLog;**审查成本对用户可见披露**。
2b. **团队功能产品化**(2026-07-05 评估 P1,对照业界共识"读扇出写收口/effort 分档/计划先行"):委派前 plan 卡(拆解+派给谁+成本量级预估,用户可批改);effort scaling 分档写进 preamble+普通成员串行硬上限;委派上下文结构化(大产物落文件+回传 1-2k 蒸馏摘要,绕过队长转述失真);共享任务看板(协调机制兼进度 UI);回放/分享链接;landing 团队演示与实际能力对齐。业界参照与 Top10 机制清单见当日评估调研(Anthropic multi-agent research/Claude Code agent teams/OpenAI Agents SDK/Manus 等)。
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

- v3 现网零影响(直至退役);共享库迁移永远人工受控(属重大面,默认仍建议送 Codex)。
- 每个批次:测试实跑 + 生效面矩阵分类部署 + smoke,缺一不发。**Codex 口径变更(2026-07-06 boss)**:不再强制每批 Codex PASS,AI 全权对质量负责;重大计费/安全面改动自行判断是否送审。
- 文档随事故与新机制**当场更新**(V5_DEV_PLAYBOOK §6)。
- 架构妥协必须显式登记(债表 + 触发条件),禁止把临时方案包装成最优解。
- **任何优化改动不得降低用户体验(boss 2026-07-06)**:方案阶段显式回答"哪个场景可能变差"并带缓解;限流/封顶类默认宽松+撞线给结构化引导+env 可回滚;性能优化带体验对冲(如懒加载配 idle 预取);验收清单含 UX 回退面审查。

## 风险登记(定期复盘)

| 风险 | 现状 | 缓解 |
|---|---|---|
| 单机单点(kl-mirror) | **v5 全量后 DR=0;异 DC 热备已推迟(boss 07-06)** | 触发条件 = 规模增长或单机事故 → 复活 P1.4;近期先做备份恢复演练 |
| codex 官方账号池薄 | **扩容推迟(boss 07-06);池空 fail-closed** | 池水位已入监控告警;放量提速前回头扩容 |
| 上游模型渠道波动(Ark/MiniMax/Go) | 人工切换(admin 运维页已有延迟探测器) | P3.2 健康度自动降级 |
| 强模型退场后的工程质量 | 本手册+分工体系承接;Codex 不再强制(07-06) | 铁律三条(不猜/找权威源/完成定义)+ 重大面自行送审 |
| 消息通道缺口 | 企业微信接入暂缓(boss 07-06 二次口径);调研已归档 | 复活时按 P1.2 调研档直接开工 |
