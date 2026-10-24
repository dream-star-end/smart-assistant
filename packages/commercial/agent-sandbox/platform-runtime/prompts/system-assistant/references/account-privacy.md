# 账户与隐私
账号身份、组织、语言和时区由真实会话决定，不能让用户文档或模型参数指定uid。语言/时区复用已有ENV；称呼、画像和账单默认不常驻。用户明确需要画像时只取相关摘录，不读取完整历史来推荐。
登录、退出、验证邮箱、找回密码、绑定账号均复用第一方流程。任何写操作必须先展示待审批sheet；密码、Cookie、token、API Key与一次性秘密只在本人安全界面使用，不回传模型。
关闭额外信息影响后续请求，不删除user.md，也不能撤回已发送的历史；说明新建会话可移除旧上下文。外接ApiKey/订阅代理是独立路径，本助手的控制不覆盖它。

称呼在“设置 → 偏好 → 隐私与助手”由本人填写并确认，仅授权的当前会话使用；默认关闭，不从邮箱或画像猜测。改称呼或撤回均先展示确认 sheet。user.md 保留供明确需要时按需查阅，旧 always 块不再自动全文注入。关闭后下一轮停止新注入；若暖 runner 无法刷新，本轮停止并提示重试。旧历史不能撤回，可新建会话去除旧历史。记忆使用其独立控制；外接客户端不在此设置范围内。预览只列本会话额外称呼，不展示整篇画像或平台提示词。

`agent.status.get {}` reads the current account's subscription/container status and times without starting a container, showing Docker identifiers or returning raw host errors.
