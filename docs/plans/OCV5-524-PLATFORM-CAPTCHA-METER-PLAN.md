# OCV5-524 平台免费验证码推理限额/计量（写码前）

用户16:46授权商业插件首期免费安装限资源；非OpenAI平台VLM优先，禁止暗扣用户钱包。当前officialCaptchaReader仅fetch后随机requestId+sink，崩溃前无durable admission，不能约束跨进程超额。该批仅补平台支出资源边界；不开route/listing、不读实际key、不调用供应商，不调整任何发布门。

新增server-owned PostgresPlatformCaptchaMeter（具体名可等价），由已鉴权平台入口以后以userId+operationKey闭包创建。构造参数不来自模型，不接受任意URL、凭据/图像/答案。使用现有getPool/tx；现有literatureProxy是DeepXiv公共接口，Redis日cap只能参考，不能冒充本账号站点驱动。

持久化新表literature_captcha_requests：UUID request_id PK，user_id FK users（删除用户级联），operation_key<=128安全ASCII，provider只anthropic/google，model<=128严格已有prefix，created_at DB时间，outcome nullable固定枚举，finished_at，六个nullable整数usage分量。无accountId FK：operation可能在首次账号尚未绑定前发生，不能伪造connectionId。provider/model/usage是审计元数据，不含cookie/key/image/answer/username/password。usage全空代表未知，不能记成零或宣称准确账单；不存假货币成本。created_at和user/date索引支持count。

稳定requestId移到外发前生成。official adapter必须新增beginPlatformUsage依赖（和finish一样绑定receiver），所有图像、fresh route和key校验完成后、fetch前成功await begin({requestId,provider,model})。begin开启短DB事务，固定命名advisory xact lock串行化所有该服务admission，DB UTC日窗COUNT所有已预留记录（含拒绝/失败/未完成）并比较server-owned默认全局500次/日、用户20次/日、同用户operation4次/日；limits仅受信构造输入且有硬上界。未超限INSERT后COMMIT；失败/超限/同ID重复均不能fetch，不把重复begin视为可重发许可。

不拆admit/dispatch两阶段：成功begin本身就按“可能已派发”占额度。即使随后signal取消、进程在fetch前或响应后崩溃，也不退当日额度；宁可少用一次，不可能因自动过期释放再超发。无sweeper/自动refund/重启重放。没有宣称严格全局并发或货币budget；并发仍受login进程内16上限，日请求quota跨进程/重启。跨日旧行不占新日额度。

每次真实fetch仍至多一次。finally沿原refusal优先规则finish同requestId：校验owner+operation+provider/model、行存在，锁行；首次finish写固定结果/计数，完全相同重放幂等，冲突重放或跨用户事件拒绝且不改行。数据验证只抛白名单LiteratureError。finish失败不退reservation，普通答案须sink成功才返回；供应商明确拒绝仍立即返回锁存，其异步sink失败最多留下未知reservation，不允许绕到别的云provider。reservation崩溃窗口由DB行保留，“完整供应商usage入库”仍非保证，不建假持久化消息队列。

新增迁移候选0313_commercial_literature_captcha_requests（实现前再查canonical/PR冲突；个人0310–0312已占）。只加新表，含rollback文件；不apply生产。按现有migration-order规则声明与0310–0312模型迁移无schema依赖，requiredMigrations登记，不改脚本/门禁/CI规则。任何未来商业apply前必须确认较小号候选均已落地/排序，不能先apply0313卡住老号；本轮不进入发布队列。元数据登记只表达本新表依赖，不改变旧门行为。

测试：official reader合成fixture新增begin-before-fetch、begin拒绝零fetch/零health、同requestId finish、延迟begin取消不外发、class receiver；保留全部原API/拒绝/限时测试。新增dedicated _test数据库integ文件（useDedicatedTestDatabase首个注册hook，REQUIRE_TEST_DB=1，不skip当通过），重放真实全迁移；并发竞争恰好达到global/user/op cap、unknown reservation仍占额、重复begin不允许重发、UTC跨日、finish相同幂等/冲突拒绝/跨租户拒绝、无敏感字段、rollback仅移除本表并可重apply。注册现有PR integ manifest，不能加skip/降min-tests/改CI门。只跑对应新integ+原三个unit文件，先wait-for-trains再commercial mutex；typecheck/Biome/SQL/lifecycle/migration-order/integ-tiers和托管CI。独立diff审查，必要真实反例红绿证明。

实际HTTP站点parser当前35efb7c0b批需先完成其frozen红绿/匿名GET，期间不动工作树；只有它完成后才开始本批源码。凭据文件路径尚未收到，账号绑定事务、诚实HTTP artifact/driver、UI、身份判据与检索下载仍未接线，不能称插件已可用。该批完成后写handoff和PR，继续以真实账号适配为下一集成点。

预审APPROVED后的两条收紧细化：user FK采用ON DELETE SET NULL保留匿名global计数，不能CASCADE让删除用户重置global预算；同user+operation上限按operation全生命周期计数，即使跨UTC午夜也不重置。其余global/user仍UTC日窗。后续diff审查/PG测试必须覆盖这两条具体反例。
