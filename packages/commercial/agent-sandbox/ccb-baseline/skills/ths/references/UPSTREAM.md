# 上游与改动

- 上游：https://github.com/dream-star-end/ths-plugin ，提交 `7ac155a`（2026-10-12），MIT（`references/LICENSE.md`）。
- 逆向方法与接口说明：`references/ANALYSIS.md`（原样）。

## OpenClaude V5 接入时的改动（scripts/ths.py）

1. 新增 `--ui`（可放在任意位置）：把与 JSON 输出同源的数据转成 OpenClaude 智能 UI 的 ```ui 块
   （quote / kline / intraday / stocklist，以及 table / kv / sources / steps / callout）。只做格式转换，不增删数值；
   分时按 2 分钟取样（成交量为两分钟合计），在块的 note 里写明。
2. 板块注册表：随包的只读副本在 `references/sectors.json`；`ths sector list --refresh` 写到 `~/.cache/ths/sectors.json`，
   之后优先读用户目录。原版写在脚本旁边，而插件目录在容器里是只读挂载。

其余代码、接口、凭据处理（`~/.ths_auth.json` 0600、绝不输出 password）与上游一致。
上游的 `ths` shell 包装改由平台启动器提供（`plugin-exec`，会先检查插件是否已在「管理中心 → 插件」停用）。
