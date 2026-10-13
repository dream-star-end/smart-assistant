# OCV5-402 · 哔哩哔哩账号插件（bili-account）：实现与扫码前停点

> 2026-10-13 · 外机 cc3 · 个人版（feat/v5-selfhost），叠在 #694（公开数据插件 `bili`）之上。只上 AI 市场、不预装，商业版不动。
> 用户 13:2x：「bili-account 先开分支做到扫码前停下」。

## 结论

代码、单测、接线都已完成；**发布这一步必须由用户本人扫一次码**，停在这里。原因：受管浏览器插件条目只有在
用真实登录态跑通实测（`functional_verify_state='verified'`）后才能上架和被用户安装（`biliAccountSetup.ts` 的 entitled-version
查询，与知乎、微博同一道门），而实测需要真实登录。不走 `functionalVerified` 绕过（那是削门）。

## 做了什么

| 部分 | 文件 | 要点 |
|---|---|---|
| 契约 | `plugins/biliAccountContract.ts` | `bili-account` 1.0.0，`managed-browser`；5 个**只读**动作：me / favorite_folders / favorite_items / history / subtitle；network 只有 GET；cookie 域 bilibili.com / www / passport；driver、launcher id 由 worker 源码 sha 推出 |
| worker | `plugins/biliAccountWorkerSource.ts` | 帧协议、broker relay、`filteredState`（只留 Secure cookie）照搬已审核的微博 worker；动作在 `https://www.bilibili.com/robots.txt` 页内用 `fetch(…, {credentials:'include'})` 读 api.bilibili.com（无 Node 端 cookie 回放）；登录截 passport 官方二维码，nav 证明登录后才返回状态；风控（-352/-412/-799、HTTP 412）立即停，不重试 |
| 运行时 | `plugins/biliAccount.ts` | 微博运行时去掉写派发围栏、媒体挂载、兼容 pin；worker 上限 2（登录 1）；只读帧之外的 prepared / not_dispatched 一律协议错误；driver 拒绝任何 beforeDispatch |
| 日志 | `plugins/biliAccountObservability.ts` | Docker 日志驱动 `none`；主机只记白名单步骤字段（无 cookie、URL、正文） |
| 扫码 | `plugins/biliAccountSetup.ts` | 与微博 / 知乎 setup 逐行同构（重命名移植）：条款、精确官方 pin + verified 条目、IPv4 pin、QR / 状态缓冲随时擦除、relink 走账号租约 |
| 接线 | http/plugins.ts、http/handlers.ts、index.ts、marketplaceDb.ts、pluginErrorGuidance.ts | setup 路由、保留 slug、官方徽标、`publishOfficialBiliAccountVersion`、错误码与指引 |
| 前端 | managedPluginProviders.ts、api.ts、RuntimePluginCard.tsx、DetailModal.tsx、connectors.ts | 扫码弹层注册项、四个 setup 接口、对话内授权、错误文案 |
| seed | `marketplace/seedBiliAccountPlugin.ts`、`scripts/seed-bili-account-plugin.ts` | `--advisory-status`（无登录）；`--verify-and-seed-user=ID --qr-out=/root/x.png`：起精确镜像登录 worker → 二维码 PNG 写到 root-only 文件 → **用户扫码** → 每个读动作用该会话真实跑一遍（ManagedBrowserRuntime 按 schema 校验）→ 全部通过才发布 1.0.0、审核上架、给该用户安装并绑定账号；登录状态只在进程内存，二维码文件退出即删 |
| 测试 | `plugins/biliAccount.test.ts`、`plugins/biliAccountSetup.test.ts` | 21 个：pin、只读、Secure cookie、每个动作 schema、worker 分支（从固定源码编译，用假页面跑）、风控 / 登出映射、帧协议、日志脱敏、seed CLI；setup 状态机 7 个用例移植自知乎 |

## 已验证（无需登录）

- 从 `www.bilibili.com/robots.txt` 页内带 credentials 读 `api.bilibili.com`：CORS 放行，未登录时 nav / history 返回 -101（g402 recon）。
- 登录页二维码是 140px 的 `data:image/png` 图片，页面轮询 `passport…/qrcode/poll`；需要的来源：passport、www、api、s1.hdslb.com、i0.hdslb.com（数据上报 data.bilibili.com 与第三方指纹 hdaa.shuzilm.cn 不放行）。

## 只有扫码后才能验证（风险，先说清楚）

1. **SESSDATA 是否带 Secure**：平台只保存 Secure cookie。登录前的 cookie 全部不带 Secure。如果登录后 SESSDATA 也不带，
   worker 会明确报 `LOGIN_STATE_UNSUPPORTED`（不会存一份用不了的登录状态），这条路就走不通，需要重新设计。
2. 字幕文件域（aisubtitle.hdslb.com）的跨域读取：未登录拿不到字幕地址，无法预先验证。
3. 二维码失效后的刷新（页面文案「二维码已失效」时整页刷新）。

## 扫码步骤（等用户确认后执行）

1. #694 合入并发布（公开数据插件 `bili` 上线）；本分支随后发布（代码进 live release）。
2. 在 v5-dev 以 live release + 服务 env 执行：
   `npx tsx packages/commercial/scripts/seed-bili-account-plugin.ts --verify-and-seed-user=3 --qr-out=/root/g402-bili-qr.png`
3. 二维码 PNG 写到 `/root/g402-bili-qr.png`（只有 root 可读），4 分钟内用哔哩哔哩 App 扫码并确认。
4. 脚本输出只有形状（条数、是否通过），不含 cookie；全部通过才会上架 1.0.0 并给 uid 3 绑定账号。
