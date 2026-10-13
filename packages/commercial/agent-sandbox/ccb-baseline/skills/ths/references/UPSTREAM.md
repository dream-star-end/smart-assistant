# 上游与改动

- 上游：https://github.com/dream-star-end/ths-plugin ，提交 `ca5b125`（v1.3.0，2026-10-12；首次接入时为 `7ac155a`），MIT（`references/LICENSE.md`）。
- 逆向方法与接口说明：`references/ANALYSIS.md`（原样）。

## OpenClaude V5 接入时的改动（scripts/ths.py）

1. 新增 `--ui`（可放在任意位置）：把与 JSON 输出同源的数据转成 OpenClaude 智能 UI 的 ```ui 块
   （quote / kline / intraday / stocklist，以及 table / kv / sources / steps / callout）。只做格式转换，不增删数值；
   分时按 2 分钟取样（成交量为两分钟合计），在块的 note 里写明。
2. 板块注册表：随包的只读副本在 `references/sectors.json`；`ths sector list --refresh` 写到 `~/.cache/ths/sectors.json`，
   之后优先读用户目录。原版写在脚本旁边，而插件目录在容器里是只读挂载。

3. `--ui` 与上游的全局选项一起在任意位置提取；加了 `--ui` 时 `--compact` / `--fields` 不起作用（ui 块总是完整数据）。
4. 1.3.0 新命令的 ui 映射：`indicators` → stats + 四张折线图（均线、布林带、MACD、RSI 与 KDJ；输出的每个数值都在；超过 60 根时只画最近 60 根并注明）；`events` → timeline；
   `doctor` → callout + table；`commands` → table；`kline` 的 `adjust=forward` 写进 K 线块的 note「前复权」。

未随包：上游的 `README.md`、`CHANGELOG.md`、`tests/test_indicators.py`、`tools/latency_check.py`、`ths` shell 包装。

其余代码、接口、凭据处理（`~/.ths_auth.json` 0600、绝不输出 password）与上游一致。
上游的 `ths` shell 包装改由平台启动器提供（`plugin-exec`，会先检查插件是否已在「管理中心 → 插件」停用）。
