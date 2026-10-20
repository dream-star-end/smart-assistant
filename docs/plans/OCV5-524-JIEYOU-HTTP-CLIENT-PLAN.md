# OCV5-524 无账号第三批：真实站点预登录HTTP客户端

上批471e788b4独审全部APPROVED、43定向PASS，仍未接产品。用户已授权持续开发先做无账号部分；本批不等账号、不对真实站提交POST、不调用付费模型/修改生产。

实施范围：只在literatureDb内新增jieyouHttpClient.ts、测试以及显式runtime依赖parse5 8.0.1 / tough-cookie 6.0.1（lock已有相同版本dev传递依赖，仅声明商用包需要，不升级其它包）。不改现有managed-browser artifact/hash/全局HTTPS，也不开放市场。先方案APPROVED再源码。

- parse5解析登录HTML，1MiB输入上限；按name username/password/key筛选唯一POST表单，必须精确/e/member/doaction.php，无query/userinfo/外域。忽略base标签与脚本、不执行JS。保留公开表单hidden ecmsfrom/enews/tobind以及Submit实际值（每项2KiB/总8KiB、重复关键字段拒绝，未知hidden先拒绝，不猜EmpireCMS默认值）。验证码图片src必须归一化精确/e/ShowKey/且v=login；radio lifetime导出实际可选value/checked，提交时受信调用方从解析选项中明确选一个（无默认常量或猜默认值）。测试只用明确标为synthetic的hidden/radio/submit值。
- 每实例独立tough-cookie CookieJar，只在精确站点policy下收/发cookie，不跨用户、域/path/expiry/Secure按库处理；原始Set-Cookie数组不逗号拆分，最多64 cookies、32KiB序列化/16KiB出站header；rejectPublicSuffixes，HTTP不发送Secure cookie。新client没有外部cookie导入接口，private snapshot只给未来受信账户事务，不返回模型/UI。
- 客户端使用现有pinned LiteratureHttpTransport依赖，GET登录页/验证码同jar；GET逐跳最多3次且每跳由transport校验/重新pin，域/端口不扩展，重定向循环/超限/403/429停止。不会请求统计脚本/外链。验证码每次新random查询，无自动OCR调用。
- submit只接受本实例已经取到且未用过的challenge、版本化凭据、解析form中存在的lifetime值，构建URLSearchParams；答案仅captchaAnswer。每challenge只POST一次，派发前即消费，超时/断网/未知结果绝不重发；body buffer finally清零，凭据不保存在对象/argv/env/log。原始提交结果为private response，不在此层猜authenticated/credentials_invalid/captcha_invalid，不返回模型。307/308不重放POST；可返回受限redirect给后续account阶段判读，但本批不代替manager probe。close清jar/表单/challenge并abort本实例在途网络，关闭后新调用拒绝。每实例操作串行（busy拒绝并发），防cookie/挑战交叉。
- 这不是伪造完整LiteratureLoginSession。没有账号验证的身份标记、错误文案或snapshot账户保存，不实现总是假的authenticated。公开页本身有退出链接，不能以200/Cookie/退出链接判成功。真实站点classifier/自动登录manager接线必须账号阶段做；当前只能作为真实HTTP预登录和一次提交的私有基础层。
- 定向真实回环socket fixture：反置id仍按name、HTML实体/隐藏值/表单action、重复/未知字段、iframe/脚本不执行；cookie path/expiry/Secure/多SetCookie/独立实例；同jar挑战、一次性POST、特殊字符编码、307不重放、超时后挑战不可复用、取消/close、403429与外域重定向/循环/预算上限。所有网络fixture通过既有requestFactory注入loopback，不新增生产allowPrivate；测试前wait-for-trains+mutex，lint/typecheck/独审/CI。

私密response/snapshot只在受信控制面内使用；当前不加HTTP产品路由，不向模型暴露登录页面/headers/cookies，不声称安装可用或真实登录成功。后续合成fixture通过不代替账号实测/供应商许可。
