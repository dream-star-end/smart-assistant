# OCV5-198 已验证 Box 中转的最小产品接线

## 目标 / 当前证据
只给已明确选择Box中转的Cursor session账号接通现有CursorSandAdapter→本地CCB→CursorSandRelay；工具仍在本机，Sand额度不回落普通Cursor。197已真实验证Box中转nonce和本地工具协议往返，host2639c0ac...、module a4faf906...；原502是req.close误取消，已修。生产目前仍直连api2，尚未接线。

## 最小架构（不迁表、不复制密钥库）
账号session/refresh保持既有PG AEAD存储→root不可变pool generation；不改账号内容、不refresh。新增root-owned、0600的 /run/oc/cursor-auth/.sand-box-policy.json（宿主既有持久authDir）作为唯一**非秘密传输模式配置**：version1，accounts[{accountId,subjectHash,machineHash}]。只启用账号19，哈希由已向官方验证的当前JWT.sub/稳定machine派生；不含任何Bearer。缺文件/不在名单保留原Sand直连，配置损坏/身份不匹配明确失败，不降级。非Sand/非session、外接API路径不受影响。该文件不改现有池元数据/权重，materializer已核只管理自己已知文件，发布前再确认此新文件不会被覆盖。

Box gatewayToken/networkToken不新落盘：已有选中账号accessToken经现有专用出口调用官方GetSandBoxRunState，只接受RUNNING；再正常EnsureSandBox取得descriptor。**不自动为ABSENT/SUSPENDED账号创建/唤醒Box，不安装或升级Box**。RUNNING检查和Ensure非事务，极小竞争窗口仍可能由官方ensure恢复实例，明确只在用户已opt-in的自有Box连接路径发生。要绝对禁止服务端并发创建不是现有API可保证，本方案不虚称。descriptor仅内存、按当前完整access-token hash绑定、TTL60s；401/403仅失效缓存，不重放当前推理。下一次请求重新连接。原账号JWT仅发api2控制面，不发Box；gateway Bearer仅发本账号descriptor，专用inference票仍留Box。

## 冻结源码/配置范围
- packages/gateway/src/engine/cursorSandBox.ts（新）：policy只读校验、JWT主体/机器绑定、官方control与descriptor resolver、有限响应读取/超时、URL与header规则。
- cursorSandRelay.ts：可选accountId接线，sendInference在policy启用时仅替换目标/网关鉴权，保留原编解码、取消和错误语义；Box错误无普通路由fallback/无同请求重试。
- cursorSandAdapter.ts：把已选中的accountId交给relay；CcbAdapter/用户工具循环不改。
- 相关精准单测/真实adapter harness；docs本计划与操作说明；scripts/cursor-sand-box-relay下持久Box模块及精准测试/非秘密policy安装器。无web/protocol schema/commercial/storage/migration改动。
- 将197审查过的Box模块移为可维护脚本，实验单并发/180s改成产品明确界限：最多4条并发，单请求总时限30分钟、64MiB请求体、正常流式背压/断开即取消；不改token获取/路由/授权。本次仅对已有module做精确备份+替换+Box单进程reload，不重新注入host，不升级2599172。

## 关键合同
1. 默认读配置路径固定，sudo cat固定路径+LC_ALL=C；仅明确ENOENT代表未配置，权限/超限/损坏失败；原始stderr/配置内容不输出。配置上限16KiB、version/账号数字/64hex哈希严格校验，重复账号拒绝。
2. opt-in必须session，原读取器核不可变generation/slot keyFingerprint。JWT实际type=session、有效exp及sub，subjectHash/machineHash吻合policy；当前账号id来自已有root selector，不由消息体控制。缓存按当前完整token hash绑定，绝不跨账号、跨token共用。
3. 控制面固定https://api2.cursor.sh、Sand0.44 header+稳定checksum，15s含响应体、64KiB上限、TLS验证/禁redirect、仅这两个RPC。RUNNING才Ensure，响应gateway须https且*.cursorvm.com，无userinfo/query/hash，拼接保留base path。网关票/网络票限长无控制字符，不保存完整control响应。
4. 推理给Box仅Connect必要头/请求ID与descriptor network header/gateway Bearer；原account Authorization/checksum/Cookie不传Box，目的URL不可来自用户请求。Box出错不改model/额度，不复用普通Cursor。路径404提示中转未就绪、控制auth失败独立提示，不误要求换账号重登。
5. 控制连接不做共享带首请求signal的inflight promise，避免一个调用取消误杀另一个；正常短TTL缓存可以并发生成同账号descriptor。clear只清当前用过的缓存对象，旧401不抹较新连接。每个控制操作deadline和abort监听finally清理。

## 验收 / 生效 / 回退
先同Codex方案PASS→实现→相关gateway typecheck/测试与Box并发/长时限配置测试→完整diff审查→真实CursorSandAdapter+实际CCB在隔离工作目录读写随机文件并正确回传→正常平台入口验证。Mock成功/旧197测试不能冒充CCB或UI恢复；测试记录真实入口、调用计数、模型/工具结果、取消/401/404失败面。Box返回Connect error需使用真实error结束帧，不再以{}冒充。
正式平台代码按selfhost官方列车，commit立即push；串行合入前fetch核tip、门禁、发布锁与在飞会话检查；搭车用lease register，禁止为测试重启他会话。root非秘密policy安装时核当前账号/完整tokenHash+machineHash，原policy先备份，原子写并chmod600；不向generated/argv写Bearer。Box模块先备份旧SHA、语法校验、其他Bot idle、只重启已核hostPID；异常即还原旧已工作模块，不盲重试。
回退平台candidate走官方路径；单独移除账号19 opt-in可回到原直连语义（原直连仍可能unauth，不能称功能恢复）；Box正常Bot功能不应受影响。未完成生产接线/发布就不关父192，不说Sand模式已修好。

## 方案审查B1闭合：Box故障不能污染账号健康
Box gateway 401/403与本地容量429必须成为带固定CURSOR_SAND_BOX_*标记的传输错误：Relay给CCB 400 invalid_request_error + x-should-retry:false，当前请求不重放；Adapter优先将该标记归为ENGINE_ERROR/status=error，既不recordResult(fail)也不recordResult(ok)，不输出cursorSlotResults，不触发池冷却/轮换。Box身份policy/未初始化/路由404/网络错误同属此类，不因文案含auth/credential误判。官方api2控制面401/403保留既有CURSOR_SAND_AUTH_*账户失败路径，真实上游quota保持原行为。
Box模块对真正收到的上游HTTP响应新增固定x-oc-sand-box-upstream:1（由模块自身写，不从上游或客户端透传）；本地错误没有此头。Box推理鉴权错误（含HTTP200的Connect unauthenticated结束帧）与HTTP401/403不论此头均属推理票/连接问题，不当成账号JWT失效；无该头的429为Box容量错误，有该头的上游429及正常Connect错误帧保留原上游分类。标记只影响此可选Box模式，不改变直连账号/普通Cursor路径。
验收：真实CursorSandAdapter错误处理链分别注入Box401/本地429标记，断言无账号结果写入/无轮换；下一独立请求仍绑定同账号，401后重新取descriptor，容量错误不抹有效descriptor；控制面401/真实上游quota仍触发原失败路径。补测上游429标记与未标记区分、x-should-retry:false/400无CCB重放。
