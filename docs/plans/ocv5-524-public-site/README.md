# jieyoutsg.com 公开页面只读调查

日期：2026-10-19。调查人：只读子代理 public_site。所有目标站请求均为 GET，未登录、未注册、未提交检索/下载、未刷新验证码；未读取或输出响应 Cookie 值；未使用 cc1、未访问 Aurora 生产。

## 请求记录（UTC）

| # | 出口 / 客户端 | UTC 发起时间 | URL | 结果 |
|---|---|---|---|---|
| W1 | web 工具 | 08:28:39 附近 | `http://www.jieyoutsg.com/` | 工具改为尝试 `https://www.jieyoutsg.com/`，Timeout fetching；工具内部网络请求次数未知 |
| 1 | 本机 / Python urllib | 08:28:53.173551 | `http://www.jieyoutsg.com/` | 20 秒超时 |
| 2 | 本机 / Python urllib | 08:29:13.185764 | `https://www.jieyoutsg.com/` | TLS `UNEXPECTED_EOF_WHILE_READING` |
| 3 | v5-dev / Python urllib | 08:29:32.805477 | `http://www.jieyoutsg.com/` | 200；最终 URL 不变；`text/html; charset=utf-8`；1045 bytes |
| 4 | v5-dev / Python urllib | 08:30:02.944660 | `http://www.jieyoutsg.com/e/member/login/` | 200；最终 URL 不变；`text/html; charset=utf-8`；7794 bytes |
| 5 | v5-dev / Python urllib | 08:30:06.705199 | `https://www.jieyoutsg.com/` | `[Errno 111] Connection refused` |
| 6 | v5-dev / Python urllib | 08:30:38.299629 | `http://www.jieyoutsg.com/e/member/login/520loginjs.php` | 200；257 字符；只生成登录/注册链接 |
| 7 | v5-dev / Python urllib | 08:30:41.633533 | `http://www.jieyoutsg.com/js/common.js?ver=1.1` | 200；11829 字符；公共 UI/浏览器判断/注册表单等逻辑 |
| 8 | v5-dev / Python urllib | 08:30:51.613177（响应时刻） | `http://www.jieyoutsg.com/e/ShowKey/?v=login` | 200；`image/jpeg`；1045 bytes；只取一张进行类型观察，未识别答案或提交 |

计数：8 次脚本化 GET（其中 6 次从 v5-dev），另 1 次 web 打开尝试；合计 9 次逻辑访问。无显式 HTTP 重定向被脚本跟随；web 内部请求数未知，不能宣称实际网络请求恰为 9。另做了 3 条搜索引擎查询（非目标站主动请求），只得到第三方 SEO 索引摘要，未作为登录/反爬结构的事实依据。

## 首页及登录页结构

首页是未登录提示，HTML 的 `setTimeout` 在 3 秒后把浏览器送到 `/e/member/login/`；另有同一路径的可点击链接。200 不是已经进入资源页的证据。

登录表单：`method="post" action="../doaction.php"`，相对当前页面归一化为 `http://www.jieyoutsg.com/e/member/doaction.php`。

| 控件用途 | name | type | 观察 |
|---|---|---|---|
| 用户名 | `username` | text | `id="password"`，不要据 id 定位 |
| 密码 | `password` | password | `id="username"`，与用户名 id 反置 |
| 验证码 | `key` | text | 普通文本输入 |
| 保存时间 | `lifetime` | radio | 显示不保存、一小时、一天、一个月、永久 |
| 隐藏字段 | `ecmsfrom`, `enews`, `tobind` | hidden | 本轮不记录其值 |
| 提交 | `Submit` | submit | 未触发 |

验证码标签：

```html
<img src="../../ShowKey/?v=login"
     onclick="this.src='../../ShowKey/?v=login&'+Math.random();">
```

由登录页路径归一化图片 URL 为 `http://www.jieyoutsg.com/e/ShowKey/?v=login`。一次公开 GET 的样本是 47×20 像素 JPEG（由 JPEG SOF 元数据确认）、灰底白色四位数字字符；本轮仅判别类型，没有求解或填写答案。证据文件 `captcha-sample.jpg`；SHA-256 和状态见 `captcha-metadata.json`。单个样本不能证明总是四位数字，也不能证明生产识别率。

登录页出现的脚本来源：`/js/jquery.easing.1.3.js`、`/js/jquery.cookie.js`、`/js/common.js?ver=1.1`、`/e/member/login/520loginjs.php`，以及 CNZZ 统计脚本。后两项本轮实际读取；没有执行任何脚本或请求统计服务。已检查页面 HTML 和上述两个脚本，未见第三方 CAPTCHA SDK、滑块或点选挑战。本次结论仅适用于这个公开登录页，不排除后续入口/风险升高时出现其他挑战。

页面上的外链客服、注册、充值、退出等均未访问。`common.js` 含旧通用 UI 和浏览器识别，不据此把它称为反爬系统；没有看到 WAF 挑战页，不代表网站或下游库没有反爬。

## 检索入口及第三方数据库：边界

当前未登录首页没有可见检索表单。登录页显示资源下载链接 `/e/action/ListInfo/?classid=61`（未访问），并列出公开帮助标题：PubMed、ACS、Wiley、Proquest 使用说明（未访问这些文章）。页脚自述以入口形式向会员提供国内外数据库内容下载。该文字是站方声明，不能代替实际入口测试。

未确认登录后的 CNKI/万方/维普/读秀入口、目标域名、是否反向代理/机构漫游、二次认证、检索参数、下载授权、验证码重现位置、IP 绑定、Cookie 属性、会话期限、并发限制、封号阈值、下游反爬或许可条款。登录成功/失败响应、验证码和会话绑定方式也未测试。

第三方 SEO 摘要列出 CNKI/万方/维普/读秀，但不作为本轮实时验证结论。它们只能作为下一阶段受权调查线索。

## 传输安全发现

本轮实际可读取的是 HTTP 首页和 HTTP 登录页，表单 POST 相对目标仍为 HTTP。HTTPS 从本机出现 TLS EOF、从 v5-dev 被拒绝连接；本轮未证实可用 HTTPS 登录入口。不能据两个出口下结论“所有用户均无法 HTTPS”，但也不能假定安全 TLS 链路存在。

因此，后续若由 Aurora 服务端提交用户名/密码或重放 bearer 会话到该 HTTP 目标，上游链路可能暴露凭据/会话；Aurora 自身 HTTPS、库内加密、让用户先手动登录再交 Cookie，都不能修补 worker→目标站的明文传输。应在实施/开放商业服务前验证站方支持的 HTTPS 或获准安全通道，并明确授权和风险处置，不能靠忽略 TLS 校验宣称解决。

## 可引用的第一方 URL

- [公开首页](http://www.jieyoutsg.com/)
- [会员登录页](http://www.jieyoutsg.com/e/member/login/)
- [登录状态脚本](http://www.jieyoutsg.com/e/member/login/520loginjs.php)
- [公共 UI 脚本](http://www.jieyoutsg.com/js/common.js?ver=1.1)
- [登录图片验证码路径](http://www.jieyoutsg.com/e/ShowKey/?v=login)（动态样本，不作为未来内容稳定性的保证）


归档说明：原始公开图片保留在本机 /workspace/lit-plugin-evidence-20261019/public-site/captcha-sample.jpg，不提交 Git；本归档保留类型观察、元数据及 hash，不含验证码答案。主代理另有一次 web 打开目标站失败，内部请求数未知；因此全任务为8次脚本GET及2次web逻辑打开。

## 16:46决定及开发阶段追加只读证据

用户16:46已明确接受本站精确HTTP例外；上方传输风险是原调研记录，不作为新的TLS开发阻断。凭据加密/不入日志、精确域白名单仍适用。

10:03–10:12 UTC追加4次逻辑公开登录页GET用于客户端预检和结构分析，未请求新验证码、未注册/POST/登录；原生客户端那次记录1个网络请求，其余urllib内部跳转次数未记录，不把逻辑次数说成实际网络次数。一次排队的诊断在请求前只终止了自身等待进程，未抢别人的发布/测试锁，未产生请求。原始HTML/值/Cookie没有入报告或Git。

[树结构元数据](table-form-metadata.json)：200/7794B、UTF8有效、form为table子节点且childCount0/start=end、无endTag，12个input和验证码图片都不在form后代；词法分析则均在其开始/结束标签之间。这是HTML旧布局/树修复造成的归属差异，原按后代取控件的fixture未覆盖。改用解析时form指针关联并补真实关闭边界回归，不据此判登录成功。元数据仅保留字段名/类型/值是否存在及长度等结构信息，没有字段值或Cookie内容。
