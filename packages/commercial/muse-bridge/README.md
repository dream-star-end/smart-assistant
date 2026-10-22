# Muse bridge（Muse VM 内运行的中转程序）v0.3.2

只有一个文件：`muse_bridge.py`。只用 Python 3 标准库，不需要 pip 安装任何东西。
文件里**没有任何密钥**：token 在首次启动时提示输入（不回显），保存在 `~/.muse-bridge/token`（权限 0600）。
本版按 `/workspace/MUSE-MEDIA-CLI-v2.md`（已与 `--help` 逐项核对）修订。

## 一行启动（在 Muse VM 的 shell 里）

```bash
python3 muse_bridge.py start --server https://<个人版域名>
```

- 第一次运行会提示粘贴 bridge token，随后自检（`media-generation` 能否运行、能否连到 server、bridge 接口的 POST 请求能否真正到达个人版服务端），通过后在后台运行。
- 再次启动只需要 `python3 muse_bridge.py start`，server 地址和 token 都已保存在 `~/.muse-bridge/`。
- 个人版域名变了：用新的 `--server` 再执行一次 `start`。已在运行的 bridge 会在下次重连时读取新地址；或者先 `stop` 再 `start`。

## 其它命令

| 命令 | 作用 |
|---|---|
| `python3 muse_bridge.py status` | 是否在运行、server、最近日志 |
| `python3 muse_bridge.py stop` | 停止（按 pid 文件发送 SIGTERM，不用 pkill） |
| `python3 muse_bridge.py check --server https://<域名>` | 只做自检，不启动；可以用来确认 Muse VM 能否连到个人版 |
| `python3 muse_bridge.py try image "a red fox in snow"` | 不连接 server，在本机跑一次文生图 |
| `python3 muse_bridge.py try video "a red fox running"` | 本机文生视频 |
| `python3 muse_bridge.py try image "把狐狸改成蓝色" --image fox.webp` | 图片编辑（图 + 文 → 图），`--image` 可重复，最多 4 张 |
| `python3 muse_bridge.py try video "狐狸开始奔跑" --image fox.webp` | 图生视频 |
| `python3 muse_bridge.py try video "狐狸跃过倒木" --resume <snapshot_id>` | 续接上一次的生成。每次 `try` 都会在 stderr 打印新的 `snapshot_id`，可以一直接下去 |
| `python3 muse_bridge.py try video "同一只狐狸，换到森林" --resume <snapshot_id> --image forest.webp` | 续接加新源图（真机已确认可以出片）：画面延续上一段，**输出分辨率跟随新源图**。例如新图是 1152×768，视频就是 1152×768，而不是原片的 1280×720 |
| `python3 muse_bridge.py set-token` | 更换 token |
| `python3 muse_bridge.py run --server …` | 前台运行（适合放进 tmux：`tmux new -d -s muse-bridge 'python3 muse_bridge.py run'`，停止用 `tmux kill-session -t muse-bridge`） |

`try` 的其它选项：`--orientation square|vertical|landscape`、`--aspect-ratio 4:5|7:12|9:16`、`--format png|jpg|webp`（只限图片）、`--timeout 秒`。

## 当前状态（2026-10-22）

- 个人版端的接口（`/api/muse-bridge/v1/*`）随 OCV5-561 实现。上线后由管理员签发 token，用户在 Muse VM 里执行 `set-token` 和 `start`。
- 视频可以正常使用（02:34 实测：约 40 秒出一条 10 秒 mp4，约 10.7 MB）。生成超时默认 300 秒，上限 600 秒。只有 Muse 真正返回 `video_not_available` 时才报 `MUSE_VIDEO_REGION_BLOCKED`，不重试。

## 它怎么调用 media-generation

- **只有文字**：执行一次 `--media-subagent-output-type image|video --conversation-json '[{"text":…}]' --output-dir … --timeout-secs …`。
- **带源图**（图片编辑、图生视频）：分两步。`--image-file` 和 `--reference-image-*` 都是 legacy 参数，和 media_subagent 参数混用会报错，所以：
  1. `--upload-only --image-file <图1> [--image-file <图2>] --output-dir …`，从 stdout 拿到 `{"image_ids":[…]}`。真机已确认：同一张图每次上传都会拿到新 ID，不能缓存复用，所以 bridge 每个任务都重新上传；
  2. 把每个 ID 写成 `{"image": ID}` 项，放在 `--conversation-json` 里文字项的前面，再正常生成。
- **续接生成**：任务带 `resume_snapshot_id` 时追加 `--resume-from-snapshot-id`，结果里返回新的 `snapshot_id`。续接可以和源图一起用：上传新图拿 ID，再加 `--resume-from-snapshot-id`，真机已确认可以出片，输出分辨率跟随新源图，而不是沿用原片。
- `--image-output-format` 只在图片时传。视频没有时长、分辨率参数（单条固定约 10 秒；文生视频 1280×720，图生视频跟随源图），bridge 也不暴露这类参数。

## 它做什么、不做什么

- 只执行 `/opt/hatch/bin/media-generation`，命令参数只从任务里的白名单字段拼出来，不经过 shell。头像动画、图标池、`--caller`、`--task-type`、`--upload-handler` 等参数一律不用。
- 一次只跑一个任务；每个任务用独立的临时目录，结束后删除。
- 收到任务后先向个人版确认（ack），**拿到成功确认才开始生成**；确认失败（重试 3 次）或者任务已被收回时，直接放弃，不会生成第二份。
- 只上传本任务输出目录内的成品文件，并核对文件类型和大小：图片 ≤ 25 MiB；视频 ≤ 64 MiB，实测 10.7 MB，余量充足。源图每张 ≤ 10 MiB，只接受 png、jpg、webp。
- 日志 `~/.muse-bridge/bridge.log` 只记任务 id、类型、耗时、错误码和字节数，不记提示词、token、snapshot 或 Meta 的图片链接；超过 5 MB 轮转，保留 2 份。
- token 被拒绝，或者另一个 bridge 接管了连接时，会直接退出，不会无限重试。
- 只有个人版服务端自己写出的 JSON 错误（401 `UNAUTHORIZED`）才报「token 被个人版服务端拒绝」，退出码 2。个人版服务端的 bridge 接口从不返回 403。

## 出现 HTTP 401/403 时怎么判断

中间的代理或 Cloudflare 也可能返回 401/403，这时换 token 没有用。v0.3.2 起，这类 401/403 会单独报出来：

```
HTTP 403 不是个人版服务端返回的（Server: …，cf-ray: …，本机代理: host:port）。多半是 Muse VM 的出口代理或 Cloudflare 拦截了请求，换 token 没有用。响应摘要：…
```

bridge 随后以退出码 3 退出。要判断是哪一层拦的：

- 先运行 `python3 muse_bridge.py check`。其中「bridge 接口可用」一项会按真实请求的格式（POST、JSON 正文、Bearer 头）向 `/api/muse-bridge/probe` 发一次请求，只有收到服务端自己的 JSON 404 才算通过。服务端在检查 token 之前就会应答这个地址，所以这一项不发送真实 token、不会顶掉正在运行的 bridge，也不计入服务端按 IP 统计的登录失败次数。
- 「本机代理」显示的是 `HTTPS_PROXY`（或 `https_proxy`）里的主机和端口，账号和密码会去掉。响应摘要里疑似凭据的内容（token、认证头、Cookie、`user:pass@`、长串随机字符）和链接都会替换成 `<redacted>` 或 `<url>`。如果这里有代理，并且 `Server` 不是 `cloudflare`，基本可以确定是 Muse VM 的出口代理拦截了。
- `Server: cloudflare` 并且带 cf-ray 时，说明是 Cloudflare 边缘拦截。可以把 cf-ray 发给运维查。
- 遇到 Cloudflare 拦截时，改用个人版的直连入口：`--server https://<主机>:<OC_MUSE_PUBLIC_PORT>`。这个入口不经过 Cloudflare，只提供 `/api/muse-bridge/*`，token 不用换。服务端怎么开启，见设计文档「直连入口」一节。

协议与错误码详见设计文档 `DESIGN-20261022-muse-media.md` 的 §3、§9。
