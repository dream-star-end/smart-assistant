# 惰性 state-only 画像读取器

`createContainerAuthorityStateReader(trustedUserId).capture()` 固定读取 `/run/oc/system-state`、owner UID 0。它不访问host private parent/staging/lock，不接受模型或环境路径，不创建/恢复/迁移数据。返回冻结的uid、generation、manifest SHA和已验证同一Buffer生成的profile text/version，没有可写AuthorityPaths。

底层 `readSealedAuthorityStateAt` 只供可信组合和临时FS测试，fixture显式使用自己的owner UID；生产facade不接受owner覆盖。owner/模式验证不等于真实内核RO挂载证据，本片没有接composition/挂载/native/cache、没有广播capability，也没有真实用户迁移。画像正文没有接入常驻USER。

只读当前selected sealed代：校验current原始SHA、精确seal与历史commit、归档manifest、目录精确清单、所有文件大小/hash/owner/nlink/O_NOFOLLOW及全部receipt；完成后再核current/seal未变。合法orphan和metadata临时文件留在state但绝不自动选取。缺user.md直接unavailable，不调用带ENOENT空回退/懒迁移的旧reader。复用纯codec，并收紧非scalar及尾换行hash/id的非canonical元数据；host private root/staging检查不放松。

本片新增12项证明接mandatory executor。真实临时state副本无需任何private parent/staging即可捕获；读前后文件hash、权限和目录不变；覆盖跨uid/owner、seal/current/history错配、缺正文、hash/额外文件、symlink/hardlink/他写权限、orphan不激活、archive/receipt和codec异常。与private ledger/worker/generation相关共56项和storage类型通过（主线集成前）；集成后的exact CI仍须通过。

后续全部读取与所有writer均须显式接入同轮uid+manifestSHA，关闭正式模式时不能误广播保护能力。常驻称呼的授权投影继续独立，不用此画像正文替代。
