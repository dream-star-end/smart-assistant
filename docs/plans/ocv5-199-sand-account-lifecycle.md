# OCV5-199 · 账号池 Sand 生命周期（T2，B1/B2修订待复审）

## 用户合同 / 范围
新增、重加、激活 Sand 账号后自动准备，原聊天/本地 CCB 工具操作不变；准备中不得进入可选池或普通额度回落。停用/删除按现有入口撤销可选资格与绑定，不销毁 Box/用户数据，不取消其它 Bot。正常 API-key/普通 Cursor 不受影响。仅 selfhost 开启；商业默认关闭。198 已合入5975d21c并登记发布，禁止改其live或重复推理。

## 已有接线与需修缺口
- admin/accounts.ts create/patch/resetCooldown/delete 均调用 scheduleCursorAuthSync；index.ts cursorAuthSync 是 leaderBundle 单 writer。
- cursorMaterializer.ts 373/431 空池仍保留旧文件，最后账号关闭/删除会残留可用槽：本范围必须改为明确的空代/空旧投影；真正读库/解密失败不能冒充成功清空。
- scheduleCursorAuthSync 在 in-flight 时丢触发：改为dirty trailing run，避免删除与准备完成交错后旧快照复活。
- getCursorTokenSnapshot 仅用于读取现有AEAD账号，不写token/refresh。listAccounts默认100，需要按既有limit/offset完成Cursor页扫描，防只处理首批。

## 最小产品结构
1. 新 cursorSandLifecycle.ts + cursorSandProvision.ts（commercial/account-pool），由现有leader启动独立、有界后台准备循环；不在同步物化/HTTP管理请求里等待分钟级云任务。管理端保持原按钮，响应额外非秘密 `cursor_sand_box` 状态 preparing/ready/error + 固定错误码，在原Sand badge位置展示，不造新全局通知面。
2. 持久状态在已存在root authDir内单层 `.sand-lifecycle` 文件/目录，原子写+fsync文件及父目录；只有主体/机器/凭据哈希、账号ID、准备版本、自己的Bot ID、clientNonce、阶段、下次重试时间，无Bearer/refresh/完整descriptor。按主体去重Box操作，同主体新账号重新校验后可复用。发布前后状态兼容，不以扫描用户进程secret补票。
3. session用既有稳定machine；api_key沿既有官方 /auth/exchange_user_api_key 得临时账号token，主体/exp必须合法且控制面准入，机器ID初次生成后持久固定，不写回api-key或换普通账号。若该凭据/权益不支持Box，显示明确错误，不假称支持。API-key机器ID可仅放非秘密policy条目，gateway resolver在该kind用条目机器ID，不改原slot凭据格式。
4. active+Sand才准备：读取最新账号状态/凭据 → GetSandBoxRunState → 正常Ensure（用户本轮已授权创建；503先重查state，绝不force重建）→ 内存descriptor校验HTTPS cursorvm、保留base path、no redirects、现有账号/平台代理。读取现有Box是否忙；忙则退避，不重启它。
5. 增加已审relay同一路径的显式能力probe（POST、自有header、空body，经过原gateway鉴权及模块鉴权），返回安装版本/源hash/当前并发数，不取推理token、不发上游。旧模块不认识probe时可能走空Connect控制路径，不能把它称零远端调用或生成成功；首次只检查一次，旧返回不视为ready。
6. 未安装才通过官方gateway创建/复用专属维护Bot（不选用户active Bot），发送精确bytes/hash的已审确定性installer+module，不让模型生成补丁。完整intent和nonce先持久化，响应未知只查接受状态/专属Bot名单和probe，禁止换nonce盲重发。accepted后等待probe就绪，不把Bot文字当验收。新进程只靠持久状态恢复，不重复建Bot/发安装。
7. installer支持当前四个已核源码锚点（handleRequest鉴权、route分支、authExtension注册、normal createNodeHttpClient）；唯一匹配+上下文固定才安装。保留源hash/备份、模块hash、node --check、原子替换；只在idle时TERM自己已核host PID；未识别布局停止并输出固定版本不兼容状态，禁止force/升级/扫描secret。既有198 hook只换模块，不重复注入。
8. 只有probe确证、账号仍active+Sand、最新凭据主体/机器绑定一致时才标ready；worker不直接写槽。materializer唯一写 `.sand-box-policy.json`（managed标志+当前有效ready条目）和新代；准备/停用/删除均不产生可选Sand槽。managed模式gateway对缺绑定session/API-key Sand fail closed，不能滑回旧直连。旧已审policy兼容且由第一次正常reconcile接管。
9. 删除/关闭不删除远端Box或Bot；已经被远端接收的维护任务可能完成，但其过期结果不能让账号重新可选。新请求不继续使用删除账号凭据。stop leader取消本地HTTP/计时器，未知远端操作保留intent不声称取消成功。
10. 普通账号token和健康/额度字段保持原逻辑；新增状态不能复用last_error污染账号健康。

## 冻结触碰面（允许实现时缩减，不扩大相邻业务）
commercial/account-pool/cursorMaterializer.ts、同目录新lifecycle/provision/state helpers及测试；commercial/index.ts启动/停止；admin/accounts.ts触发与http/admin/accounts.ts非秘密状态序列化；gateway/engine/cursorSandBox.ts及精准测试；scripts/cursor-sand-box-relay/relay.cjs+installer及测试；web-react/admin/pages/accounts/{types,cells}.tsx/ts及浏览器测试。无DB迁移，无凭据库改写，无其他引擎/商业上线。运行开关只selfhost持久配置。

## 验收（先业务断言，非mock计数替代）
- 真正syncCursorAuthDir+真实FS+真实wrapper选择：新增pending不可选，ready可选；停用/删除最后一项得到空池；重加id变化和主体/机器变更不串号；删除与完成交错不复活；>100账号跨页覆盖。
- 真实loopback控制/Box HTTP协议：一主体一intent、503后读state、响应丢失新进程恢复不重复发送；忙Box零安装；probe不取推理票/不发Stream；不同主体错票/redirect拒绝。
- installer基于原始已核锚点fixture，重复执行no-op，错锚点/错hash/语法失败不改live文件；模块实际nodeHTTP测试验证鉴权/取消/4并发仍通过。
- 管理端真实浏览器原按钮新增/停用/激活/删除，显示preparing/ready/error；支持凭据无额外脚本操作。
- 真实账号范围验收不删除/停用用户正在用的账号或重复198 smoke；必要的受控生命周期验证先用隔离存储，发布后正常入口一次确认。未有第二个授权账号时如实标明新账号真实远端创建边界，不能用fixture冒充。
- 同一Codex方案→完整diff→合理blocker增量至PASS。最后按正式selfhost列车发布，callback核用户runtime/入口。

## 首轮审查闭合（仅B1/B2与一条建议）
- B1容量：policy消费上限从16KiB明确调整为2MiB，最多4096条、限制每字段既有长度；writer和parser共守容量，紧凑JSON写前校验字节数，超限拒绝本次物化而不是写一个所有reader均读不了的文件，也不静默截断选择池。验收使用101个真实ready条目经gateway实际readCursorSandBoxPolicy路径读取，首/尾账户resolve都能绑定；再覆盖超过字节/条数上限的明确失败。不是只验证扫描循环。
- B2 owner epoch：现有materializer scheduler改为每次start独立owner/epoch，所有生产sync从该owner捕获publishAllowed。stop立即撤销owner、取消timer/dirty并返回本实例in-flight drain；旧调用每次await后、尤其所有副作用与最终同步写入前校验owner，失效不发布。scheduleCursorAuthSync在没有活actor时只记录待处理dirty、不得启动无主writer；新start消费当前需求，旧finally不得清空新owner状态。依赖注入的直接sync测试/显式诊断保持可调用，但生产不得绕过owner。验收挂起旧sync→stop/start→新owner空池生效→释放旧sync，旧槽和policy不复活；stop后管理触发零写，重新start才执行。
- 未知结果建议采纳：acceptance明确区分accepted/pending/rejected/not-found/unknown-durability。create响应未知只能按持久nonce对应的唯一专属维护Bot标识找回；0个或多个候选不能重建/猜测owner。超过有界观察窗显示固定恢复错误、继续安全只读对账，不无限preparing或换nonce重发。sendPrompt响应未知核接受记录和probe；记录不存在但去重保留期限未知不能当从未接收。API schema有nonce不是服务端幂等证明。

## 类型检查范围补充（已获独立审查PASS）
仅修commercial/__tests__/apiKeyMessageAudit.unit.test.ts的异步capture类型（保留非空/SQL/params/分页断言），及cursorExternalRoute.unit.test.ts合成usage补两个cache字段0；不改产品计费逻辑。旧reviewer session已过期，网关拒绝未建job；唯一新reviewer session agent:auditor:delegate:main:1788946436039:776865b379636db4后续承接完整diff。首次启用及回退必须执行README的pre-managed policy备份/恢复，不能把新大policy留给旧reader。


## C1 执行端维护修订（2026-09-09，同 reviewer 方案 PASS，待实现）
- 依据真实 supervisor 的精确消费端摘录（17301 字节，SHA256 724e90b5715e88fe64a686d6084827e1e6fc3f4c970b8712bdcff0701ae2d689），不再由 Python 无条件 SIGTERM，也不使用会暂停所有 runner 的 prepare-upgrade。
- 先完成确定性候选/语法/备份/源与 PID 复核，再发布兼容文件；新 Box 必须由绑定 PID 的源码布局确认没有既存 relay，不把 GET 404 当无 hook 证明。
- 新 Box 只提交原生 `kind: restart`，固定操作 ID、无 force/version/bundle、不覆盖现存命令；维护 Bot 正常退出，由 supervisor 最新本机 health 判闲后同步重启。restart 对 busy/unknown 一直 defer，不进入 upgrade 的六小时强推。
- 已有旧 relay 的 health 不计入 relay active，禁止主动 restart。仅安全暂存等待自然重启，并保持准备中；若发布待加载文件安全性不成立，仅留独立 staging 文件。只有新进程实际 capability probe 才能 ready。
- 需要回归：其它 Bot 在父检查后启动仍 defer；旧 relay 长流时零主动重启；无 hook 新 Box 恰好一次原生重载+新 probe 就绪。上述是方案认可，不是实现或上线证明。
