# Aurora HarmonyOS

OpenClaude v5 商业版的 HarmonyOS NEXT 客户端。首版采用原生 ArkUI 外壳和受限 ArkWeb：直接加载 `https://claudeai.chat/`，复用服务器现有的登录、会话恢复、WebSocket、文件与支付状态，不在客户端复制第二套聊天状态机。

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
devecocli build
devecocli emulator start "Pura 90"
devecocli run --module entry
```

项目 target API 为 24，compatible API 为 17。所有脚手架、构建、运行和调试操作统一使用 `devecocli`。

## 发布前真机清单

- 密码登录、LinuxDo OAuth、GitHub OAuth 及回跳。
- 新建会话、流式回复、切后台后恢复、断网重连和系统返回键。
- 图片/文件选择、带签名 URL 的下载跳转。
- 麦克风首次授权、拒绝授权和再次发起语音输入。
- 支付跳转、返回应用和订单状态刷新。
- 手机、平板与 2in1 的竖屏/横屏、安全区和软键盘布局。
