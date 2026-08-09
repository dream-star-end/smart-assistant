# Aurora HarmonyOS

OpenClaude v5 商业版的 HarmonyOS NEXT 独立客户端，长期在
`feat/v5-harmony-app` 分支单独演进。产品采用 **native-first ArkUI + 受限 ArkWeb
compat**，不是把完整移动网页直接套进 WebView：

- ArkUI 负责应用导航栏、连接/离线状态、冷/热加载、应用控制面板、安全区、系统返回与 OAuth 域名确认。
- 对话页只保留 Web 的智能体/模型上下文条、消息时间线和 Composer，避免出现双顶栏或复制第二套聊天状态机。
- 文件选择/保存、麦克风授权、系统浏览器跳转和下载缓存清理使用 HarmonyOS 系统能力。
- 登录、会话恢复、WebSocket、计费和连接器仍以 v5 server 为唯一业务权威。

当前 `compat-v1` 只在精确 origin `https://claudeai.chat` 生效。每次主导航都携带
generation；注入脚本会再次校验 origin，并要求 ChatHeader、智能体按钮和模型按钮均唯一且
保持约定的直接父子结构。任一 selector 缺失、重复或层级漂移都会移除原生增强并完整回退 Web
流程，不会读取 Cookie、token、localStorage 或页面内容。等 Web 侧先提供经审查的版本化
handshake 后，再迁移到带 schema/nonce/allowlist 的 `WebMessagePort`。

## 安全边界

- 普通外链交给系统浏览器；具有 OAuth 参数形状的链接也不被直接信任，原生层会拦截并展示完整域名，只有用户明确确认后才在同一 ArkWeb 内完成授权，避免 HttpOnly state cookie 跨浏览器丢失。
- OAuth 期间显示不可被网页覆盖的当前 HTTPS 主机栏，明确提示核对域名并允许用户随时取消；回到 `claudeai.chat` 后自动退出授权模式。
- 其他 HTTPS 主导航交给系统浏览器；HTTP、脚本协议、带凭据 URL 和非默认端口会被拦截。
- 不注册 JavaScript bridge，不开放本地文件访问；禁用 ArkWeb 多窗口，并禁止无用户操作触发的 `window.open`，不会创建新的 WebView 页面。
- 仅 `claudeai.chat` 可申请音频采集，并且仍需通过 HarmonyOS 运行时麦克风授权。
- 文件上传使用系统文档选择器，只选择已有文件，不提供相机直拍入口。
- HTTPS 与 Blob 下载都由 ArkWeb 下载委托接管，先写入应用缓存，再复制到用户在系统文档选择器中确认的目标位置。
- 应用下次启动时会尽力清理专用下载缓存，避免崩溃或被系统终止后遗留文件。
- 支付页使用系统浏览器；返回应用后由现有 v5 页面继续轮询订单状态。
- 不注册应用数据备份能力，避免把 ArkWeb 登录态复制到其他设备或恢复点。

## 本地开发

环境要求：DevEco Studio 6.1.1、HarmonyOS SDK API 24、`devecocli`。

```bash
cd apps/harmony
devecocli build --modules entry@default --build-mode debug
devecocli emulator start "Pura 90"
devecocli run --module entry --device "Pura 90"
devecocli log --device "Pura 90"
```

项目 target API 为 24，compatible API 为 17。所有脚手架、构建、运行和调试操作统一使用 `devecocli`。

发布前还需分别构建 `entry@default` 的 debug/release 与 `entry@ohosTest`。未配置仓外签名时可生成
unsigned HAP 用于本地检查，但不能代替授权签名、真机验收与 AppGallery 发布。

## 发布前真机清单

- 密码登录、LinuxDo OAuth、GitHub OAuth 及回跳。
- 新建会话、流式回复、切后台后恢复、断网重连和系统返回键。
- 图片/文件选择、带签名 URL 的下载跳转。
- 麦克风首次授权、拒绝授权和再次发起语音输入。
- 支付跳转、返回应用和订单状态刷新。
- 手机、平板与 2in1 的竖屏/横屏、安全区和软键盘布局。
