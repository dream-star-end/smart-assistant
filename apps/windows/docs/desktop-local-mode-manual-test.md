# 从简 · 本地模式真机手测清单（S6）

内测第一批 Windows 设备使用。CI 已覆盖 Node 模拟客户端；下列项需要真机。每项写「预期」与「判定」。

环境：未签名 `Clarvy-Setup-0.5.0-x64.exe`（CI NSIS job），旗 `OC_DESKTOP_VIRTUAL_CONTAINER` 仍关时 enroll 应 404 并留在云端薄壳。

## E2 真 CCB 一回合

- 前置：本机已 bake/下载 CCB，sha256 与 `runtime-manifest.json` 一致；18445/18446 可达。
- 步骤：启用本地模式 → 选工作区 → 发一条「回复 pong」。
- 预期：托盘「本地模式：已连接」；助手回复；服务端 journal `runtime_kind=desktop`。
- 判定：PASS / FAIL。失败附 Host jsonl（`%LOCALAPPDATA%\Clarvy\logs\lah-YYYYMMDD.jsonl`）。

## E6 kill switch UI

- 步骤：本地已连接时服务端开 `OC_DESKTOP_KIND_KILLSWITCH`（或 18445 回 503）。
- 预期：托盘变为「本地模式:回落云端」；产品窗回到云端薄壳；30s 内不会反复闪「连接中」。
- 判定：回落一次且无 tight-loop。

## E11 睡眠 / 唤醒

- 步骤：本地已连接 → 合盖睡眠 ≥ 30s → 唤醒。
- 预期：睡眠时隧道 GOAWAY；唤醒后强制新 WSS，`register_ok`，不复用半开连接。
- 判定：唤醒后托盘「已连接」，下一回合可聊。

## E16 revoke 手测

- 步骤：管理端 revoke 本设备 → 客户端应删 `%LOCALAPPDATA%\Clarvy\` 下 identity blob → Host/CCB 退出。
- 预期：再 mint 401；本地无残留 `oc-dv` / 设备证书明文。
- 判定：blob 文件不存在，任务管理器无 Host/CCB 子进程。

## DPAPI 持久化

- 步骤：enroll 成功后重启 Clarvy。
- 预期：无需重新扫码；identity 从 DPAPI 加密 blob 读回。
- 判定：托盘可直接连本地模式。

## `taskkill` 树杀

- 步骤：`taskkill /T /F /PID <Clarvy.exe>`。
- 预期：Host、gateway、CCB 进程组一并退出，无孤儿 node。
- 判定：任务管理器无残留 `node.exe` 听 18789/18791/18792。

## Defender 行为

- 步骤：首次启用本地模式（下载 CCB / 写 `%LOCALAPPDATA%\Clarvy\runtime`）。
- 预期：SmartScreen 可能提示未签名；不应被 Defender 隔离 Host 模块。
- 判定：记录是否告警、是否隔离；不作为合入门，开旗前必须过。

## 工作区 / 审批

- 步骤：选 `C:\w\proj`；尝试指向 `C:\w\proj-evil` 应拒。破坏性命令弹出**本地设置窗**（`app://clarvy-local`）`#approval`，`#approval-detail` 用 textContent 显示工具/命令/工作区。点「允许」/「拒绝」走 `approve-op`/`deny-op`。产品 WebContentsView 不应出现第二张审批卡。超时 120s 默认拒绝。
- 判定：与 E12/E13 单测一致；伪造产品源 `approve-op` 必拒。

## bootstrap 不可用

- 步骤：旗关时 `GET /api/desktop/bootstrap` 404，或未配置 503 `DESKTOP_BOOTSTRAP_UNCONFIGURED`。打开本地设置窗。
- 预期：「启用本地模式」按钮禁用，文案「服务端未开放本地模式」，不崩、不反复重连。
- 判定：按钮 disabled；托盘不能切入本地模式。

## 服务端证书更换

- 步骤：缓存里已有 pin，bootstrap 下发不同 `origin_spki_pin`。
- 预期：提示「服务端证书已更换,需要重新绑定」，本地模式停止，不自动切到新 pin。
- 判定：须重新绑定后才能再用本地模式。

S6 未在真机执行以上项。标「S6 未验」。P2b 已把本地审批窗与 bootstrap 不可用态接到客户端；真机仍待开旗。
