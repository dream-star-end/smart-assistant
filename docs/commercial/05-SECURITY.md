# 05 安全设计(SECURITY)

安全不是单独模块,而是贯穿所有代码的约束。本文列出所有必须遵守的条目。PR 合并前逐项勾选。

## 1. 密码

- [ ] 使用 **argon2id** 哈希密码(`memory=64MiB, iters=3, parallelism=1`)
- [ ] 密码最小长度 8,最大 72(argon2 输入 bound)
- [ ] 明文密码**永不记录日志**
- [ ] 修改密码时吊销所有**其他** refresh token(保留当前)

## 2. JWT 与会话

- [ ] `access_token` JWT,TTL 15 分钟,签名算法 HS256(单机部署够用)
- [ ] `refresh_token` opaque(随机 32 bytes,base64url),服务端 sha256 存库
- [ ] `access` payload:`{ sub: user_id, role, iat, exp, jti }`,禁 `alg:none`
- [ ] Refresh token 绑定 user_agent + IP(变化时告警,但不强制拒绝)
- [ ] 登出:删除 refresh token 记录(或置 `revoked_at`)
- [ ] Access token 不做吊销列表(短 TTL 自然过期)
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` 从 env 注入,64 bytes 强随机

## 3. 速率限制

- [ ] Redis `INCR` + `EXPIRE` 实现滑窗,key 格式 `rl:<scope>:<subject>:<window>`
- [ ] 未登录路由按 IP 限流(`X-Forwarded-For` 链取 Cloudflare 转发的最右 IP)
- [ ] 登录路由同时按 IP + 邮箱 双维限流
- [ ] 被限流的请求写 `rate_limit_events`
- [ ] 连续触发限流 N 次(阈值可配):触发告警 + 临时封禁 IP 1h

## 4. CSRF

- [ ] 所有 **cookie-based** 写操作必须带 `X-CSRF-Token`,双 token 校验
- [ ] MVP 前端走纯 JWT(localStorage),不依赖 cookie → CSRF 风险降低但仍需:
  - [ ] 所有 JSON POST 拒绝 `Content-Type: text/plain`(防跨源表单伪造)
  - [ ] `SameSite=Strict` 所有 cookie(若未来使用)

## 5. CORS

- [ ] `Access-Control-Allow-Origin` 严格白名单:`https://claudeai.chat`(+ 开发环境 `http://localhost:*`)
- [ ] 不用 `*` 除了 `/healthz` 和 `/api/public/models`
- [ ] `Access-Control-Allow-Credentials` 仅在需要时开

## 6. HTTP Headers

每个响应都加(中间件统一设置):
```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss://claudeai.chat; frame-ancestors 'none'
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

## 7. 输入校验

- [ ] 所有 API 入参用 zod schema 校验,失败返回 `ERR_VALIDATION`
- [ ] 邮箱格式 RFC 5322 简化版,长度 <= 254
- [ ] 所有字符串字段显式长度上限(常见 <= 10000)
- [ ] JSON body 大小上限 1MB(chat message 单独放宽到 10MB)
- [ ] WebSocket frame 大小上限 10MB

## 8. SQL 注入

- [ ] **仅使用参数化查询**(`pg.query('SELECT ... WHERE id = $1', [id])`)
- [ ] 禁止字符串拼接 SQL,禁止 `format()` 拼接用户输入
- [ ] 动态表名/列名用白名单映射,不直接从用户输入取
- [ ] lint 规则禁 `query(\`...\${...}\`)` 模板字符串

## 9. XSS

- [ ] 前端所有用户内容用 `textContent` / React `{...}` 插值,禁 `innerHTML`
- [ ] Markdown 渲染用 `DOMPurify` 白名单
- [ ] 后端 JSON 响应统一 `Content-Type: application/json; charset=utf-8`
- [ ] CSP(见 6)再兜一层

## 10. 敏感数据加密

- [ ] Claude OAuth token 用 **AES-256-GCM**(`@noble/ciphers` 或 Node 原生 `crypto.createCipheriv`)
- [ ] 每条记录独立 12-byte nonce(`crypto.randomBytes(12)`)
- [ ] 密钥 `OPENCLAUDE_KMS_KEY` 从 env 读,32 bytes(base64 解码后)
- [ ] 解密后的 token 只在内存,用完立即置零(Buffer.fill(0))
- [ ] 密钥轮转:支持 key_version 字段(MVP 存单 key,预留字段)

## 11. 支付安全

- [ ] 虎皮椒回调**必须**校验 MD5 签名,签名错误立即 400
- [ ] 回调路径从代理到 Gateway,Gateway 按 `trade_order_id` 做 unique 幂等
- [ ] 回调处理在 DB 事务内:检查 orders.status → 更新 → 写 ledger,任一失败整体回滚
- [ ] **即使签名通过**,也不信任回调里的金额,从本地 orders 取金额
- [ ] 每日 3:00 对账任务拉虎皮椒订单列表 vs 本地 `orders`,差异告警

## 12. 账号池安全

- [ ] Token 存储加密(见 10)
- [ ] 添加/修改 token 的 API 路径响应**不返回 token 明文**
- [ ] 日志不记 token(即便是前缀,mask 为 `sk-ant-***`)
- [ ] Token 在内存中的变量名避免泄露(例如 log 错误时用 `String(err)` 而不是 `JSON.stringify(err)`)
- [ ] 发到 Claude API 的请求日志只记 `account_id`,不记 token

## 13. Agent 容器安全

容器启动参数(见 02-ARCHITECTURE):
- [ ] `--cap-drop ALL` 只加必要的(`--cap-add CHOWN --cap-add SETUID --cap-add SETGID` 视 base image 而定)
- [ ] `--security-opt no-new-privileges`
- [ ] `--security-opt seccomp=<agent_seccomp.json>`(自定义白名单)
- [ ] `--read-only` 根文件系统
- [ ] `tmpfs` 挂 `/tmp`(限 64MB)
- [ ] `--pids-limit 200`
- [ ] `--cpus 0.2 --memory 384m --memory-swap 384m`(禁 swap,防 OOM 时写盘)
- [ ] `--network` 独立 bridge,不共享 host
- [ ] 出口流量走 **透明代理**,白名单:
  - Anthropic API (`api.anthropic.com`)
  - 常用 mirror(用户白名单内)
  - 拒绝 RFC1918 私网、矿池、SMTP(25/465/587)、IRC(6667)
- [ ] 容器内进程以非 root user 运行(uid=1000)
- [ ] Volume 挂载只 `/workspace` 和 `/root` 可写
- [ ] 监控 syscall 异常(可选 v2,MVP 先打日志)

## 14. 超管权限

- [ ] 中间件 `requireAdmin` 校验 JWT role=admin,失败 403
- [ ] 所有写操作记 `admin_audit`(before/after jsonb)
- [ ] 超管账号**必须 2FA**(V2),MVP 先通过 `.env` 约束唯一 bootstrap admin email
- [ ] Bootstrap admin 不允许被降级或删除(DB trigger 或业务层守护)

## 15. 反滥用

- [ ] 注册邮箱验证是**强制**的(未验证用户不能聊天/充值)
- [ ] Turnstile 在注册/登录/密码重置 3 处强校验
- [ ] 同 IP 24h 最多 3 个注册(额外限流维度)
- [ ] 用户首次充值前限制试用积分上限(可配,默认不送试用)
- [ ] 连续请求异常模式(prompt 重复/最大 token 请求/高频)自动风控标记

## 16. 日志脱敏

- [ ] 日志中间件拦截所有日志条目,对已知敏感字段 mask:
  ```
  password, password_hash, token, access_token, refresh_token,
  oauth_token, oauth_refresh, authorization, cookie, set-cookie,
  turnstile_token, kms_key
  ```
- [ ] chat/agent **用户 prompt 内容默认不落日志**
  - 配置 `LOG_USER_PROMPT=0`(默认),打开后仅存 sha256 hash
  - 全文保留仅在 V2 加密存储 + 有限 TTL
- [ ] 错误堆栈不泄露文件路径到客户端

## 17. 数据备份 & 合规

- [ ] 每日 2:00 自动 `pg_dump` → 本地 + R2(异地)
- [ ] 备份文件 AES 加密,密钥离线保存
- [ ] 保留:最近 7 天每日 + 最近 4 周每周 + 最近 12 月每月
- [ ] 用户可导出自己全部数据(`GET /api/me/export`,V2 补)
- [ ] 用户注销后 30d 硬删除(含 ledger 脱敏为 `user_id=NULL` 但保留流水审计完整性)

## 18. 账号池运营风险隐蔽

boss 选了订阅池路线,以下做法降低被 Anthropic 发现/封号的概率:

- [ ] 账号按来源分组,每组绑定独立出口 IP(socks5 池)
- [ ] 每个账号的请求 User-Agent / TLS 指纹对齐官方 Claude Code
- [ ] 请求时序不机械(加 10-50ms 随机抖动)
- [ ] 不做对外 SEO / 应用商店上架
- [ ] 账号被限流/疑似标记时主动 cooldown + 告警
- [ ] 避免单账号高频使用,调度器均摊
- [ ] 不在账号关联的邮箱收发业务邮件(隔离身份)
- [ ] MVP 先手动维护账号池,监控几周再考虑自动化扩充

**⚠️ 这是合规灰区。一旦被批量封号,商业模式失效。boss 已接受此风险**。

## 19. 依赖安全

- [ ] 定期 `npm audit` + Dependabot
- [ ] 关键依赖钉死版本
- [ ] 不 `postinstall` 执行任意脚本
- [ ] 生产环境 `NODE_ENV=production`

## 20. 部署与运维安全

- [ ] 服务器 SSH 禁密码登录,仅 key 认证(当前依然密码,v2 切换 key)
- [ ] `fail2ban` 启用
- [ ] 防火墙只开 22(SSH)/80/443
- [ ] systemd unit 运行账户考虑降权(MVP 先 root,有 Docker socket 访问需求)
- [ ] `/etc/openclaude/commercial.env` 权限 `640 root:root`
- [ ] systemd `ProtectSystem=strict`, `PrivateTmp=true`, `ProtectHome=true`

## 21. 监控与告警

告警触发条件(至少通过邮件/企业微信/Telegram 任一通道发给 boss):
- Gateway 进程重启
- DB/Redis 连接异常持续 30s
- 账号池健康度 < 50 的账号数 >= 总数 50%
- 账号池全部不可用
- 支付回调对账差异
- 容器异常退出
- 磁盘使用 > 80%
- 5xx 响应率 > 1% (1min 窗口)

---

## 上线前安全审查清单

上线前必须逐项打勾:

- [ ] 所有章节的 `[ ]` 变成 `[x]`
- [ ] 至少一次人工 pentest(boss 或我手动尝试常见攻击:SQL 注入、XSS、CSRF、JWT 伪造、越权、支付绕过、容器逃逸)
- [ ] 至少一次依赖扫描
- [ ] 至少一次日志审计(看是否真的没泄露敏感字段)
- [ ] 数据备份恢复演练(真实从备份恢复一次)

Last updated: 2026-04-17
